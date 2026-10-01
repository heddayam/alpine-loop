import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const hashPattern = /^[a-f0-9]{64}$/;
const manifestLimit = 16 * 1024 * 1024;
const fileStat = file => stat(file).catch(error => {
  if (error.code === 'ENOENT') return null;
  throw error;
});

async function verified(file, expected) {
  const facts = await fileStat(file);
  if (!facts?.isFile() || facts.size > (expected.bytes ?? manifestLimit)
    || (expected.bytes !== undefined && facts.size !== expected.bytes)) return false;
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex') === expected.sha256;
}

async function download(file, url, expected, fetcher, signal) {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.download-${randomUUID()}`;
  const hash = createHash('sha256');
  let bytes = 0;
  try {
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(120_000)]);
    const response = await fetcher(url, { signal: requestSignal });
    if (!response.ok || !response.body) throw new Error(`Trail download failed: HTTP ${response.status} for ${url}`);
    await pipeline(Readable.fromWeb(response.body), new Transform({
      transform(chunk, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > (expected.bytes ?? manifestLimit)) return callback(new Error(`Trail file exceeds its declared size: ${url}`));
        hash.update(chunk);
        callback(null, chunk);
      },
    }), createWriteStream(temporary, { flags: 'wx' }), { signal: requestSignal });
    if ((expected.bytes !== undefined && bytes !== expected.bytes) || hash.digest('hex') !== expected.sha256) {
      throw new Error(`Trail file checksum or size mismatch: ${url}`);
    }
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** Install one pinned snapshot. Progress counts verified runtime files, including reuse. */
export async function installData(rootDirectory, release, options = {}) {
  if (!release || typeof release.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(release.id)
    || !hashPattern.test(release.manifestSha256)) throw new Error('Invalid prepared-data release');
  const base = new URL(release.baseUrl);
  if (!['https:', 'http:'].includes(base.protocol)) throw new Error('Prepared data needs an HTTP(S) URL');
  if (!base.pathname.endsWith('/')) base.pathname += '/';
  const target = resolve(rootDirectory, release.id), staging = `${target}.partial`;
  const installed = await fileStat(target);
  if (installed && !installed.isDirectory()) throw new Error(`Installed snapshot is not a directory: ${target}`);
  const directory = installed ? target : staging;
  const manifestFile = join(directory, 'manifest.json');
  const manifestFacts = { sha256: release.manifestSha256 };
  const fetcher = options.fetch ?? globalThis.fetch;
  const controller = new AbortController();
  if (!await fileStat(manifestFile) && !installed) {
    await download(manifestFile, new URL('manifest.json', base), manifestFacts, fetcher, controller.signal);
  }
  if (!await verified(manifestFile, manifestFacts)) throw new Error('Prepared-data manifest is missing or does not match the pinned release');
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
  if (manifest.version !== 2 || manifest.cellDegrees !== 0.1 || manifest.distanceMetric !== 'haversine-6371008.8'
    || manifest.info?.id !== release.id || !manifest.files || typeof manifest.files !== 'object' || Array.isArray(manifest.files)) {
    throw new Error('Prepared-data manifest has the wrong snapshot or format');
  }
  const entries = Object.entries(manifest.files);
  for (const [file, facts] of entries) {
    if (!/^(graph|starts|geometry)\/-?\d+_-?\d+\.json\.gz$/.test(file)
      || !facts || !Number.isSafeInteger(facts.bytes) || facts.bytes <= 0
      || !Number.isSafeInteger(facts.jsonBytes) || facts.jsonBytes <= 0 || !hashPattern.test(facts.sha256)) {
      throw new Error(`Invalid prepared-data file: ${file}`);
    }
  }
  // A killed download may leave a temporary file, never a verified runtime filename.
  if (!installed) for (const family of ['', 'graph', 'starts', 'geometry']) {
    const folder = join(staging, family);
    for (const name of await readdir(folder).catch(error => {
      if (error.code === 'ENOENT') return [];
      throw error;
    })) if (name.includes('.download-')) await rm(join(folder, name), { force: true });
  }
  let next = 0, completedFiles = 0, completedBytes = 0;
  const totalBytes = entries.reduce((sum, [, facts]) => sum + facts.bytes, 0);
  const progress = () => options.onProgress?.({ completedFiles, totalFiles: entries.length, completedBytes, totalBytes });
  progress();
  await Promise.allSettled(Array.from({ length: Math.min(4, entries.length) }, async () => {
    while (!controller.signal.aborted) {
      const entry = entries[next++];
      if (!entry) return;
      const [file, facts] = entry;
      try {
        const destination = join(directory, file);
        if (!await verified(destination, facts)) {
          if (installed) throw new Error(`Installed trail file is missing or corrupt: ${file}`);
          await download(destination, new URL(file, base), facts, fetcher, controller.signal);
        }
        completedFiles++;
        completedBytes += facts.bytes;
        progress();
      } catch (error) {
        controller.abort(error);
        throw error;
      }
    }
  }));
  if (controller.signal.aborted) throw controller.signal.reason;
  if (!installed) await rename(staging, target);
  return target;
}
