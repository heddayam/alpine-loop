// Real compiled server/worker/inspection/export observation, separate from browser memory.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { cpus, totalmem, platform, arch } from 'node:os';
import { createApp } from '../../dist/server/server.js';

const [dataset, sourceReport] = process.argv.slice(2);
if (!dataset || !sourceReport) throw new Error('Usage: node run.mjs DATASET SOURCE_REPLAY_JSON');
const directory = resolve(dataset);
const fixed = JSON.parse(await readFile(new URL('./witness.json', import.meta.url), 'utf8'));
const frozen = JSON.parse(await readFile(new URL('../queries.json', import.meta.url), 'utf8'));
assert.deepEqual(fixed.query, frozen.queries.find(query => query.id === 'north-bend-known').query);
const query = fixed.query;
const witness = JSON.parse(await readFile(sourceReport, 'utf8'));
assert.equal(witness.sourceSnapshotVerified, true);
assert.equal(witness.querySatisfied, true);
const hashes = {};
for (const name of ['graph', 'geometry']) {
  hashes[name] = createHash('sha256').update(await readFile(join(directory, `${name}.json.gz`))).digest('hex');
}
assert.equal(hashes.graph, witness.graphSha256, 'Replay the independent source witness on this exact dataset first');

const observationMs = 30_000;
let peakRss = process.memoryUsage().rss;
const monitor = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 20);
let app;
try {
  app = await createApp(directory);
  const api = async (method, url, expected = 200, payload) => {
    const response = await app.inject({ method, url, ...(payload === undefined ? {} : { payload }) });
    assert.equal(response.statusCode, expected, response.body);
    return response;
  };
  const started = performance.now();
  let snapshot = (await api('POST', '/api/search', 202, query)).json();
  const searchId = snapshot.id;
  let firstExactMs = null, allAttemptedMs = null, cancelMs = null;
  while (snapshot.status === 'running' && performance.now() - started < observationMs) {
    await new Promise(resolve => setTimeout(resolve, 20));
    snapshot = (await api('GET', `/api/search/${searchId}`)).json();
    if (snapshot.routeCount && firstExactMs === null) firstExactMs = performance.now() - started;
    if (snapshot.progress.totalStarts && snapshot.progress.attemptedStarts === snapshot.progress.totalStarts
      && allAttemptedMs === null) allAttemptedMs = performance.now() - started;
  }
  if (snapshot.status === 'running') {
    const cancelAt = performance.now();
    snapshot = (await api('POST', `/api/search/${searchId}/stop`, 200, {})).json();
    cancelMs = performance.now() - cancelAt;
  }
  const matches = snapshot.routes.filter(route => route.startId === witness.startId
    && Math.abs(route.distance - witness.metrics.distance) < 1e-7
    && Math.abs(route.gain - witness.metrics.gain) < 1e-7
    && Math.abs(route.repetition - witness.metrics.repetition) < 1e-12);
  assert.equal(matches.length, 1, 'Expected one retained choice matching the independently proven start and measurements');
  const route = matches[0];
  const detail = (await api('GET', `/api/search/${searchId}/routes/${route.id}`)).json();
  const exported = await api('GET', `/api/search/${searchId}/routes/${route.id}.gpx`);
  const positions = detail.geometry;
  const gain = positions.slice(1).reduce((sum, point, index) => sum + Math.max(0, point[2] - positions[index][2]), 0);
  assert.deepEqual(positions[0], positions.at(-1), 'Inspected route is not closed');
  assert.ok(Math.abs(gain - detail.gain) < 1e-7, 'Inspected profile and gain disagree');
  const gpxPoints = [...exported.body.matchAll(/<trkpt lat="([^"]+)" lon="([^"]+)"><ele>([^<]+)<\/ele><\/trkpt>/g)]
    .map(([, lat, lon, elevation]) => [Number(lon), Number(lat), Number(elevation)]);
  assert.deepEqual(gpxPoints, positions, 'GPX coordinates differ from the inspected route');
  const reconnect = (await api('GET', '/api/search')).json();
  assert.equal(reconnect.id, searchId);
  const inspected = { start: detail.startName, distance: detail.distance, gain: detail.gain, profileGain: gain,
    repetition: detail.repetition, kind: detail.kind, uncertain: detail.uncertain, points: positions.length,
    closed: true, gpxStatus: exported.statusCode, gpxPoints: gpxPoints.length, gpxMatchesGeometry: true,
    gpxSha256: createHash('sha256').update(exported.body).digest('hex') };
  console.log(JSON.stringify({ createdAt: new Date().toISOString(), node: process.version,
    machine: { cpu: cpus()[0]?.model, memoryBytes: totalmem(), platform: platform(), architecture: arch() },
    hashes, query, observationMs, firstExactMs, allAttemptedMs, cancelMs, status: snapshot.status,
    progress: snapshot.progress, routeCount: snapshot.routeCount, independentWitnessRetained: true,
    peakObservedServerWorkerRssBytes: peakRss, reconnectsToSameSearch: true, inspected,
    limitation: 'Single real-data server/worker observation using injected API requests. RSS sampled every 20 ms; browser memory and transport are not measured. The observation window is not an application timeout.' }, null, 2));
} finally {
  clearInterval(monitor);
  await app?.close();
}
