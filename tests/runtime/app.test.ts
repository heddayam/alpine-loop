import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { SectionGeometry } from '../../src/data-format.js';
import { ROUTES_PER_PAGE, type JobResults, type JobSnapshot, type RouteView } from '../../src/model.js';
import { createNetworkFixture, query } from './network-fixture.js';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const remove of cleanup.splice(0).reverse()) await remove(); });
type App = Awaited<ReturnType<typeof import('../../src/server.js').createApp>>;
async function fixture(options: Parameters<typeof createNetworkFixture>[0] = {}) {
  const data = await createNetworkFixture(options);
  cleanup.push(() => rm(data.directory, { recursive: true, force: true }));
  const jobDirectory = await mkdtemp(join(tmpdir(), 'alpine-jobs-test-'));
  cleanup.push(() => rm(jobDirectory, { recursive: true, force: true }));
  return { ...data, jobDirectory };
}
async function openApp(directory: string, jobDirectory: string) {
  // Every accepted job uses the built worker; no worker/solver mocks or TS loader.
  const { createApp } = await import('../../dist/server/server.js');
  const app = await createApp(directory, undefined, jobDirectory);
  cleanup.push(() => app.close());
  return app;
}
async function finished(app: App, initial: JobSnapshot, timeout = 5000) {
  let snapshot = initial;
  const deadline = Date.now() + timeout;
  while (['running', 'queued'].includes(snapshot.status) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 20));
    snapshot = (await app.inject(`/api/jobs/${snapshot.id}`)).json();
  }
  return snapshot;
}
const submit = (app: App, payload = query) => app.inject({ method: 'POST', url: '/api/jobs', payload });

