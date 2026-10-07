import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { composeCatalog } from '../../scripts/compose-catalog.mjs';

const sha = data => createHash('sha256').update(data).digest('hex');
const attribution = { name: 'Shared source', url: 'https://fixture.invalid/source', license: 'Public domain' };
async function directory(t) {
  const root = await mkdtemp(join(tmpdir(), 'alpine-compose-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function fixture(root, id, date = '2026-08-01', west = -123) {
  const path = join(root, id), bounds = [west, 37, west + 1, 38];
  const boundary = { type: 'MultiPolygon', coordinates: [[[[west, 37], [west + 1, 37], [west + 1, 38], [west, 38], [west, 37]]]] };
  const section = { id, regionId: `region-${id}`, name: id, bounds, boundary, sourceSegments: 1, startCount: 1, files: {} };
  await mkdir(join(path, 'sections', id), { recursive: true });
  for (const family of ['graph', 'starts', 'geometry']) {
    const decoded = Buffer.from(`${JSON.stringify(family === 'graph' ? { graph: { info: { id }, starts: [{ id: 'start' }] } } : [[west, 37, 100]])}\n`);
    const bytes = gzipSync(decoded);
    const relative = `sections/${id}/${family}.${family === 'geometry' ? 'jsonl' : 'json'}.gz`;
    await writeFile(join(path, relative), bytes);
    section.files[family] = { path: relative, bytes: bytes.length, jsonBytes: decoded.length, sha256: sha(bytes) };
  }
  const catalog = { version: 2, baseUrl: 'https://fixture.invalid/sections/',
    info: { id: `catalog-${id}`, name: id, bounds, sourceDate: date, startCount: 1,
      attribution: [attribution], limitations: ['Shared limitation', `${id} limitation`] },
    sections: [section], unavailable: [] };
  await writeFile(join(path, 'catalog.json'), JSON.stringify(catalog));
  await writeFile(join(path, 'provenance.json'), JSON.stringify({ manifest: { regionId: section.regionId, sourceDate: date } }));
  await mkdir(join(path, 'audit', id), { recursive: true });
  await writeFile(join(path, 'audit', id, 'source-index.json.gz'), gzipSync('{"original":true}\n'));
  return { path, catalog, section };
}
async function save(fixture) { await writeFile(join(fixture.path, 'catalog.json'), JSON.stringify(fixture.catalog)); }
async function absent(path) { await assert.rejects(lstat(path), { code: 'ENOENT' }); }

test('composition preserves section identity and bytes, aggregates metadata and retains original evidence', async t => {
  const root = await directory(t);
  const first = await fixture(root, 'first'), second = await fixture(root, 'second', '2026-09-15', -121);
  second.catalog.unavailable.push({ name: 'Pending area', bounds: second.section.bounds, boundary: second.section.boundary, reason: 'No approved divider' });
  await save(second);
  const originals = await Promise.all([first, second].map(input => readFile(join(input.path, 'catalog.json'))));
  const output = join(root, 'combined');
  const result = await composeCatalog([first.path, second.path], output, { name: 'Combined regions' });
  const body = await readFile(join(output, 'catalog.json')), catalog = JSON.parse(body);
  assert.deepEqual(catalog.sections, [first.section, second.section]);
  assert.equal(catalog.baseUrl, undefined);
  assert.deepEqual(catalog.info.bounds, [-123, 37, -120, 38]);
  assert.equal(catalog.info.startCount, 2);
  assert.equal(catalog.info.sourceDate, '2026-08-01');
  assert.deepEqual(result.sourceDates, ['2026-08-01', '2026-09-15']);
  assert.deepEqual(catalog.info.attribution, [attribution]);
  assert.equal(catalog.info.limitations.filter(value => value === 'Shared limitation').length, 1);
  assert.match(catalog.info.limitations.at(-1), /oldest date/);
  assert.deepEqual(catalog.unavailable, second.catalog.unavailable);
  assert.equal(result.catalogSha256, sha(body));
  const evidence = JSON.parse(await readFile(join(output, 'provenance.json')));
  assert.equal(evidence.verification.sectionFiles, 6);
  assert.equal(evidence.verification.compressedBytes, result.compressedBytes);
  assert.equal(evidence.verification.decodedBytes, result.decodedBytes);
  for (const [index, input] of [first, second].entries()) {
    const source = evidence.sources[index];
    assert.equal(source.sourceDate, input.catalog.info.sourceDate);
    assert.deepEqual(source.sectionIds, [input.section.id]);
    assert.deepEqual(source.regionIds, [input.section.regionId]);
    assert.deepEqual(await readFile(join(input.path, 'catalog.json')), originals[index]);
    assert.deepEqual(await readFile(join(output, `sources/${source.catalogSha256}/catalog.json`)), originals[index]);
    assert.deepEqual(await readFile(join(output, `sources/${source.catalogSha256}/provenance.json`)), await readFile(join(input.path, 'provenance.json')));
    for (const facts of Object.values(input.section.files)) assert.deepEqual(await readFile(join(output, facts.path)), await readFile(join(input.path, facts.path)));
    assert.deepEqual(await readFile(join(output, 'audit', input.section.id, 'source-index.json.gz')),
      await readFile(join(input.path, 'audit', input.section.id, 'source-index.json.gz')));
    for (const file of source.files) {
      const data = await readFile(join(output, file.path));
      assert.equal(data.length, file.bytes); assert.equal(sha(data), file.sha256);
    }
  }
});

test('duplicate IDs, malformed paths and inconsistent metadata fail before any output is created', async t => {
  const root = await directory(t), first = await fixture(root, 'first');
  const output = join(root, 'combined');
  await assert.rejects(composeCatalog([first.path, first.path], output), /Duplicate or conflicting/);
  await absent(output);
  const originalPath = first.section.files.graph.path;
  first.section.files.graph.path = '../outside.gz'; await save(first);
  await assert.rejects(composeCatalog([first.path], output), /file path/); await absent(output);
  first.section.files.graph.path = originalPath;
  first.catalog.info.startCount = 2; await save(first);
  await assert.rejects(composeCatalog([first.path], output), /start count/); await absent(output);
  first.catalog.info.startCount = 1; first.catalog.info.sourceDate = '2026-02-30'; await save(first);
  await assert.rejects(composeCatalog([first.path], output), /metadata/); await absent(output);
});

test('compressed size, checksum and decoded size mismatches remove the unsuccessful output', async t => {
  const root = await directory(t), first = await fixture(root, 'first');
  const facts = first.section.files.graph, output = join(root, 'combined');
  const original = { ...facts };
  for (const [key, value, error] of [['bytes', original.bytes + 1, /Compressed size/],
    ['sha256', '0'.repeat(64), /Checksum/], ['jsonBytes', original.jsonBytes + 1, /Decoded size/],
    ['jsonBytes', original.jsonBytes - 1, /Decoded size/]]) {
    Object.assign(facts, original, { [key]: value }); await save(first);
    await assert.rejects(composeCatalog([first.path], output), error); await absent(output);
  }
  Object.assign(facts, original);
  const corrupt = Buffer.alloc(original.bytes, 1);
  await writeFile(join(first.path, facts.path), corrupt); facts.sha256 = sha(corrupt); await save(first);
  await assert.rejects(composeCatalog([first.path], output)); await absent(output);
});

test('existing output, input nesting and symlinked artifacts cannot be overwritten or followed', async t => {
  const root = await directory(t), first = await fixture(root, 'first'), output = join(root, 'combined');
  await mkdir(output); await writeFile(join(output, 'keep'), 'existing');
  await assert.rejects(composeCatalog([first.path], output), { code: 'EEXIST' });
  assert.deepEqual(await readdir(output), ['keep']);
  await assert.rejects(composeCatalog([first.path], join(first.path, 'child')), /outside every input/);
  await absent(join(first.path, 'child'));
  await rm(output, { recursive: true });
  const sections = join(first.path, 'sections');
  await rm(sections, { recursive: true }); await symlink(root, sections);
  await assert.rejects(composeCatalog([first.path], output), /symbolic link/); await absent(output);
  await rm(sections);
  const second = await fixture(root, 'second');
  await rm(join(second.path, 'audit'), { recursive: true }); await symlink(root, join(second.path, 'audit'));
  await assert.rejects(composeCatalog([second.path], output), /Unsafe audit/); await absent(output);
});

test('composed catalog provenance remains portable when composing it again', async t => {
  const root = await directory(t), first = await fixture(root, 'first');
  const combined = join(root, 'combined'), output = join(root, 'again');
  const result = await composeCatalog([first.path], combined);
  await composeCatalog([combined], output);
  const source = JSON.parse(await readFile(join(output, 'provenance.json'))).sources[0];
  assert.deepEqual(await readFile(join(output, `sources/${source.catalogSha256}/catalog.json`)), await readFile(join(combined, 'catalog.json')));
  const original = `sources/${source.catalogSha256}/sources/${sha(await readFile(join(first.path, 'catalog.json')))}/provenance.json`;
  assert.deepEqual(await readFile(join(output, original)), await readFile(join(first.path, 'provenance.json')));
  assert.equal(source.catalogId, result.id);
});
