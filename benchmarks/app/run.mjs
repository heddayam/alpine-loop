/** Measure the current HTTP app. Observation limits never change its query. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const usage = 'Usage: node benchmarks/app/run.mjs --dataset DIR --output FILE [--observation-ms 30000] [--rss-bytes 1000000000] [--query ID]\nRun npm run build first. Omitting --query runs all frozen queries sequentially.';
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
const queryFile = path.join(root, 'benchmarks/queries.json'), manifestFile = path.join(dataset, 'manifest.json');
const definitions = read(queryFile).queries.filter(query => !args.has('--query') || query.id === args.get('--query'));
assert(definitions.length, `Unknown frozen query: ${args.get('--query')}`);
const provenanceFile = path.join(dataset, 'audit/provenance.json');
const provenance = fs.existsSync(provenanceFile) ? read(provenanceFile) : null;
const report = {
  version: 1, startedAt: new Date().toISOString(), dataset, observationMs, rssGuardBytes: rssBytes,
  machine: { node: process.version, platform: process.platform, arch: process.arch, cpu: os.cpus()[0]?.model, memoryBytes: os.totalmem() },
  inputs: { queriesSha256: hash(queryFile), manifestSha256: hash(manifestFile), snapshotId: read(manifestFile).info.id,
    compiledHashes: codeHashes(server), packageLockSha256: hash(path.join(root, 'package-lock.json')),
    harnessHashes: Object.fromEntries(['run.mjs', 'query.mjs'].map(name => [name, hash(path.join(here, name))])) },
  sourceCompilation: provenance ? { provenanceSha256: hash(provenanceFile), snapshotId: provenance.snapshotId,
    compilerHashes: provenance.compiler, osmium: provenance.osmium, sourceManifest: provenance.manifest } : null,
  methodology: [
    'Fresh process, ephemeral loopback HTTP server and real search worker for each query; no live app is contacted.',
    'RSS includes server, worker threads and in-process HTTP measurement client; browser and coordinator memory are excluded. Sampling can miss peaks; OS high-water and sample gaps are also recorded.',
    'Route timing is first API observation with 100ms polls, not exact discovery time. Reconnect checks the current-search API, not browser rendering.',
    'The observation window and sampled RSS guard only stop this measurement through the app Stop API. An outer deadline kills a hung child after the window plus 15 seconds.',
    'Query criteria are frozen; historical pilot dataset IDs/start counts do not describe the supplied snapshot. Counts are retained app choices, not independent existence certificates.',
    'Each result records the effective query, including app defaults for newer settings absent from the frozen request. Explicit requested constraints must remain unchanged.',
    'Timing is descriptive; filesystem caches and concurrent machine activity are uncontrolled. Failed or interrupted observations do not prove no matches.',
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
    fs.rmSync(checkpoint, { force: true });
    report.currentQuery = definition.id; save();
    const child = spawnSync(process.execPath, [path.join(here, 'query.mjs'), JSON.stringify({
      dataset, server, definition, observationMs, rssBytes, checkpoint, snapshotId: report.inputs.snapshotId,
    })], { encoding: 'utf8', timeout: observationMs + 15_000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 });
    const result = fs.existsSync(checkpoint) ? read(checkpoint) : { id: definition.id, measurementError: 'No observation was saved; no route conclusion is possible.' };
    result.processOutcome = { exitCode: child.status, signal: child.signal, error: child.error?.message ?? null, stderr: child.stderr };
    if (child.status !== 0) result.measurementError ??= 'Child failed or exceeded its outer measurement deadline; exploration was not certified complete.';
    report.results.push(result); report.currentQuery = null; save();
    console.log(JSON.stringify({ id: result.id, outcome: result.outcome, status: result.observation?.status,
      routes: result.observation?.routeCount, peakRssBytes: result.osProcessPeakRssBytes, stopMs: result.stop?.latencyMs, error: result.measurementError }));
  }
  assert.deepEqual(codeHashes(server), report.inputs.compiledHashes, 'Compiled app changed during measurement');
  assert.equal(hash(manifestFile), report.inputs.manifestSha256, 'Dataset manifest changed during measurement');
  report.finishedAt = new Date().toISOString();
} catch (error) {
  report.measurementError = String(error.stack ?? error);
} finally {
  report.hasFailures = !!report.measurementError || report.results.some(result => result.measurementError || result.memoryGuard || result.outcome === 'failed');
  save(); fs.rmSync(temporary, { recursive: true, force: true });
}
if (report.hasFailures) process.exitCode = 1;
