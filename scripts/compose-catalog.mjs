import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import { createGunzip } from 'node:zlib';

const families = ['graph', 'starts', 'geometry'];
const identifier = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const digest = /^[a-f0-9]{64}$/;
const catalogLimit = 16 * 1024 * 1024;
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const count = value => Number.isSafeInteger(value) && value >= 0;
const text = value => typeof value === 'string' && !!value.trim();
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const encoded = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const unique = (values, key = value => value) => [...new Map(values.map(value => [key(value), value])).values()];
const validBounds = value => Array.isArray(value) && value.length === 4 && value.every(Number.isFinite)
  && value[0] >= -180 && value[2] <= 180 && value[1] >= -90 && value[3] <= 90
  && value[0] < value[2] && value[1] < value[3];
const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const contained = (root, path) => { const part = relative(root, path); return !part || (!part.startsWith(`..${sep}`) && part !== '..'); };

function validBoundary(value) {
  return object(value) && value.type === 'MultiPolygon' && Array.isArray(value.coordinates) && value.coordinates.length
    && value.coordinates.every(polygon => Array.isArray(polygon) && polygon.length && polygon.every(ring =>
      Array.isArray(ring) && ring.length >= 4 && ring.every(point => Array.isArray(point) && point.length === 2
        && point.every(Number.isFinite) && Math.abs(point[0]) <= 180 && Math.abs(point[1]) <= 90)
      && ring[0][0] === ring.at(-1)[0] && ring[0][1] === ring.at(-1)[1]));
}

function validate(catalog) {
  const info = catalog?.info;
  if (catalog?.version !== 2 || !object(info) || typeof info.id !== 'string' || !identifier.test(info.id) || !text(info.name)
    || !validBounds(info.bounds) || !validDate(info.sourceDate) || !count(info.startCount)
    || !Array.isArray(info.limitations) || !info.limitations.every(item => typeof item === 'string')
    || !Array.isArray(info.attribution) || !info.attribution.every(item => object(item)
      && ['name', 'url', 'license'].every(key => typeof item[key] === 'string'))
    || !Array.isArray(catalog.sections) || !Array.isArray(catalog.unavailable ?? [])) {
    throw new Error('Invalid mountain-section catalog metadata');
  }
  for (const area of [...catalog.sections, ...(catalog.unavailable ?? [])]) {
    if (!object(area) || !text(area.name) || !validBounds(area.bounds) || !validBoundary(area.boundary)
      || area.bounds[0] < info.bounds[0] || area.bounds[1] < info.bounds[1]
      || area.bounds[2] > info.bounds[2] || area.bounds[3] > info.bounds[3]) {
      throw new Error('Invalid mountain-section boundary or bounds');
    }
  }
  for (const section of catalog.sections) {
    if (typeof section.id !== 'string' || !identifier.test(section.id)
      || typeof section.regionId !== 'string' || !identifier.test(section.regionId)
      || !count(section.sourceSegments) || !count(section.startCount) || !object(section.files)
      || Object.keys(section.files).length !== families.length) throw new Error('Invalid mountain section');
    for (const family of families) {
      const facts = section.files[family];
      if (!object(facts) || facts.path !== `sections/${section.id}/${family}.${family === 'geometry' ? 'jsonl' : 'json'}.gz`
        || !count(facts.bytes) || !facts.bytes || facts.bytes > 128 * 1024 * 1024
        || !count(facts.jsonBytes) || !facts.jsonBytes || facts.jsonBytes > 512 * 1024 * 1024
        || typeof facts.sha256 !== 'string' || !digest.test(facts.sha256)) {
        throw new Error(`Invalid prepared section file path or metadata: ${section.id}/${family}`);
      }
    }
  }
  if (!(catalog.sections.length + (catalog.unavailable?.length ?? 0))
    || catalog.unavailable?.some(area => !text(area.reason))
    || catalog.sections.reduce((total, section) => total + section.startCount, 0) !== info.startCount) {
    throw new Error('Invalid mountain-section coverage or start count');
  }
}

async function stat(path) {
  return lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
}

