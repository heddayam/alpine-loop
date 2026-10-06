/** Measure the current HTTP app. Observation limits never change its query. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const usage = 'Usage: node benchmarks/app/run.mjs --dataset DIR --output FILE [--observation-ms 30000] [--rss-bytes 1000000000] [--query ID|all-regions]\nRun npm run build first. Omitting --query runs all frozen queries sequentially.';
const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index], value = process.argv[index + 1];
  if (key === '--help') { console.log(usage); process.exit(0); }
  assert(['--dataset', '--output', '--observation-ms', '--rss-bytes', '--query'].includes(key) && value && !args.has(key), usage);
  args.set(key, value);
}
assert(args.has('--dataset') && args.has('--output'), usage);
const dataset = path.resolve(args.get('--dataset')), output = path.resolve(args.get('--output'));
const observationMs = Number(args.get('--observation-ms') ?? 30_000);
const rssBytes = Number(args.get('--rss-bytes') ?? 1_000_000_000);
assert(Number.isSafeInteger(observationMs) && observationMs > 0 && Number.isSafeInteger(rssBytes) && rssBytes > 0, 'Limits must be positive integer milliseconds/bytes');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const server = path.join(root, 'dist/server');
assert(fs.existsSync(path.join(server, 'server.js')), 'Compiled app missing; run npm run build first');
function codeHashes(directory) {
  return Object.fromEntries(fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? Object.entries(codeHashes(file)) : entry.name.endsWith('.js') ? [[path.relative(server, file), hash(file)]] : [];
  }).sort(([a], [b]) => a.localeCompare(b)));
}
const queryFile = path.join(root, 'benchmarks/queries.json'), manifestFile = path.join(dataset, 'catalog.json');
const definitions = args.get('--query') === 'all-regions' ? [{ id: 'all-regions-default', query: { distance: [8046.72, 19312.128], gain: [0, 1219.2], repetition: 0.2, includeUnknown: true } }]
  : read(queryFile).queries.filter(query => !args.has('--query') || query.id === args.get('--query'));
assert(definitions.length, `Unknown frozen query: ${args.get('--query')}`);
const catalog = read(manifestFile);
const startsFiles = catalog.sections.map(section => {
  const file = path.join(dataset, section.files.starts.path);
  assert(fs.existsSync(file), `Prepared starts missing for ${section.name}: ${file}; install the complete dataset before measuring`);
  assert.equal(hash(file), section.files.starts.sha256, `Prepared starts checksum differs for ${section.name}`);
  return { section, file, records: JSON.parse(gunzipSync(fs.readFileSync(file))) };
});
const startHashes = Object.fromEntries(startsFiles.map(({ section, file }) => [section.id, hash(file)]));
function sectionRequest(definition) {
  if (!definition.query.area) return { sections: catalog.sections.map(section => section.id).sort(), ...definition.query };
  const { area: [west, south, east, north], ...constraints } = definition.query;
  const selected = startsFiles.filter(({ records }) => records.some(([start, [lon, lat]]) =>
    lon >= west && lon <= east && lat >= south && lat <= north));
  assert(selected.length, `No prepared section contains a start in frozen query ${definition.id}`);
  for (const { section } of selected) for (const file of Object.values(section.files)) {
    assert(fs.existsSync(path.join(dataset, file.path)), `Prepared ${section.name} is incomplete: missing ${file.path}`);
  }
  return { sections: selected.map(({ section }) => section.id).sort(), ...constraints };
}
const requests = new Map(definitions.map(definition => [definition.id, sectionRequest(definition)]));
const provenanceFile = path.join(dataset, 'provenance.json');
const provenance = fs.existsSync(provenanceFile) ? read(provenanceFile) : null;
const report = {
  version: 3, startedAt: new Date().toISOString(), dataset, observationMs, rssGuardBytes: rssBytes,
  machine: { node: process.version, platform: process.platform, arch: process.arch, cpu: os.cpus()[0]?.model, memoryBytes: os.totalmem() },
  inputs: { queriesSha256: hash(queryFile), manifestSha256: hash(manifestFile), snapshotId: catalog.info.id, preparedStartsSha256: startHashes,
    compiledHashes: codeHashes(server), packageLockSha256: hash(path.join(root, 'package-lock.json')),
    harnessHashes: Object.fromEntries(['run.mjs', 'query.mjs'].map(name => [name, hash(path.join(here, name))])) },
  sourceCompilation: provenance ? { provenanceSha256: hash(provenanceFile), evidence: provenance.plan.evidence,
    policy: provenance.plan.policy, observations: provenance.observations } : null,
  methodology: [
    'Frozen rectangles identify prepared sections containing at least one prepared start. Region selection is independent of access filters; eligibility is applied by the unchanged submitted query. Searches consider all eligible starts in those exact sections.',
    'Whole-section start scope expands the original rectangles. Timing, start counts and results are not directly comparable to earlier rectangular observations. Each result retains its original frozen definition and the adapted exact-section request.',
    'Fresh process, ephemeral loopback HTTP server and real search worker for each query; no live app is contacted.',
    'RSS includes server, worker threads and in-process HTTP measurement client; browser and coordinator memory are excluded. Sampling can miss peaks; OS high-water and sample gaps are also recorded.',
    'Completion timing is first durable completed-status observation with 100ms polls. Reconnect checks saved history and exact request identity, not browser rendering.',
    'The observation window and sampled RSS guard only stop this measurement through the app cancellation API. An outer deadline kills a hung child after the window plus 15 seconds.',
    'Route constraints remain frozen; historical pilot dataset IDs/start counts do not describe the supplied sections. Counts are completed saved families and witnesses, not independent existence certificates.',
    'Each result records the adapted sent request and effective query, including app defaults for newer settings. Explicit constraints and exact selected section IDs must remain unchanged.',
    'Timing is descriptive; filesystem caches and concurrent machine activity are uncontrolled. Bounded discovery can miss qualifying hikes; completed empty searches do not prove absence. Failed or interrupted observations likewise do not prove no matches.',
  ],
  plannedQueries: definitions.map(query => query.id), results: [],
};
fs.mkdirSync(path.dirname(output), { recursive: true });
const save = () => { fs.writeFileSync(output + '.tmp', JSON.stringify(report, null, 2) + '\n'); fs.renameSync(output + '.tmp', output); };
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'alpine-app-measurements-'));
const checkpoint = path.join(temporary, 'query.json');
try {
  save();
  for (const definition of definitions) {
    assert.deepEqual(codeHashes(server), report.inputs.compiledHashes, 'Compiled app changed during measurement');
    assert.equal(hash(queryFile), report.inputs.queriesSha256, 'Frozen query file changed');
    assert.equal(hash(manifestFile), report.inputs.manifestSha256, 'Dataset manifest changed');
    for (const { section, file } of startsFiles) assert.equal(hash(file), startHashes[section.id], `Prepared starts changed for ${section.name}`);
    fs.rmSync(checkpoint, { force: true });
    report.currentQuery = definition.id; save();
    const child = spawnSync(process.execPath, [path.join(here, 'query.mjs'), JSON.stringify({
      dataset, server, definition, effectiveRequest: requests.get(definition.id), observationMs, rssBytes, checkpoint, snapshotId: report.inputs.snapshotId,
    })], { encoding: 'utf8', timeout: observationMs + 15_000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 });
    const result = fs.existsSync(checkpoint) ? read(checkpoint) : { id: definition.id, measurementError: 'No observation was saved; no route conclusion is possible.' };
    result.processOutcome = { exitCode: child.status, signal: child.signal, error: child.error?.message ?? null, stderr: child.stderr };
    if (child.status !== 0) result.measurementError ??= 'Child failed or exceeded its outer measurement deadline; exploration was not certified complete.';
    report.results.push(result); report.currentQuery = null; save();
    console.log(JSON.stringify({ id: result.id, outcome: result.outcome, status: result.observation?.status,
      routes: result.observation?.routeCount, peakRssBytes: result.osProcessPeakRssBytes, cancelMs: result.cancel?.latencyMs, error: result.measurementError }));
  }
  assert.deepEqual(codeHashes(server), report.inputs.compiledHashes, 'Compiled app changed during measurement');
  assert.equal(hash(manifestFile), report.inputs.manifestSha256, 'Dataset manifest changed during measurement');
  for (const { section, file } of startsFiles) assert.equal(hash(file), startHashes[section.id], `Prepared starts changed for ${section.name}`);
  report.finishedAt = new Date().toISOString();
} catch (error) {
  report.measurementError = String(error.stack ?? error);
} finally {
  report.hasFailures = !!report.measurementError || report.results.some(result => result.measurementError || result.memoryGuard || result.outcome === 'failed');
  save(); fs.rmSync(temporary, { recursive: true, force: true });
}
if (report.hasFailures) process.exitCode = 1;
