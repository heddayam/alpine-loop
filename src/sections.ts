import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, readdir, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Readable, Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip, gunzipSync } from 'node:zlib';
import type { CatalogView, DataFile, DownloadSnapshot, PreparedSection, SectionCatalog } from './data-format.js';

const families = ['graph', 'starts', 'geometry'] as const;
type Family = typeof families[number];
const identifier = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const digest = /^[a-f0-9]{64}$/;
const catalogLimit = 16 * 1024 * 1024;
const compressedLimit = 128 * 1024 * 1024;
const jsonLimit = 512 * 1024 * 1024;
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const count = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0;
const strings = (value: unknown) => Array.isArray(value) && value.every(item => typeof item === 'string');
const bounds = (value: unknown) => Array.isArray(value) && value.length === 4 && value.every(Number.isFinite)
  && value[0] >= -180 && value[2] <= 180 && value[1] >= -90 && value[3] <= 90
  && value[0] < value[2] && value[1] < value[3];
const problem = (message: string, statusCode = 400) => Object.assign(new Error(message), { statusCode });

function validBoundary(value: unknown): boolean {
  if (!object(value) || value.type !== 'MultiPolygon' || !Array.isArray(value.coordinates) || !value.coordinates.length) return false;
  return value.coordinates.every(polygon => Array.isArray(polygon) && polygon.length && polygon.every(ring => {
    if (!Array.isArray(ring) || ring.length < 4) return false;
    if (!ring.every(point => Array.isArray(point) && point.length === 2 && point.every(Number.isFinite)
      && Math.abs(point[0]) <= 180 && Math.abs(point[1]) <= 90)) return false;
    return ring[0][0] === ring.at(-1)[0] && ring[0][1] === ring.at(-1)[1];
  }));
}

function catalogFrom(value: unknown): SectionCatalog {
  if (!object(value) || value.version !== 1 || !object(value.info) || !Array.isArray(value.sections)
    || (!value.sections.length && (!Array.isArray(value.unavailable) || !value.unavailable.length))) {
    throw new Error('Invalid mountain-section catalog');
  }
  const info = value.info;
  if (typeof info.id !== 'string' || !identifier.test(info.id) || typeof info.name !== 'string' || !info.name.trim()
    || !bounds(info.bounds) || typeof info.sourceDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(info.sourceDate)
    || !count(info.startCount) || !strings(info.limitations)
    || !Array.isArray(info.attribution) || !info.attribution.every(item => object(item)
      && typeof item.name === 'string' && typeof item.url === 'string' && typeof item.license === 'string')) {
    throw new Error('Invalid mountain-section catalog metadata');
  }
  if (value.baseUrl !== undefined) {
    if (typeof value.baseUrl !== 'string') throw new Error('Section downloads need an absolute HTTP(S) base URL');
    const url = new URL(value.baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error('Section downloads need an absolute HTTP(S) base URL');
    }
    if (!url.pathname.endsWith('/')) throw new Error('Section download base URL must end with a slash');
  }
  if (value.unavailable !== undefined && (!Array.isArray(value.unavailable) || !value.unavailable.every(item => object(item)
    && typeof item.name === 'string' && !!item.name.trim() && bounds(item.bounds) && validBoundary(item.boundary)
    && typeof item.reason === 'string' && !!item.reason.trim()))) throw new Error('Invalid unavailable mountain-section metadata');
  const ids = new Set<string>();
  for (const section of value.sections) {
    if (!object(section) || typeof section.id !== 'string' || !identifier.test(section.id) || ids.has(section.id)
      || typeof section.regionId !== 'string' || !identifier.test(section.regionId)
      || typeof section.name !== 'string' || !section.name.trim() || !bounds(section.bounds)
      || !validBoundary(section.boundary) || !count(section.sourceSegments) || !count(section.startCount)
      || !object(section.files) || Object.keys(section.files).length !== families.length) {
      throw new Error('Invalid or duplicate mountain section');
    }
    ids.add(section.id);
    for (const family of families) {
      const facts = section.files[family];
      if (!object(facts) || facts.path !== `sections/${section.id}/${family}.json.gz`
        || !Number.isSafeInteger(facts.bytes) || (facts.bytes as number) <= 0 || (facts.bytes as number) > compressedLimit
        || !Number.isSafeInteger(facts.jsonBytes) || (facts.jsonBytes as number) <= 0 || (facts.jsonBytes as number) > jsonLimit
        || typeof facts.sha256 !== 'string' || !digest.test(facts.sha256)) {
        throw new Error(`Invalid prepared section file: ${section.id}/${family}`);
      }
    }
  }
  return value as unknown as SectionCatalog;
}