describe('completed jobs through the actual app and worker', () => {
  it.each(['missing', 'disconnected', 'shifted'] as const)('rejects %s drawing geometry before publication', async fault => {
    const { directory, jobDirectory, catalog } = await fixture();
    const file = catalog.sections[0]!.files.geometry;
    const geometry: SectionGeometry = gunzipSync(await readFile(join(directory, file.path))).toString().trimEnd().split('\n').map(line => ({ id: '', name: null, coordinates: JSON.parse(line) }));
    if (fault === 'missing') geometry[0]!.coordinates = [];
    else if (fault === 'disconnected') geometry[0]!.coordinates[0]![0] += .01;
    else for (const shape of geometry) for (const point of shape.coordinates) point[0] += .01;
    const raw = Buffer.from(geometry.map(shape => JSON.stringify(shape.coordinates) + '\n').join('')), compressed = gzipSync(raw);
    Object.assign(file, { bytes: compressed.length, jsonBytes: raw.length, sha256: createHash('sha256').update(compressed).digest('hex') });
    await writeFile(join(directory, file.path), compressed);
    await writeFile(join(directory, 'catalog.json'), JSON.stringify(catalog));
    const app = await openApp(directory, jobDirectory);
    const snapshot = await finished(app, (await submit(app)).json());
    expect(snapshot.status).toBe('failed');
    expect(snapshot.reason).toMatch(/drawing/i);
    expect((await app.inject(`/api/jobs/${snapshot.id}/results`)).statusCode).toBe(409);
    await app.close();
    expect((await readdir(jobDirectory)).some(name => name.startsWith(snapshot.id))).toBe(false);
  });

  it('publishes stable grouped pages, all locations and preferred GPX; retains them after source removal and restart', async () => {
    const count = ROUTES_PER_PAGE + 1;
    const { directory, jobDirectory, firstLoop } = await fixture({ startCount: count, routeCount: count,
      connectorSections: [0], directional: true });
    const criteria = { ...query, roads: { distance: 200, fraction: 1 / 3 } };
    let app = await openApp(directory, jobDirectory);
    expect((await app.inject('/api/jobs')).json()).toEqual([]);
    const response = await submit(app, criteria);
    expect(response.statusCode).toBe(202);
    const initial = response.json() as JobSnapshot;
    for (const path of ['results', 'locations', 'routes/unavailable', 'routes/unavailable.gpx']) {
      expect((await app.inject(`/api/jobs/${initial.id}/${path}`)).statusCode).toBe(409);
    }
    const snapshot = await finished(app, initial);
    expect(snapshot.status).toBe('completed');
    expect((await app.inject({ method: 'POST', url: `/api/jobs/${snapshot.id}/deepen` })).statusCode).toBe(404);
    expect(snapshot.query).toEqual({ ...criteria, effort: 'deep' });
    expect(snapshot).not.toHaveProperty('routes');
    expect(snapshot.progress).toMatchObject({ completedRegions: ['fixture-0'], totalRegions: 1, totalStarts: count, completedStarts: count });
    expect(snapshot.progress.totalSearchPoints).toBeGreaterThan(0);
    expect(snapshot.progress.completedSearchPoints).toBe(snapshot.progress.totalSearchPoints);
    expect(snapshot.storageBytes).toBeGreaterThan(0);
    const results = (await app.inject(`/api/jobs/${snapshot.id}/results`)).json() as JobResults;
    expect(results).toMatchObject({ routeCount: count, groupCount: count, pageTotal: count, offset: 0, sort: 'distance', order: 'asc' });
    expect(results.routes).toHaveLength(ROUTES_PER_PAGE);
    const lastPage = (await app.inject(`/api/jobs/${snapshot.id}/results?offset=${ROUTES_PER_PAGE}`)).json() as JobResults;
    expect(lastPage.routes).toHaveLength(1);
    const locations = (await app.inject(`/api/jobs/${snapshot.id}/locations`)).json();
    expect(locations).toHaveLength(count);
    expect(locations.some((location: { id: string }) => location.id === lastPage.routes[0]!.id)).toBe(true);
    const summary = results.routes.find(route => route.roadDistance === 200)!;
    expect(summary).not.toHaveProperty('geometry');
    for (const removed of ['variantId', 'variantCount', 'groupSize', 'reverseId', 'oppositeId']) expect(summary).not.toHaveProperty(removed);
    const route = (await app.inject(`/api/jobs/${snapshot.id}/routes/${summary.id}`)).json() as RouteView;
    expect(route.id).toHaveLength(32);
    expect(route).toMatchObject({ gain: 60, geometry: firstLoop, uncertain: false });
    const exported = await app.inject(`/api/jobs/${snapshot.id}/routes/${route.id}.gpx`);
    expect(exported.headers['content-type']).toContain('application/gpx+xml');
    expect(exported.body).toContain('Creek &amp; Ridge &lt;loop&gt;');
    const points = [...exported.body.matchAll(/<trkpt lat="([^"]+)" lon="([^"]+)"><ele>([^<]+)<\/ele><\/trkpt>/g)]
      .map(([, lat, lon, elevation]) => [Number(lon), Number(lat), Number(elevation)]);
    expect(points).toEqual(route.geometry);
    expect((await app.inject(`/api/jobs/${snapshot.id}/results?sort=roadDistance&order=desc`)).json().routes[0].roadDistance).toBe(200);
    expect((await app.inject(`/api/jobs/${snapshot.id}/results?sort=invalid`)).statusCode).toBe(400);
    expect((await app.inject(`/api/jobs/${snapshot.id}/results?offset=-1`)).statusCode).toBe(400);
    await app.close();
    await rm(directory, { recursive: true });
    app = await openApp(directory, jobDirectory);
    expect((await app.inject('/api/catalog')).statusCode).toBe(503);
    expect((await app.inject(`/api/jobs/${snapshot.id}`)).json()).toEqual(snapshot);
    expect((await app.inject(`/api/jobs/${snapshot.id}/results`)).json()).toEqual(results);
    expect((await app.inject(`/api/jobs/${snapshot.id}/routes/${route.id}`)).json()).toEqual(route);
    expect((await app.inject(`/api/jobs/${snapshot.id}/routes/${route.id}.gpx`)).body).toBe(exported.body);
    expect((await app.inject({ method: 'DELETE', url: `/api/jobs/${snapshot.id}` })).statusCode).toBe(204);
    expect((await app.inject('/api/jobs')).json()).toEqual([]);
    expect((await readdir(jobDirectory)).filter(file => !['metadata.sqlite', 'owner.sqlite', 'owner.sqlite-journal'].includes(file))).toEqual([]);
  });

  it('queues immutable requests in FIFO order and completes empty results honestly', async () => {
    const { directory, jobDirectory } = await fixture({ sectionCount: 2 });
    const app = await openApp(directory, jobDirectory);
    const criteria = { ...query, sections: ['fixture-0', 'fixture-1'] };
    const first = (await submit(app, criteria)).json() as JobSnapshot;
    const second = (await submit(app, { ...criteria, distance: [1, 10] })).json() as JobSnapshot;
    expect(second).toMatchObject({ status: 'queued', queuePosition: 1 });
    expect((await app.inject({ method: 'DELETE', url: `/api/jobs/${first.id}` })).statusCode).toBe(409);
    const completedFirst = await finished(app, first), completedSecond = await finished(app, second);
    expect(completedFirst.status).toBe('completed');
    expect(completedFirst.progress.completedRegions).toEqual(criteria.sections);
    expect(completedSecond.status).toBe('completed');
    expect(Date.parse(completedSecond.startedAt!)).toBeGreaterThanOrEqual(Date.parse(completedFirst.finishedAt!));
    expect((await app.inject(`/api/jobs/${first.id}/results`)).json().groupCount).toBe(2);
    const empty = (await app.inject(`/api/jobs/${second.id}/results`)).json() as JobResults;
    expect(empty).toMatchObject({ routes: [], groupCount: 0, routeCount: 0, pageTotal: 0 });
    expect((await app.inject(`/api/jobs/${second.id}/locations`)).json()).toEqual([]);
    const history = (await app.inject('/api/jobs')).json() as JobSnapshot[];
    expect(history.map(job => job.id)).toEqual([second.id, first.id]);
    expect(history.every(job => !('routes' in job) && !('inputs' in job))).toBe(true);
    expect(history.every(job => job.regions?.length === 2)).toBe(true);
    expect((await app.inject(`/api/jobs/${first.id}`)).json().inputs.sections).toHaveLength(2);
    expect(history.find(job => job.id === first.id)!.query).toEqual({ ...criteria, effort: 'deep', roads: { distance: 1609.344, fraction: .1 } });
  });

  it('pages retained history by a stable cursor and serves compact active status', async () => {
    const { directory, jobDirectory } = await fixture();
    const metadata = new DatabaseSync(join(jobDirectory, 'metadata.sqlite'));
    metadata.exec('CREATE TABLE jobs (position INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE, snapshot TEXT, status TEXT)');
    const ids: string[] = [];
    for (let index = 0; index < 123; index++) {
      const id = randomUUID(); ids.unshift(id);
      const job: JobSnapshot = { id, query, status: 'failed', createdAt: new Date().toISOString(), storageBytes: 0,
        progress: { stage: 'preparing', completedRegions: [], totalRegions: 1, elapsedMs: 0, expansions: 0, completedStarts: 0, totalStarts: 1 } };
      metadata.prepare('INSERT INTO jobs(id,snapshot,status) VALUES (?,?,?)').run(id, JSON.stringify(job), job.status);
    }
    metadata.close();
    const app = await openApp(directory, jobDirectory);
    expect((await app.inject('/api/jobs/active')).json()).toEqual([]);
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = (await app.inject(`/api/jobs/history${cursor ? `?before=${cursor}` : ''}`)).json();
      expect(page.jobs.length).toBeLessThanOrEqual(50);
      expect(page.jobs.every((job: JobSnapshot) => !job.inputs)).toBe(true);
      seen.push(...page.jobs.map((job: JobSnapshot) => job.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toEqual(ids);
    expect((await app.inject('/api/jobs/history?before=absent')).statusCode).toBe(404);
    const running = (await submit(app)).json() as JobSnapshot;
    expect((await app.inject('/api/jobs/active')).json()).toMatchObject([{ id: running.id, status: 'running' }]);
    const completed = await finished(app, running);
    expect(completed.status).toBe('completed');
    expect((await app.inject('/api/jobs/active')).json()).toEqual([]);
    expect((await app.inject(`/api/jobs/${completed.id}?inputs=false`)).json()).not.toHaveProperty('inputs');
    expect((await app.inject(`/api/jobs/${completed.id}`)).json()).toHaveProperty('inputs');
  });

  it('cancels a running worker within one second, discards staging and continues its queue', async () => {
    const { directory, jobDirectory } = await fixture({ dense: true, startCount: 2 });
    const app = await openApp(directory, jobDirectory);
    const slow = (await submit(app, { ...query, distance: [600, 2600], gain: [0, 1000] })).json() as JobSnapshot;
    const next = (await submit(app)).json() as JobSnapshot;
    expect(next.status).toBe('queued');
    const before = performance.now();
    const cancelRequest = app.inject({ method: 'POST', url: `/api/jobs/${slow.id}/cancel` });
    await new Promise(resolve => setTimeout(resolve, 0));
    const concurrentDelete = app.inject({ method: 'DELETE', url: `/api/jobs/${slow.id}` });
    const cancelled = (await cancelRequest).json() as JobSnapshot;
    expect(performance.now() - before).toBeLessThan(1000);
    expect(cancelled.status).toBe('cancelled');
    expect((await concurrentDelete).statusCode).toBe(204);
    expect((await app.inject(`/api/jobs/${slow.id}/results`)).statusCode).toBe(404);
    expect((await readdir(jobDirectory)).some(file => file.startsWith(slow.id))).toBe(false);
    expect((await finished(app, next)).status).toBe('completed');
  });

  it('interrupts active work on restart while automatically running previously queued requests', async () => {
    const { directory, jobDirectory } = await fixture({ dense: true });
    let app = await openApp(directory, jobDirectory);
    const first = (await submit(app, { ...query, distance: [600, 2600], gain: [0, 1000] })).json() as JobSnapshot;
    const queued = (await submit(app)).json() as JobSnapshot;
    expect(queued.status).toBe('queued');
    await app.close();
    app = await openApp(directory, jobDirectory);
    const interrupted = (await app.inject(`/api/jobs/${first.id}`)).json() as JobSnapshot;
    expect(interrupted.status).toBe('interrupted');
    expect(interrupted.query).toEqual(first.query);
    expect((await app.inject(`/api/jobs/${first.id}/locations`)).statusCode).toBe(409);
    expect((await finished(app, queued)).status).toBe('completed');
  });

  it('allows one app to own a job directory and releases ownership when it closes', async () => {
    const { directory, jobDirectory } = await fixture();
    const app = await openApp(directory, jobDirectory);
    const { createApp } = await import('../../dist/server/server.js');
    await expect(createApp(directory, undefined, jobDirectory)).rejects.toThrow('already using this job storage');
    await app.close();
    const reopened = await openApp(directory, jobDirectory);
    expect((await reopened.inject('/api/jobs')).json()).toEqual([]);
  });

  it('recovers an actually killed app process, discards its active work and continues its saved queue', async () => {
    const { directory, jobDirectory } = await fixture({ dense: true });
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      const { createApp } = await import(process.env.ALPINE_TEST_SERVER);
      const app = await createApp(process.env.ALPINE_TEST_DATA, undefined, process.env.ALPINE_TEST_JOBS);
      const query = JSON.parse(process.env.ALPINE_TEST_QUERY);
      const first = (await app.inject({ method: 'POST', url: '/api/jobs', payload: { ...query, distance: [600, 2600], gain: [0, 1000] } })).json();
      const queued = (await app.inject({ method: 'POST', url: '/api/jobs', payload: query })).json();
      console.log(JSON.stringify({ first, queued }));
      setInterval(() => {}, 1000);
    `], { env: { ...process.env, ALPINE_TEST_SERVER: new URL('../../dist/server/server.js', import.meta.url).href,
      ALPINE_TEST_DATA: directory, ALPINE_TEST_JOBS: jobDirectory, ALPINE_TEST_QUERY: JSON.stringify(query) }, stdio: ['ignore', 'pipe', 'pipe'] });
    cleanup.push(async () => {
      if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
    });
    const admitted = await new Promise<{ first: JobSnapshot; queued: JobSnapshot }>((resolve, reject) => {
      let output = '', errors = '';
      child.stdout.on('data', chunk => {
        output += chunk.toString();
        const line = output.split('\n').find(line => line.startsWith('{'));
        if (line) { try { resolve(JSON.parse(line)); } catch { /* Await the remainder of a split line. */ } }
      });
      child.stderr.on('data', chunk => { errors += chunk.toString(); });
      child.on('error', reject);
      child.on('exit', () => reject(new Error(`Fixture app exited before admitting its jobs: ${errors}`)));
    });
    expect(admitted.first.status).toBe('running');
    expect(admitted.queued.status).toBe('queued');
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    const app = await openApp(directory, jobDirectory);
    expect((await app.inject(`/api/jobs/${admitted.first.id}`)).json().status).toBe('interrupted');
    expect((await app.inject(`/api/jobs/${admitted.first.id}/results`)).statusCode).toBe(409);
    expect((await readdir(jobDirectory)).some(file => file.startsWith(admitted.first.id))).toBe(false);
    expect((await finished(app, admitted.queued)).status).toBe('completed');
  });

  it('does not publish an orphan result file after a crash before the metadata completion transaction', async () => {
    const { directory, jobDirectory } = await fixture();
    let app = await openApp(directory, jobDirectory);
    const job = await finished(app, (await submit(app)).json());
    expect(job.status).toBe('completed');
    await app.close();
    // This is the durable state of a crash between file rename and metadata publication.
    const metadata = new DatabaseSync(join(jobDirectory, 'metadata.sqlite'));
    const unpublished = { ...job, status: 'running' };
    delete unpublished.resultsRevision;
    metadata.prepare('UPDATE jobs SET snapshot = ? WHERE id = ?').run(JSON.stringify(unpublished), job.id);
    metadata.close();
    app = await openApp(directory, jobDirectory);
    expect((await app.inject(`/api/jobs/${job.id}`)).json().status).toBe('interrupted');
    expect((await app.inject(`/api/jobs/${job.id}/results`)).statusCode).toBe(409);
    expect((await readdir(jobDirectory)).some(file => file.startsWith(job.id))).toBe(false);
  });

  it('fails on changed inputs during execution and discards unfinished results', async () => {
    const { directory, jobDirectory, missingTopology } = await fixture({ dense: true });
    const app = await openApp(directory, jobDirectory);
    const initial = (await submit(app, { ...query, distance: [600, 2600], gain: [0, 1000] })).json() as JobSnapshot;
    const deadline = Date.now() + 3000;
    let state = initial;
    while (state.progress.stage !== 'searching' && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 20)); state = (await app.inject(`/api/jobs/${initial.id}`)).json();
    }
    expect(state.progress.stage).toBe('searching');
    await rm(missingTopology);
    const failed = await finished(app, state);
    expect(failed.status).toBe('failed');
    expect(failed.reason).toMatch(/removed|missing|changed/i);
    expect((await app.inject(`/api/jobs/${failed.id}/results`)).statusCode).toBe(409);
    expect((await readdir(jobDirectory)).some(file => file.startsWith(failed.id))).toBe(false);
  });

  it('rejects malformed queries, unfinished deletes, absent jobs and cross-origin mutations', async () => {
    const { directory, jobDirectory } = await fixture();
    const app = await openApp(directory, jobDirectory);
    for (const sections of [null, [], ['fixture-0', 'fixture-0'], [42], ['unknown']]) {
      expect((await submit(app, { ...query, sections } as never)).statusCode).toBe(400);
    }
    expect((await submit(app, { ...query, distance: [100, 10] })).statusCode).toBe(400);
    expect((await submit(app, { ...query, effort: 'unbounded' } as never)).statusCode).toBe(400);
    expect((await submit(app, { ...query, effort: 'normal' })).statusCode).toBe(400);
    expect((await app.inject('/api/jobs/expired')).statusCode).toBe(404);
    expect((await app.inject('/api/search')).statusCode).toBe(404);
    for (const method of ['POST', 'DELETE'] as const) {
      expect((await app.inject({ method, url: method === 'POST' ? '/api/jobs' : '/api/jobs/expired', payload: method === 'POST' ? query : undefined,
        headers: { origin: 'https://elsewhere.example' } })).statusCode).toBe(403);
    }
    expect((await app.inject('/api/jobs')).json()).toEqual([]);
  });
});

it('preserves missing-data download flow and submits the unchanged request after download', async () => {
  const source = await fixture();
  const service = createServer(async (request, response) => {
    try {
      const path = request.url?.slice(1);
      if (!path || !Object.values(source.catalog.sections[0]!.files).some(f => f.path === path)) { response.writeHead(404).end(); return; }
      response.end(await readFile(join(source.directory, path)));
    } catch { response.writeHead(500).end(); }
  });
  await new Promise<void>(resolve => service.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise<void>((resolve, reject) => service.close(error => error ? reject(error) : resolve())));
  const address = service.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture service');
  const directory = await mkdtemp(join(tmpdir(), 'alpine-empty-install-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'catalog.json'), JSON.stringify({ ...source.catalog, baseUrl: `http://127.0.0.1:${address.port}/` }));
  const app = await openApp(directory, source.jobDirectory);
  const required = (await app.inject({ method: 'POST', url: '/api/coverage', payload: query })).json();
  expect(required).toMatchObject({ sections: ['fixture-0'], missing: ['fixture-0'] });
  expect((await submit(app)).statusCode).toBe(409);
  expect((await app.inject('/api/jobs')).json()).toEqual([]);
  const initial = await app.inject({ method: 'POST', url: '/api/downloads', payload: { sections: required.missing } });
  expect(initial.statusCode).toBe(202);
  let download = initial.json();
  const deadline = Date.now() + 3000;
  while (download.status === 'running' && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 20)); download = (await app.inject('/api/downloads')).json();
  }
  expect(download).toMatchObject({ status: 'complete', completedBytes: required.bytes, totalBytes: required.bytes });
  const job = await finished(app, (await submit(app)).json());
  expect(job).toMatchObject({ status: 'completed', query: { ...query, effort: 'deep', roads: { distance: 1609.344, fraction: .1 } }, groupCount: 1 });
});
