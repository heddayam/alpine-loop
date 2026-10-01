import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { installData } from '../../scripts/install-data.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const names = ['graph/0_0.json.gz', 'graph/0_1.json.gz', 'starts/0_0.json.gz', 'geometry/0_0.json.gz', 'geometry/0_1.json.gz'];
const raw = names.map((name, index) => Buffer.from(JSON.stringify({ name, index })));
const bodies = Object.fromEntries(names.map((name, index) => [name, gzipSync(raw[index])]));
const manifest = {
  version: 2, cellDegrees: 0.1, distanceMetric: 'haversine-6371008.8',
  info: { id: 'network-fixture', bounds: [0, 0, 1, 1] },
  files: Object.fromEntries(names.map((name, index) => [name, {
    bytes: bodies[name].length, jsonBytes: raw[index].length, sha256: hash(bodies[name]),
  }])),
};
const manifestBytes = Buffer.from(JSON.stringify(manifest));
const release = { id: manifest.info.id, manifestSha256: hash(manifestBytes), baseUrl: 'https://fixture.invalid/snapshot/' };
const corrupt = bytes => { const copy = Buffer.from(bytes); copy[0] ^= 1; return copy; };
async function directory(t) {
  const root = await mkdtemp(join(tmpdir(), 'alpine-installer-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('interrupted and corrupt downloads preserve verified files; only a fully verified snapshot activates', async t => {
  const root = await directory(t), target = join(root, release.id), staging = `${target}.partial`;
  let mode = 'interrupted', active = 0, peakActive = 0, finishFirstFour;
  const firstFour = new Promise(resolve => { finishFirstFour = resolve; });
  const calls = new Map(), progress = [];
  const fetch = async url => {
    const name = new URL(url).pathname.replace('/snapshot/', '');
    calls.set(name, (calls.get(name) ?? 0) + 1);
    if (name === 'manifest.json') return new Response(manifestBytes);
    assert.ok(bodies[name], `Unexpected file ${name}`);
    active++; peakActive = Math.max(peakActive, active);
    if (name === names[4] && mode === 'interrupted') await firstFour;
    let sent = false;
    return new Response(new ReadableStream({
      pull(controller) {
        if (name === names[4] && mode === 'interrupted') {
          if (!sent) { sent = true; controller.enqueue(bodies[name].subarray(0, 4)); }
          else { active--; controller.error(new Error('Connection interrupted')); }
        } else {
          controller.enqueue(name === names[4] && mode === 'corrupt' ? corrupt(bodies[name]) : bodies[name]);
          active--; controller.close();
        }
      },
      cancel() { active--; },
    }));
  };
  const options = { fetch, onProgress: value => {
    progress.push(value);
    if (value.completedFiles === 4) finishFirstFour();
  } };
  await assert.rejects(installData(root, release, options), /Connection interrupted/);
  await assert.rejects(stat(target), { code: 'ENOENT' });
  for (const name of names.slice(0, 4)) assert.deepEqual(await readFile(join(staging, name)), bodies[name]);
  assert.ok(!(await readdir(staging, { recursive: true })).some(name => name.includes('.download-')));

  await writeFile(join(staging, names[0]), corrupt(bodies[names[0]]));
  await writeFile(join(staging, `${names[4]}.download-abandoned`), 'partial');
  mode = 'corrupt';
  await assert.rejects(installData(root, release, options), /checksum or size mismatch/);
  await assert.rejects(stat(target), { code: 'ENOENT' });
  for (const name of names.slice(1, 4)) assert.equal(calls.get(name), 1, 'Verified files must not download again');

  mode = 'valid';
  assert.equal(await installData(root, release, options), target);
  await assert.rejects(stat(staging), { code: 'ENOENT' });
  for (const name of names) assert.deepEqual(await readFile(join(target, name)), bodies[name]);
  assert.ok(!(await readdir(target, { recursive: true })).some(name => name.includes('.download-')));
  assert.ok(peakActive <= 4);
  assert.equal(progress.at(-1).completedFiles, names.length);
  assert.equal(progress.at(-1).completedBytes, Object.values(bodies).reduce((sum, bytes) => sum + bytes.length, 0));
  const offline = { fetch: () => { throw new Error('Installed snapshots must verify offline'); } };
  assert.equal(await installData(root, release, offline), target);
  await writeFile(join(target, names[0]), corrupt(bodies[names[0]]));
  await assert.rejects(installData(root, release, offline), /Installed trail file is missing or corrupt/);
});

test('a mixed or unsafe manifest is rejected before any runtime file is fetched', async t => {
  for (const [changed, pinChanged] of [
    [{ ...manifest, info: { ...manifest.info, id: 'another-snapshot' } }, false],
    [{ ...manifest, info: { ...manifest.info, id: 'another-snapshot' } }, true],
    [{ ...manifest, files: { '../escape.json.gz': manifest.files[names[0]] } }, true],
  ]) {
    const root = await directory(t), body = Buffer.from(JSON.stringify(changed));
    let calls = 0;
    await assert.rejects(installData(root, { ...release, manifestSha256: pinChanged ? hash(body) : release.manifestSha256 }, {
      fetch: url => {
        assert.equal(new URL(url).pathname, '/snapshot/manifest.json');
        calls++;
        return new Response(body);
      },
    }), /checksum|wrong snapshot|Invalid prepared-data file/);
    assert.equal(calls, 1);
    await assert.rejects(stat(join(root, release.id)), { code: 'ENOENT' });
    await assert.rejects(stat(join(root, 'escape.json.gz')), { code: 'ENOENT' });
  }
});