async function fileStat(file: string) {
  return lstat(file).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
}

async function ensureDirectory(path: string) {
  await mkdir(path, { recursive: true });
  if (!(await fileStat(path))?.isDirectory()) throw new Error('Prepared-data directory is unsafe');
}

async function readVerified<T>(file: string, facts: DataFile): Promise<T> {
  const stat = await fileStat(file);
  if (!stat?.isFile() || stat.size !== facts.bytes) throw new Error(`Prepared section file is missing or has the wrong size: ${facts.path}`);
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of createReadStream(file)) {
    bytes += chunk.length;
    if (bytes > facts.bytes) throw new Error(`Prepared section file exceeds its declared size: ${facts.path}`);
    chunks.push(chunk);
  }
  if (bytes !== facts.bytes) throw new Error(`Prepared section file has the wrong size: ${facts.path}`);
  const compressed = Buffer.concat(chunks, bytes);
  if (hash(compressed) !== facts.sha256) throw new Error(`Prepared section file checksum mismatch: ${facts.path}`);
  const json = gunzipSync(compressed, { maxOutputLength: facts.jsonBytes + 1 });
  if (json.length !== facts.jsonBytes) throw new Error(`Prepared section file decoded size mismatch: ${facts.path}`);
  return JSON.parse(json.toString('utf8')) as T;
}

async function verify(file: string, facts: DataFile, signal?: AbortSignal) {
  const stat = await fileStat(file);
  if (!stat?.isFile() || stat.size !== facts.bytes) throw new Error(`Prepared section file is missing or has the wrong size: ${facts.path}`);
  const sha = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(file, { signal })) { bytes += chunk.length; sha.update(chunk); }
  if (bytes !== facts.bytes || sha.digest('hex') !== facts.sha256) throw new Error(`Prepared section file checksum mismatch: ${facts.path}`);
}

async function isVerified(file: string, facts: DataFile, signal?: AbortSignal) {
  try { await verify(file, facts, signal); return true; } catch { return false; }
}

async function verifyDecodedSize(file: string, facts: DataFile, signal: AbortSignal) {
  let bytes = 0;
  await pipeline(createReadStream(file), createGunzip(), new Writable({
    write(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      callback(bytes > facts.jsonBytes ? new Error(`Prepared section file decoded size mismatch: ${facts.path}`) : null);
    },
  }), { signal });
  if (bytes !== facts.jsonBytes) throw new Error(`Prepared section file decoded size mismatch: ${facts.path}`);
}

async function download(file: string, facts: DataFile, baseUrl: string, signal: AbortSignal, advance: (bytes: number) => void) {
  const temporary = `${file}.download-${randomUUID()}`;
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(120_000)]);
  try {
    const response = await fetch(new URL(facts.path, baseUrl), { signal: requestSignal });
    if (!response.ok || !response.body) throw new Error(`Section download failed: HTTP ${response.status} for ${facts.path}`);
    let bytes = 0;
    const sha = createHash('sha256');
    await pipeline(Readable.fromWeb(response.body as never), new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > facts.bytes) return callback(new Error(`Section download exceeds its declared size: ${facts.path}`));
        sha.update(chunk);
        advance(chunk.length);
        callback(null, chunk);
      },
    }), createWriteStream(temporary, { flags: 'wx' }), { signal: requestSignal });
    if (bytes !== facts.bytes || sha.digest('hex') !== facts.sha256) throw new Error(`Section download checksum or size mismatch: ${facts.path}`);
    await verifyDecodedSize(temporary, facts, requestSignal);
    signal.throwIfAborted();
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
}

