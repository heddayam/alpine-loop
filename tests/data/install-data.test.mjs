import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { installCatalog } from '../../scripts/install-data.mjs';

const body = Buffer.from(JSON.stringify({ version: 2, info: { id: 'mountains' }, sections: [{ id: 'test' }] }));
const release = { catalogUrl: 'https://fixture.invalid/catalog.json', catalogSha256: createHash('sha256').update(body).digest('hex') };
async function directory(t) {
  const root = await mkdtemp(join(tmpdir(), 'alpine-catalog-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('launch obtains the pinned catalog without any section download and reuses it offline', async t => {
  const root = await directory(t), calls = [];
  assert.equal(await installCatalog(root, release, { fetch: url => {
    calls.push(String(url));
    return new Response(body);
  } }), root);
  assert.deepEqual(calls, [release.catalogUrl]);
  assert.deepEqual(await readFile(join(root, 'catalog.json')), body);
  assert.equal(await installCatalog(root, release, { fetch: () => { throw new Error('Must reuse offline'); } }), root);
});

test('bad catalog data never replaces an existing catalog or leaves a partial download', async t => {
  const root = await directory(t), destination = join(root, 'catalog.json');
  await writeFile(destination, 'existing development catalog');
  await assert.rejects(installCatalog(root, release, { fetch: () => new Response('corrupt') }), /checksum mismatch/);
  assert.equal(await readFile(destination, 'utf8'), 'existing development catalog');
  assert.deepEqual(await readdir(root), ['catalog.json']);
  const wrong = Buffer.from('{"version":2}');
  await assert.rejects(installCatalog(root, { ...release, catalogSha256: createHash('sha256').update(wrong).digest('hex') }, {
    fetch: () => new Response(wrong),
  }), /Invalid prepared mountain catalog format/);
});

test('launch rejects non-HTTP release URLs and unbounded catalog responses', async t => {
  const root = await directory(t);
  await assert.rejects(installCatalog(root, { ...release, catalogUrl: 'file:///tmp/catalog.json' }), /HTTP/);
  const oversized = new Uint8Array(16 * 1024 * 1024 + 1);
  await assert.rejects(installCatalog(root, release, { fetch: () => new Response(oversized) }), /exceeds 16 MB/);
  assert.deepEqual(await readdir(root), []);
});