async function safeFile(root, path) {
  const parts = path.split('/');
  for (let index = 0; index < parts.length; index++) {
    const entry = await stat(join(root, ...parts.slice(0, index + 1)));
    if (!entry || !(index === parts.length - 1 ? entry.isFile() : entry.isDirectory())) {
      throw new Error(`Missing file or unsafe symbolic link: ${path}`);
    }
  }
  return join(root, ...parts);
}

async function verify(file, facts) {
  if ((await stat(file))?.size !== facts.bytes) throw new Error(`Compressed size mismatch: ${facts.path}`);
  let bytes = 0, jsonBytes = 0;
  const sha = createHash('sha256');
  await pipeline(createReadStream(file), new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length; sha.update(chunk);
      callback(bytes > facts.bytes ? new Error(`Compressed size mismatch: ${facts.path}`) : null, chunk);
    },
  }), createGunzip(), new Writable({
    write(chunk, _encoding, callback) {
      jsonBytes += chunk.length;
      callback(jsonBytes > facts.jsonBytes ? new Error(`Decoded size mismatch: ${facts.path}`) : null);
    },
  }));
  if (bytes !== facts.bytes || sha.digest('hex') !== facts.sha256) throw new Error(`Checksum mismatch: ${facts.path}`);
  if (jsonBytes !== facts.jsonBytes) throw new Error(`Decoded size mismatch: ${facts.path}`);
}

async function copyArtifact(source, destination, outputRoot, files) {
  const entry = await stat(source);
  if (!entry) return;
  if (entry.isDirectory()) {
    await mkdir(destination);
    for (const name of (await readdir(source)).sort()) await copyArtifact(join(source, name), join(destination, name), outputRoot, files);
  } else if (entry.isFile()) {
    await copyFile(source, destination, constants.COPYFILE_EXCL);
    const sha = createHash('sha256');
    let bytes = 0;
    for await (const chunk of createReadStream(destination)) { bytes += chunk.length; sha.update(chunk); }
    files.push({ path: relative(outputRoot, destination).split(sep).join('/'), bytes, sha256: sha.digest('hex') });
  } else throw new Error(`Unsafe provenance or audit artifact: ${source}`);
}

