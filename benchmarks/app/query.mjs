/** One isolated completed-job HTTP observation, invoked by run.mjs. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const options = JSON.parse(process.argv[2]);
const { definition, effectiveRequest, observationMs, rssBytes, checkpoint } = options;
const result = { id: definition.id, frozenDefinition: definition, effectiveRequest,
  observationMs, rssGuardBytes: rssBytes, sampleIntervalMs: 20, apiPollIntervalMs: 100,
  timeline: [], workers: [], reconnect: null, cancel: null, measurementError: null };
let app, url, id, began, last, cancelPromise, maxRss = 0, samples = 0;
let lastSample = performance.now(), maxSampleGapMs = 0, memoryGuard = null, lastTimelineAt = -Infinity;
const elapsed = () => began === undefined ? null : performance.now() - began;
const save = () => {
  fs.writeFileSync(checkpoint + '.tmp', JSON.stringify(result, null, 2));
  fs.renameSync(checkpoint + '.tmp', checkpoint);
};
const activeWorkers = () => result.workers.filter(worker => worker.exitMs === null).length;
process.on('worker', worker => {
  const entry = { threadId: worker.threadId, createdMs: elapsed(), exitMs: null, exitCode: null };
  result.workers.push(entry);
  worker.once('exit', code => { entry.exitMs = elapsed(); entry.exitCode = code; });
});
async function api(method, route, body) {
  const response = await fetch(url + route, { method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
  const data = await response.json();
  if (!response.ok) throw Error(method + ' ' + route + ': ' + response.status + ': ' + JSON.stringify(data));
  return data;
}
const compact = snapshot => ({ status: snapshot.status, reason: snapshot.reason ?? null,
  routeCount: snapshot.routeCount, groupCount: snapshot.groupCount,
  storageBytes: snapshot.storageBytes, progress: snapshot.progress });
function observe(snapshot) {
  const at = elapsed(); last = snapshot;
  assert(!('routes' in snapshot), 'Job status must contain no route data');
  result.lastObserved = { atMs: at, ...compact(snapshot) };
  if (at - lastTimelineAt >= 1_000 || !['queued', 'running'].includes(snapshot.status)) {
    result.timeline.push(result.lastObserved); lastTimelineAt = at; save();
  }
}
async function reconnect() {
  const at = elapsed(), history = await api('GET', '/api/jobs');
  const current = history.find(job => job.id === id);
  result.reconnect = { atMs: at, latencyMs: elapsed() - at, sameJob: current?.id === id,
    sameQuery: JSON.stringify(current?.query) === JSON.stringify(result.effectiveQuery), status: current?.status };
  assert(result.reconnect.sameJob && result.reconnect.sameQuery, 'Job reconnect differs from original request');
  for (const [key, value] of Object.entries(effectiveRequest)) assert.deepEqual(current.query[key], value);
}
function cancel(trigger) {
  return cancelPromise ??= (async () => {
    const at = elapsed(), before = activeWorkers();
    try {
      const cancelled = await api('POST', '/api/jobs/' + id + '/cancel');
      result.cancel = { trigger, requestedMs: at, latencyMs: elapsed() - at, status: cancelled.status,
        activeWorkersBefore: before, activeWorkersAfterResponse: activeWorkers() };
      return cancelled;
    } catch (error) {
      result.cancel = { trigger, requestedMs: at, error: String(error) };
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
    if (id) void cancel('harness_rss_guard');
  }
}
sample();
const sampler = setInterval(sample, result.sampleIntervalMs);
try {
  const { createApp } = await import(pathToFileURL(path.join(options.server, 'server.js')));
  app = await createApp(options.dataset, undefined, path.join(path.dirname(checkpoint), 'jobs', definition.id));
  url = await app.listen({ host: '127.0.0.1', port: 0 });
  result.datasetId = (await api('GET', '/api/catalog')).id;
  assert.equal(result.datasetId, options.snapshotId);
  result.startupRssBytes = process.memoryUsage.rss();
  assert(!memoryGuard, 'Harness RSS guard exceeded before submission');
  began = performance.now();
  const submitted = await api('POST', '/api/jobs', effectiveRequest);
  result.effectiveQuery = submitted.query;
  for (const [key, value] of Object.entries(effectiveRequest)) assert.deepEqual(submitted.query[key], value);
  id = submitted.id; result.jobId = id; observe(submitted);
  while (['queued', 'running'].includes(last.status) && elapsed() < observationMs && !memoryGuard) {
    await delay(Math.min(result.apiPollIntervalMs, Math.max(0, observationMs - elapsed())));
    observe(await api('GET', '/api/jobs/' + id));
    if (result.reconnect === null && elapsed() >= Math.min(1_000, observationMs / 2)) await reconnect();
  }
  result.observation = { atMs: elapsed(), ...compact(last) };
  result.endedBecause = memoryGuard ? 'harness_rss_guard'
    : ['queued', 'running'].includes(last.status) ? 'observation_window' : 'app_terminal_status';
  if (result.reconnect === null) await reconnect();
  if (last.status === 'completed') {
    result.completedObservedMs = elapsed();
    const page = await api('GET', '/api/jobs/' + id + '/results');
    const locations = await api('GET', '/api/jobs/' + id + '/locations');
    assert.equal(page.groupCount, locations.length, 'Map must include every result family');
    result.savedResults = { groups: page.groupCount, witnesses: page.routeCount, locations: locations.length };
    if (page.routes.length) {
      const route = await api('GET', '/api/jobs/' + id + '/routes/' + page.routes[0].id);
      const q = result.effectiveQuery;
      assert(route.distance >= q.distance[0] && route.distance <= q.distance[1]);
      assert(route.gain >= q.gain[0] && route.gain <= q.gain[1]);
      assert(route.repetition <= q.repetition && route.roadDistance <= q.roads.distance);
      assert(route.roadDistance / route.distance <= q.roads.fraction && (q.includeUnknown || !route.uncertain));
      result.inspectedRoute = { id: route.id, distance: route.distance, gain: route.gain,
        roadDistance: route.roadDistance, repetition: route.repetition, points: route.geometry.length };
    }
  } else if (['queued', 'running'].includes(last.status) || cancelPromise) {
    const cancelled = await cancel(memoryGuard ? 'harness_rss_guard' : 'observation_window');
    if (cancelled) result.afterCancel = compact(cancelled);
  }
} catch (error) {
  result.measurementError = String(error.stack ?? error);
  result.endedBecause ??= 'measurement_error';
  if (id && ['queued', 'running'].includes(last?.status)) await cancel('measurement_error');
} finally {
  try { await app?.close(); } catch (error) { result.measurementError ??= String(error); }
  const deadline = performance.now() + 2_000;
  while (activeWorkers() && performance.now() < deadline) await delay(10);
  sample(); clearInterval(sampler);
  result.samples = samples; result.maxSampleGapMs = maxSampleGapMs; result.memoryGuard = memoryGuard;
  result.osProcessPeakRssBytes = process.resourceUsage().maxRSS * 1024;
  result.activeWorkersAtEnd = activeWorkers();
  if (result.cancel && !result.cancel.error) {
    const exits = result.workers.map(worker => worker.exitMs).filter(value => value !== null && value >= result.cancel.requestedMs);
    result.cancel.workerExitLatencyMs = exits.length ? Math.max(...exits) - result.cancel.requestedMs : null;
  }
  if (result.cancel?.error || activeWorkers()) result.measurementError ??= 'Cancellation or worker cleanup failed.';
  result.outcome = result.measurementError || ['failed', 'interrupted'].includes(result.observation?.status) ? 'failed'
    : !memoryGuard && result.observation?.status === 'completed' ? 'complete_within_snapshot' : 'unfinished';
  save();
}
if (result.outcome === 'failed') process.exitCode = 1;
