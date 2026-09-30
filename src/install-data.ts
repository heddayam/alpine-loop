import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, open, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

const names = ['graph.json.gz', 'geometry.json.gz'] as const;
export type DataRelease = {
  id: string;
  files: Record<typeof names[number], { url: string; bytes: number; sha256: string }>;
};

async function matches(file: string, expected: DataRelease['files'][typeof names[number]]) {
  try {
    if ((await stat(file)).size !== expected.bytes) return false;
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    return hash.digest('hex') === expected.sha256;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** Return only verified prepared data. The app never processes source trails. */
export async function installData(
  release: DataRelease,
  cache: string,
  download: typeof fetch = fetch,
  report: (message: string) => void = console.log,
) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(release.id)
    || names.some(name => !Number.isSafeInteger(release.files[name]?.bytes)
      || release.files[name].bytes <= 0 || !/^[a-f0-9]{64}$/.test(release.files[name].sha256)
      || new URL(release.files[name].url).protocol !== 'https:')) {
    throw new Error('Invalid prepared trail release');
  }
  const directory = join(cache, release.id);
  const ready = async () => (await Promise.all(names.map(name => matches(join(directory, name), release.files[name])))).every(Boolean);
  if (await ready()) return directory;
  await mkdir(cache, { recursive: true });
  const temporary = await mkdtemp(join(cache, '.download-'));
  try {
    report('Downloading prepared trails for first use…');
    for (const name of names) {
      const expected = release.files[name];
      const response = await download(expected.url, { signal: AbortSignal.timeout(120_000) });
      if (!response.ok || !response.body) throw new Error(`Trail download failed (HTTP ${response.status}). Run the launch command again to retry.`);
      const file = await open(join(temporary, name), 'wx');
      const reader = response.body.getReader();
      const hash = createHash('sha256');
      let bytes = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > expected.bytes) throw new Error('Trail download exceeded its expected size.');
          hash.update(chunk.value);
          await file.writeFile(chunk.value);
        }
      } finally {
        try { await reader.cancel(); } finally { await file.close(); }
      }
      if (bytes !== expected.bytes || hash.digest('hex') !== expected.sha256) {
        throw new Error('Trail download was incomplete or damaged. Run the launch command again to retry.');
      }
    }
    // Each replacement is atomic and contains the same pinned bytes. Concurrent
    // launches cannot remove one another's valid files or expose a partial file.
    await mkdir(directory, { recursive: true });
    for (const name of names) await rename(join(temporary, name), join(directory, name));
    report('Prepared trails are ready. Future launches can use them offline.');
    return directory;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