/** Combine local complete catalogs into a fresh directory; section IDs and bytes are immutable. */
export async function composeCatalog(inputDirectories, outputDirectory, options = {}) {
  if (!Array.isArray(inputDirectories) || !inputDirectories.length) throw new Error('Choose at least one input catalog directory');
  const inputs = [], ids = new Set();
  for (const directory of inputDirectories) {
    const root = await realpath(resolve(directory));
    if (!(await stat(root))?.isDirectory()) throw new Error(`Input is not a directory: ${directory}`);
    const file = await safeFile(root, 'catalog.json');
    if ((await stat(file)).size > catalogLimit) throw new Error('Input catalog exceeds 16 MB');
    const body = await readFile(file), catalog = JSON.parse(body);
    validate(catalog);
    for (const section of catalog.sections) {
      if (ids.has(section.id)) throw new Error(`Duplicate or conflicting section ID: ${section.id}`);
      ids.add(section.id);
      for (const family of families) await safeFile(root, section.files[family].path);
    }
    inputs.push({ root, body, catalog, sha256: hash(body) });
  }
  const requested = resolve(outputDirectory);
  const output = join(await realpath(dirname(requested)), basename(requested));
  if (inputs.some(input => contained(input.root, output))) throw new Error('Output must be outside every input catalog directory');
  const sourceDates = unique(inputs.map(input => input.catalog.info.sourceDate)).sort();
  const infos = inputs.map(input => input.catalog.info);
  const sections = inputs.flatMap(input => input.catalog.sections);
  const unavailable = inputs.flatMap(input => input.catalog.unavailable ?? []);
  const catalog = { version: 2, info: {
    id: 'pending', name: options.name ?? unique(infos.map(info => info.name)).join(' + '),
    bounds: [Math.min(...infos.map(info => info.bounds[0])), Math.min(...infos.map(info => info.bounds[1])),
      Math.max(...infos.map(info => info.bounds[2])), Math.max(...infos.map(info => info.bounds[3]))],
    sourceDate: sourceDates[0], startCount: sections.reduce((total, section) => total + section.startCount, 0),
    attribution: unique(infos.flatMap(info => info.attribution), item => JSON.stringify([item.name, item.url, item.license])),
    limitations: unique(infos.flatMap(info => info.limitations)),
  }, sections, unavailable };
  if (sourceDates.length > 1) catalog.info.limitations.push(`Source dates range from ${sourceDates[0]} to ${sourceDates.at(-1)}; sourceDate records the oldest date. Per-region dates and available build evidence are retained in provenance.json.`);
  catalog.info.id = `mountains-composed-${hash(encoded(catalog))}`;
  validate(catalog);
  const body = encoded(catalog);
  if (body.length > catalogLimit) throw new Error('Combined catalog exceeds 16 MB');
  // Exclusive creation reserves a new output. catalog.json is written only after all checks.
  await mkdir(output);
  try {
    await mkdir(join(output, 'sources'));
    await mkdir(join(output, 'audit'));
    const sources = [];
    let compressedBytes = 0, decodedBytes = 0;
    for (const input of inputs) {
      const audit = await stat(join(input.root, 'audit'));
      if (audit && !audit.isDirectory()) throw new Error(`Unsafe audit directory: ${input.root}`);
      const snapshot = `sources/${input.sha256}`, files = [];
      await mkdir(join(output, snapshot));
      await writeFile(join(output, snapshot, 'catalog.json'), input.body, { flag: 'wx' });
      files.push({ path: `${snapshot}/catalog.json`, bytes: input.body.length, sha256: input.sha256 });
      for (const name of ['provenance.json', 'sources']) {
        await copyArtifact(join(input.root, name), join(output, snapshot, name), output, files);
      }
      for (const section of input.catalog.sections) {
        await mkdir(join(output, 'sections', section.id), { recursive: true });
        for (const family of families) {
          const facts = section.files[family];
          await copyFile(await safeFile(input.root, facts.path), join(output, facts.path), constants.COPYFILE_EXCL);
          await verify(join(output, facts.path), facts);
          compressedBytes += facts.bytes; decodedBytes += facts.jsonBytes;
        }
        await copyArtifact(join(input.root, 'audit', section.id), join(output, 'audit', section.id), output, files);
      }
      sources.push({ catalogId: input.catalog.info.id, name: input.catalog.info.name,
        sourceDate: input.catalog.info.sourceDate, catalogSha256: input.sha256,
        sectionIds: input.catalog.sections.map(section => section.id),
        regionIds: unique(input.catalog.sections.map(section => section.regionId)), files });
    }
    await writeFile(join(output, 'provenance.json'), encoded({ version: 1, operation: 'compose',
      catalogSha256: hash(body), sourceDatePolicy: 'Earliest input source date; original metadata and evidence retained per source.',
      sources, verification: { sectionFiles: sections.length * families.length, compressedBytes, decodedBytes,
        checks: ['SHA-256', 'compressed size', 'decoded size', 'gzip integrity'] } }), { flag: 'wx' });
    await writeFile(join(output, 'catalog.json'), body, { flag: 'wx' });
    return { output, id: catalog.info.id, prepared: sections.length, unavailable: unavailable.length,
      sourceDates, compressedBytes, decodedBytes, catalogSha256: hash(body) };
  } catch (error) {
    await rm(output, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const inputs = [], options = {};
    let output;
    for (let index = 2; index < process.argv.length; index++) {
      const value = process.argv[index];
      if (value === '--output' || value === '--name') {
        const next = process.argv[++index];
        if (!next || next.startsWith('--')) throw new Error(`${value} needs a value`);
        if (value === '--output') output = next; else options.name = next;
      } else if (value.startsWith('-')) throw new Error(`Unknown option: ${value}`);
      else inputs.push(value);
    }
    if (!output) throw new Error('Usage: node scripts/compose-catalog.mjs --output NEW_DIRECTORY [--name NAME] INPUT_DIRECTORY...');
    console.log(JSON.stringify(await composeCatalog(inputs, output, options), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
