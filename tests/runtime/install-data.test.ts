import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { installData, type DataRelease } from '../../src/install-data.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const bytes = Buffer.from('committed offline fixture bytes');
const expected = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
const release: DataRelease = { id: 'offline-test', files: {
  'graph.json.gz': { ...expected, url: 'https://example.invalid/graph.json.gz' },
  'geometry.json.gz': { ...expected, url: 'https://example.invalid/geometry.json.gz' },
} };
async function cache() {
  const directory = await mkdtemp(join(tmpdir(), 'alpine-install-'));
  roots.push(directory);
  return directory;
}
const quiet = () => {};

it('installs verified files, reuses them offline, and repairs damaged cached data', async () => {
  const root = await cache();
  let calls = 0;
  const download = async () => { calls++; return new Response(bytes); };
  const directory = await installData(release, root, download, quiet);
  expect(calls).toBe(2);
  expect(await readFile(join(directory, 'graph.json.gz'))).toEqual(bytes);
  await installData(release, root, async () => { throw new Error('Must work offline'); }, quiet);
  await writeFile(join(directory, 'geometry.json.gz'), 'damaged');
  expect(await installData(release, root, download, quiet)).toBe(directory);
  expect(calls).toBe(4);
  expect(await readdir(root)).toEqual([release.id]);
});

it('never exposes an incomplete release and a retry starts cleanly', async () => {
  const root = await cache();
  let calls = 0;
  await expect(installData(release, root, async () => {
    calls++;
    return new Response(calls === 1 ? bytes : Buffer.from('truncated'));
  }, quiet)).rejects.toThrow('incomplete or damaged');
  expect(await readdir(root)).toEqual([]);
  await installData(release, root, async () => new Response(bytes), quiet);
  expect(await readFile(join(root, release.id, 'geometry.json.gz'))).toEqual(bytes);
});