/** Catalog visibility is independent of installed data; a complete section is the atomic download unit. */
export async function openSections(directory: string) {
  const root = resolve(directory);
  const catalogFile = join(root, 'catalog.json');
  const stat = await fileStat(catalogFile);
  if (!stat?.isFile() || stat.size > catalogLimit) throw new Error('Mountain-section catalog is missing or exceeds 16 MB');
  const catalog = catalogFrom(JSON.parse(await readFile(catalogFile, 'utf8')));
  const byId = new Map(catalog.sections.map(section => [section.id, section]));
  const verifiedSections = new Map<string, string>();
  let state: DownloadSnapshot | null = null;
  let controller: AbortController | null = null;
  let running: Promise<void> | null = null;
  const snapshot = () => state ? { ...state, sections: [...state.sections] } : null;
  const selected = (section: PreparedSection | string) => {
    const found = byId.get(typeof section === 'string' ? section : section.id);
    if (!found) throw problem('Unknown mountain section');
    return found;
  };
  const folder = (section: PreparedSection) => join(root, 'sections', section.id);

  async function installed(section: PreparedSection | string, signal?: AbortSignal): Promise<boolean> {
    const entry = selected(section), path = folder(entry), stat = await fileStat(path);
    if (!stat) return false;
    if (!stat.isDirectory()) throw new Error(`Prepared section is not a directory: ${entry.name}`);
    // An incomplete directory is never admitted as usable data.
    const files = await Promise.all(families.map(family => fileStat(join(root, entry.files[family].path))));
    if (files.some(file => !file)) return false;
    const fingerprint = files.map(file => `${file!.ino}:${file!.size}:${file!.mtimeMs}:${file!.ctimeMs}`).join('/');
    if (verifiedSections.get(entry.id) === fingerprint) return true;
    for (const family of families) await verify(join(root, entry.files[family].path), entry.files[family], signal);
    verifiedSections.set(entry.id, fingerprint);
    return true;
  }

  async function install(section: PreparedSection, signal: AbortSignal) {
    const target = folder(section), staging = join(root, '.downloads', section.id);
    await ensureDirectory(join(root, '.downloads'));
    await ensureDirectory(staging);
    for (const name of await readdir(staging)) if (name.includes('.download-')) await rm(join(staging, name), { force: true });
    const advance = (bytes: number) => { if (state) state.completedBytes += bytes; };
    for (const family of families) {
      signal.throwIfAborted();
      const facts = section.files[family], staged = join(staging, `${family}.json.gz`), final = join(root, facts.path);
      if (await isVerified(final, facts, signal)) {
        if (!await isVerified(staged, facts, signal)) await copyFile(final, staged);
        advance(facts.bytes);
      } else if (await isVerified(staged, facts, signal)) advance(facts.bytes);
      else {
        if (!catalog.baseUrl) throw new Error(`No download source is published for ${section.name}`);
        await download(staged, facts, catalog.baseUrl, signal, advance);
      }
    }
    signal.throwIfAborted();
    await ensureDirectory(dirname(target));
    // Installed valid sections never reach this path. Incomplete/corrupt data is replaced only after verification.
    const backup = `${staging}.previous-${randomUUID()}`;
    const previous = await fileStat(target);
    if (previous) await rename(target, backup);
    try { await rename(staging, target); }
    catch (error) { if (previous) await rename(backup, target); throw error; }
    await rm(backup, { recursive: true, force: true });
  }

  const downloads = {
    start(ids: string[]): DownloadSnapshot {
      if (state?.status === 'running') throw problem('A section download is already running', 409);
      if (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== 'string') || new Set(ids).size !== ids.length) {
        throw problem('Choose at least one distinct mountain section');
      }
      const entries = ids.map(selected);
      state = { status: 'running', sections: [...ids], completedBytes: 0,
        totalBytes: entries.reduce((sum, section) => sum + families.reduce((bytes, family) => bytes + section.files[family].bytes, 0), 0) };
      controller = new AbortController();
      const signal = controller.signal;
      running = (async () => {
        try {
          for (const section of entries) {
            signal.throwIfAborted();
            if (await installed(section, signal).catch(() => false)) {
              state!.completedBytes += families.reduce((sum, family) => sum + section.files[family].bytes, 0);
            } else await install(section, signal);
          }
          signal.throwIfAborted();
          state!.status = 'complete';
        } catch (error) {
          state!.status = signal.aborted ? 'stopped' : 'failed';
          if (!signal.aborted) state!.reason = errorMessage(error);
        }
      })();
      return snapshot()!;
    },
    latest: snapshot,
    async stop(): Promise<DownloadSnapshot | null> {
      if (state?.status === 'running') { controller?.abort(); await running; }
      return snapshot();
    },
    async close() { await downloads.stop(); },
  };
  return {
    catalog,
    installed,
    async read<T>(section: PreparedSection | string, family: Family): Promise<T> {
      if (!families.includes(family)) throw new Error('Unknown prepared section file family');
      const entry = selected(section);
      if (!await installed(entry)) throw new Error(`Mountain section is not installed: ${entry.name}`);
      return readVerified<T>(join(root, entry.files[family].path), entry.files[family]);
    },
    async view(): Promise<CatalogView> {
      const sections = [];
      for (const section of catalog.sections) {
        let usable = false, needsRepair = false;
        try { usable = await installed(section); } catch { needsRepair = true; }
        sections.push({ ...section, installed: usable, needsRepair,
          bytes: families.reduce((sum, family) => sum + section.files[family].bytes, 0) });
      }
      return { ...catalog.info, sections, ...(catalog.unavailable ? { unavailable: catalog.unavailable } : {}) };
    },
    downloads,
  };
}
