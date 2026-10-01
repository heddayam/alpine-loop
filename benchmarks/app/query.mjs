/** One isolated HTTP observation, invoked by run.mjs. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const options = JSON.parse(process.argv[2]);
const { definition, observationMs, rssBytes, checkpoint } = options;
const result = { id: definition.id, query: definition.query, originalPilotDatasetId: definition.datasetId,
  observationMs, rssGuardBytes: rssBytes, sampleIntervalMs: 20, apiPollIntervalMs: 100,
  firstRetainedRouteObservedMs: null, previousEmptyObservationMs: null, firstAttemptObservedMs: null,
  allStartsAttemptedObservedMs: null, timeline: [], workers: [], reconnect: null, stop: null, measurementError: null };
let app, url, id, began, last, stopPromise, maxRss = 0, samples = 0, lastSample = performance.now(), maxSampleGapMs = 0;
let memoryGuard = null, lastTimelineAt = -Infinity;
const elapsed = () => began === undefined ? null : performance.now() - began;
const save = () => { fs.writeFileSync(checkpoint + '.tmp', JSON.stringify(result, null, 2)); fs.renameSync(checkpoint + '.tmp', checkpoint); };
const activeWorkers = () => result.workers.filter(worker => worker.exitMs === null).length;
process.on('worker', worker => {
  const entry = { threadId: worker.threadId, createdMs: elapsed(), exitMs: null, exitCode: null };
  result.workers.push(entry);
  worker.once('exit', code => { entry.exitMs = elapsed(); entry.exitCode = code; });
});
async function api(method, route, body) {
  const response = await fetch(`${url}${route}`, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5_000) });
  const data = await response.json();
  if (!response.ok) throw Error(`${method} ${route}: ${response.status}: ${JSON.stringify(data)}`);
  return data;
}
const compact = snapshot => ({ status: snapshot.status, reason: snapshot.reason ?? null, coverageNote: snapshot.coverageNote ?? null,
  routeCount: snapshot.routeCount, groupCount: snapshot.groupCount, progress: snapshot.progress });
function observe(snapshot) {
  const at = elapsed(); last = snapshot;
  if (snapshot.routeCount > 0) result.firstRetainedRouteObservedMs ??= at;
  else if (result.firstRetainedRouteObservedMs === null) result.previousEmptyObservationMs = at;
  if (snapshot.progress.attemptedStarts > 0) result.firstAttemptObservedMs ??= at;
  if (snapshot.progress.totalStarts > 0 && snapshot.progress.attemptedStarts === snapshot.progress.totalStarts) result.allStartsAttemptedObservedMs ??= at;
  result.lastObserved = { atMs: at, ...compact(snapshot) };
  if (at - lastTimelineAt >= 1_000 || snapshot.status !== 'running') {
    result.timeline.push(result.lastObserved); lastTimelineAt = at; save();
  }
}
async function reconnect() {
  const at = elapsed(), current = await api('GET', '/api/search');
  result.reconnect = { atMs: at, latencyMs: elapsed() - at, sameSearch: current?.id === id,
    sameQuery: JSON.stringify(current?.query) === JSON.stringify(result.effectiveQuery), status: current?.status,
    routeCount: current?.routeCount, groupCount: current?.groupCount };
  assert(result.reconnect.sameSearch && result.reconnect.sameQuery, 'Current-search reconnect differs from the original query');
}
function stop(trigger) {
  return stopPromise ??= (async () => {
    const at = elapsed(), before = activeWorkers();
    try {
      const stopped = await api('POST', `/api/search/${id}/stop`);
      result.stop = { trigger, requestedMs: at, latencyMs: elapsed() - at, status: stopped.status,
        activeWorkersBefore: before, activeWorkersAfterResponse: activeWorkers() };
      return stopped;
    } catch (error) {
      result.stop = { trigger, requestedMs: at, error: String(error) };
      return null;
    }
  })();
}
function sample() {
  const now = performance.now(), rss = process.memoryUsage.rss();
  maxSampleGapMs = Math.max(maxSampleGapMs, now - lastSample); lastSample = now;
  maxRss = Math.max(maxRss, rss); samples++;
  result.sampledPeakRssBytes = maxRss;
  if (rss > rssBytes && memoryGuard === null) {
    memoryGuard = { atMs: elapsed(), rssBytes: rss };
    if (id) void stop('harness_rss_guard');
  }
}
sample();
const sampler = setInterval(sample, result.sampleIntervalMs);
try {
  const { createApp } = await import(pathToFileURL(path.join(options.server, 'server.js')));
  app = await createApp(options.dataset);
  url = await app.listen({ host: '127.0.0.1', port: 0 });
  result.datasetId = (await api('GET', '/api/catalog')).id;
  assert.equal(result.datasetId, options.snapshotId, 'Dataset changed before search');
  result.startupRssBytes = process.memoryUsage.rss();
  assert(!memoryGuard, 'Harness RSS guard exceeded before search');
  began = performance.now();
  const started = await api('POST', '/api/search', definition.query);
  result.effectiveQuery = started.query;
  for (const [key, value] of Object.entries(definition.query)) {
    assert.deepEqual(started.query[key], value, `App changed the requested ${key} constraint`);
  }
  id = started.id; result.searchId = id; observe(started);
  while (last.status === 'running' && elapsed() < observationMs && !memoryGuard) {
    await delay(Math.min(result.apiPollIntervalMs, Math.max(0, observationMs - elapsed())));
    observe(await api('GET', `/api/search/${id}`));
    if (result.reconnect === null && elapsed() >= Math.min(1_000, observationMs / 2)) await reconnect();
  }
  result.observation = { atMs: elapsed(), ...compact(last) };
  result.endedBecause = memoryGuard ? 'harness_rss_guard' : last.status === 'running' ? 'observation_window' : 'app_terminal_status';
  if (result.reconnect === null) await reconnect();
  if (last.status === 'running' || stopPromise) {
    const stopped = await stop(memoryGuard ? 'harness_rss_guard' : 'observation_window');
    if (stopped) result.afterStop = compact(stopped);
  }
} catch (error) {
  result.measurementError = String(error.stack ?? error);
  result.endedBecause ??= 'measurement_error';
  if (id) await stop('measurement_error');
} finally {
  try { await app?.close(); } catch (error) { result.measurementError ??= String(error); }
  const deadline = performance.now() + 2_000;
  while (activeWorkers() && performance.now() < deadline) await delay(10);
  sample(); clearInterval(sampler);
  result.samples = samples; result.maxSampleGapMs = maxSampleGapMs; result.memoryGuard = memoryGuard;
  result.osProcessPeakRssBytes = process.resourceUsage().maxRSS * 1024;
  result.activeWorkersAtEnd = activeWorkers();
  if (result.stop && !result.stop.error) {
    const exits = result.workers.map(worker => worker.exitMs).filter(value => value !== null && value >= result.stop.requestedMs);
    result.stop.workerExitLatencyMs = exits.length ? Math.max(...exits) - result.stop.requestedMs : null;
  }
  if (result.stop?.error || activeWorkers()) result.measurementError ??= 'Stop or worker cleanup failed; observation is incomplete.';
  result.outcome = result.measurementError || result.observation?.status === 'failed' ? 'failed'
    : !memoryGuard && result.observation?.status === 'complete' ? 'complete_within_snapshot' : 'unfinished';
  save();
}
if (result.outcome === 'failed') process.exitCode = 1;
