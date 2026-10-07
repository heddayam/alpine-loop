import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { lstat, mkdir, readFile, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const limit = 16 * 1024 * 1024;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

/** Fresh launch obtains only the pinned catalog; the app prompts for complete sections. */
export async function installCatalog(directory, release, options = {}) {
  if (!release || typeof release.catalogUrl !== 'string' || !/^[a-f0-9]{64}$/.test(release.catalogSha256)) {
    throw new Error('Invalid prepared mountain catalog release');
  }
  const url = new URL(release.catalogUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new Error('Prepared mountain catalog needs an HTTP(S) URL');
  }
  const root = resolve(directory), destination = join(root, 'catalog.json');
  await mkdir(root, { recursive: true });
  const existing = await lstat(destination).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (existing?.isFile() && existing.size <= limit && hash(await readFile(destination)) === release.catalogSha256) return root;
  const temporary = join(root, `.catalog-download-${randomUUID()}`);
  const signal = AbortSignal.any([options.signal ?? new AbortController().signal, AbortSignal.timeout(120_000)]);
  try {
    const response = await (options.fetch ?? fetch)(url, { signal });
    if (!response.ok || !response.body) throw new Error(`Mountain catalog download failed: HTTP ${response.status}`);
    let bytes = 0;
    const sha = createHash('sha256');
    await pipeline(Readable.fromWeb(response.body), new Transform({
      transform(chunk, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > limit) return callback(new Error('Mountain catalog exceeds 16 MB'));
        sha.update(chunk);
        callback(null, chunk);
      },
    }), createWriteStream(temporary, { flags: 'wx' }), { signal });
    if (sha.digest('hex') !== release.catalogSha256) throw new Error('Mountain catalog checksum mismatch');
    const catalog = JSON.parse(await readFile(temporary, 'utf8'));
    if (catalog.version !== 2 || !catalog.info || !Array.isArray(catalog.sections)
      || (!catalog.sections.length && (!Array.isArray(catalog.unavailable) || !catalog.unavailable.length))) {
      throw new Error('Invalid prepared mountain catalog format');
    }
    await rename(temporary, destination);
    return root;
  } finally { await rm(temporary, { force: true }); }
}
