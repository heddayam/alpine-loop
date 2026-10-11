import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { JobSnapshot, RouteView, SearchQuery } from '../../src/model.js';
import { createNetworkFixture, query } from './network-fixture.js';

type App = Awaited<ReturnType<typeof import('../../src/server.js').createApp>>;
type Headers = Record<string, string>;
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action(); });
const origin: [number, number] = [-123.45, 48.67];
const drivingQuery: SearchQuery = { ...query, driveTime: { minutes: 120, origin } };
const rectangle = (west: number, south: number, east: number, north: number) =>
  [[west, south], [west, north], [east, north], [east, south], [west, south]];
const broad = [rectangle(-124, 46, -120, 49)];
const response = (rings: number[][][]) => ({ value: { geometryType: 'esriGeometryPolygon',
  spatialReference: { wkid: 4326 }, features: [{ geometry: { rings } }] } });
function provider(rings = broad) {
  let submissions = 0;
  const fetcher: typeof fetch = async input => {
    const url = String(input);
    if (url.endsWith('/submitJob')) {
      submissions++;
      return Response.json({ jobId: 'offline_job', jobStatus: 'esriJobSucceeded' });
    }
    if (url.endsWith('/jobs/offline_job/results/service_areas')) return Response.json(response(rings));
    throw new Error(`Unexpected offline provider request: ${url}`);
  };
  return { fetch: fetcher, submissions: () => submissions };
}
async function fixture(options: Parameters<typeof createNetworkFixture>[0] = {}) {
  const data = await createNetworkFixture(options);
  const jobs = await mkdtemp(join(tmpdir(), 'alpine-driving-jobs-'));
  cleanup.push(() => rm(data.directory, { recursive: true, force: true }), () => rm(jobs, { recursive: true, force: true }));
  const open = async (fetcher: typeof fetch, hosted = false, apiKey = 'offline-api-key') => {
    // The app and every search worker run their built production code. Only the remote API is substituted.
    const { createApp } = await import('../../dist/server/server.js');
    const app = await createApp(data.directory, undefined, jobs,
      hosted ? { enabled: true, secret: 'offline-driving-persistent-secret-1234567890' } : {}, { apiKey, fetch: fetcher });
    cleanup.push(() => app.close());
    return app;
  };
  return { ...data, jobs, open };
}
const submit = (app: App, payload: object = drivingQuery, headers: Headers = {}) =>
  app.inject({ method: 'POST', url: '/api/jobs', payload, headers });
async function finished(app: App, id: string, headers: Headers = {}) {
  const deadline = Date.now() + 5000;
  for (;;) {
    const job = (await app.inject({ url: `/api/jobs/${id}`, headers })).json() as JobSnapshot;
    if (!['running', 'queued'].includes(job.status)) return job;
    if (Date.now() > deadline) throw new Error('Offline driving job did not finish');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
async function unpublished(app: App, id: string) {
  for (const suffix of ['/results', '/locations', '/paths?west=-124&south=46&east=-120&north=49'])
    expect((await app.inject(`/api/jobs/${id}${suffix}`)).statusCode).toBe(409);
}

describe('driving filters through the actual app and search worker', () => {
  it('filters holes and disconnected areas before choosing a start, allows hiking outside, and retains immutable compact results', async () => {
    const source = await fixture({ startCount: 3, startNodes: [0, 1, 2] });
    const api = provider([
      rectangle(-122.0006, 47.04995, -122.0004, 47.0501).reverse(), // Hole excludes the otherwise preferred start 0.
      rectangle(-123, 47.0499, -121, 48),
      rectangle(-121.9991, 47.0494, -121.9989, 47.0496), // Disconnected island includes start 2.
    ]);
    let app = await source.open(api.fetch);
    const accepted = await submit(app);
    expect(accepted.statusCode).toBe(202);
    const job = await finished(app, accepted.json().id);
    expect(job).toMatchObject({ status: 'completed', groupCount: 1, progress: { totalStarts: 2, completedStarts: 2 } });
    const page = (await app.inject(`/api/jobs/${job.id}/results`)).json();
    expect(page.routes).toHaveLength(1);
    expect(page.routes[0].startId).not.toBe('fixture-0/start-0');
    const routeURL = `/api/jobs/${job.id}/routes/${page.routes[0].id}`;
    const route = (await app.inject(routeURL)).json() as RouteView;
    expect(route.geometry).toContainEqual(source.firstLoop[0]); // A hike may leave its starting-point driving area.
    const area = job.inputs!.driveArea!;
    expect(area.geometry.type).toBe('MultiPolygon');
    expect(area.geometry.coordinates).toHaveLength(2);
    expect(area.geometry.coordinates.some(polygon => polygon.length === 2)).toBe(true);
    expect(Number.isFinite(Date.parse(area.resolvedAt))).toBe(true);
    for (const point of area.geometry.coordinates.flat(2)) {
      expect(point[0]!).toBeGreaterThanOrEqual(source.catalog.sections[0]!.bounds[0]);
      expect(point[0]!).toBeLessThanOrEqual(source.catalog.sections[0]!.bounds[2]);
      expect(point[1]!).toBeGreaterThanOrEqual(source.catalog.sections[0]!.bounds[1]);
      expect(point[1]!).toBeLessThanOrEqual(source.catalog.sections[0]!.bounds[3]);
    }
    expect((await app.inject(`/api/jobs/${job.id}?inputs=false`)).json()).not.toHaveProperty('inputs');
    for (const url of ['/api/jobs', '/api/jobs/history']) {
      const history = (await app.inject(url)).json();
      expect(JSON.stringify(history)).not.toContain('driveArea');
    }
    await app.close();
    await rm(source.directory, { recursive: true, force: true });
    app = await source.open(api.fetch);
    expect((await app.inject(`/api/jobs/${job.id}`)).json()).toEqual(job);
    expect((await app.inject(routeURL)).json()).toEqual(route);
    expect((await app.inject(`/api/jobs/${job.id}/results`)).json()).toEqual(page);
    expect(api.submissions()).toBe(1);
  });

  it('intersects a drawn search area and completes an empty intersection without widening the search', async () => {
    const source = await fixture({ startCount: 3, startNodes: [0, 1, 2] });
    const api = provider();
    const app = await source.open(api.fetch);
    const boundary: [number, number][] = rectangle(-121.9991, 47.0494, -121.9989, 47.0496).slice(0, -1) as [number, number][];
    const first = await finished(app, (await submit(app, { ...drivingQuery, boundary })).json().id);
    expect(first).toMatchObject({ status: 'completed', groupCount: 1, progress: { totalStarts: 1 } });
    expect((await app.inject(`/api/jobs/${first.id}/results`)).json().routes[0].startId).toBe('fixture-0/start-2');
    const points = first.inputs!.driveArea!.geometry.coordinates.flat(2);
    expect(points.every(point => point[0]! >= -121.9991 && point[0]! <= -121.9989 && point[1]! >= 47.0494 && point[1]! <= 47.0496)).toBe(true);
    const emptyAPI = provider([rectangle(-120, 46, -119, 47)]);
    await app.close();
    const reopened = await source.open(emptyAPI.fetch);
    const empty = await finished(reopened, (await submit(reopened)).json().id);
    expect(empty).toMatchObject({ status: 'completed', groupCount: 0, progress: { totalStarts: 0, completedStarts: 0 } });
    expect(empty.inputs!.driveArea!.geometry.coordinates).toEqual([]);
    expect((await reopened.inject(`/api/jobs/${empty.id}/results`)).json().routes).toEqual([]);
  });

  it('cancels a pending provider promptly, publishes no partial results, and continues FIFO work', async () => {
    const source = await fixture();
    let signal: AbortSignal | null | undefined;
    const pending: typeof fetch = async (_input, init) => {
      signal = init?.signal;
      return new Promise<Response>(() => {}); // Even a stalled remote request must not prevent cancellation.
    };
    const app = await source.open(pending);
    const first = (await submit(app)).json() as JobSnapshot;
    expect(first).toMatchObject({ status: 'running', progress: { stage: 'driving' } });
    const next = (await submit(app, query)).json() as JobSnapshot;
    expect(next.status).toBe('queued');
    await unpublished(app, first.id);
    const before = performance.now();
    const cancelled = (await app.inject({ method: 'POST', url: `/api/jobs/${first.id}/cancel` })).json();
    expect(performance.now() - before).toBeLessThan(1000);
    expect(cancelled.status).toBe('cancelled');
    expect(signal?.aborted).toBe(true);
    await unpublished(app, first.id);
    expect((await readdir(source.jobs)).some(file => file.startsWith(first.id))).toBe(false);
    expect((await finished(app, next.id)).status).toBe('completed');
  });

  it('fails closed when the provider is unavailable or returns malformed geometry', async () => {
    const source = await fixture();
    let app = await source.open(async () => new Response('Offline failure', { status: 503 }));
    const failed = await finished(app, (await submit(app)).json().id);
    expect(failed.status).toBe('failed');
    await unpublished(app, failed.id);
    await app.close();
    app = await source.open(async input => Response.json(String(input).endsWith('/submitJob')
      ? { jobId: 'offline_job', jobStatus: 'esriJobSucceeded' }
      : response([[[NaN, 0], [0, 1], [1, 1], [NaN, 0]]])));
    const malformed = await finished(app, (await submit(app)).json().id);
    expect(malformed.status).toBe('failed');
    await unpublished(app, malformed.id);
    expect((await app.inject(`/api/jobs/${malformed.id}`)).json()).not.toHaveProperty('resultsRevision');
    expect((await finished(app, (await submit(app, query)).json().id)).status).toBe('completed');
  });

  it('rejects unavailable configuration and invalid driving inputs before creating any jobs', async () => {
    const source = await fixture();
    const api = provider();
    let app = await source.open(api.fetch, false, '');
    expect((await app.inject('/api/catalog')).json().driveTimeAvailable).toBe(false);
    expect((await submit(app)).statusCode).toBe(503);
    expect((await app.inject('/api/jobs')).json()).toEqual([]);
    await app.close();
    app = await source.open(api.fetch);
    expect((await app.inject('/api/catalog')).json().driveTimeAvailable).toBe(true);
    for (const driveTime of [null, {}, { minutes: 120 }, { minutes: 4, origin }, { minutes: 241, origin },
      { minutes: 5.5, origin }, { minutes: '120', origin }, { minutes: 120, origin: [181, 47] },
      { minutes: 120, origin: [-122, 86] }, { minutes: 120, origin: [-122, 47, 1] }, { minutes: 120, origin: ['-122', 47] }])
      expect((await submit(app, { ...query, driveTime })).statusCode).toBe(400);
    expect((await app.inject('/api/jobs')).json()).toEqual([]);
    expect(api.submissions()).toBe(0);
  });

  it('redacts the origin on shared hosted results while retaining the owner query and only the selected area', async () => {
    const source = await fixture();
    const api = provider();
    const app = await source.open(api.fetch, true);
    const headers = (cookie?: string): Headers => ({ host: 'alpineloop.test', origin: 'https://alpineloop.test', ...(cookie ? { cookie } : {}) });
    const visitor = async () => String((await app.inject({ url: '/api/jobs', headers: headers() })).headers['set-cookie']).split(';')[0]!;
    const alice = headers(await visitor()), bob = headers(await visitor());
    const job = await finished(app, (await submit(app, drivingQuery, alice)).json().id, alice);
    expect(job).toMatchObject({ status: 'completed', canManage: true, query: { driveTime: { origin, minutes: 120 } } });
    const shared = (await app.inject({ url: `/api/jobs/${job.id}`, headers: bob })).json() as JobSnapshot;
    expect(shared).toMatchObject({ canManage: false, query: { driveTime: { minutes: 120 } } });
    expect(shared.query.driveTime).not.toHaveProperty('origin');
    expect(shared.inputs!.driveArea).toEqual(job.inputs!.driveArea);
    for (const point of shared.inputs!.driveArea!.geometry.coordinates.flat(2)) {
      expect(point[0]!).toBeGreaterThanOrEqual(-122.01);
      expect(point[0]!).toBeLessThanOrEqual(-121.99);
      expect(point[1]!).toBeGreaterThanOrEqual(47.04);
      expect(point[1]!).toBeLessThanOrEqual(47.06);
    }
    expect((await app.inject({ url: `/api/jobs/${job.id}/results`, headers: bob })).json().routes.length).toBeGreaterThan(0);
    expect((await app.inject({ method: 'DELETE', url: `/api/jobs/${job.id}`, headers: bob })).statusCode).toBe(403);
  });

  it('persists the aggregate monthly budget across deleting a job and restarting, without another provider call', async () => {
    const source = await fixture();
    const api = provider();
    let app = await source.open(api.fetch);
    await app.close();
    // Seed only closed storage: the final available billable request this UTC month.
    const db = new DatabaseSync(join(source.jobs, 'metadata.sqlite'));
    db.prepare('INSERT INTO driving_usage (month, used) VALUES (?, ?)').run(new Date().toISOString().slice(0, 7), 4499);
    db.close();
    app = await source.open(api.fetch);
    const finalAllowed = await finished(app, (await submit(app)).json().id);
    expect(finalAllowed.status).toBe('completed');
    expect(api.submissions()).toBe(1);
    expect((await app.inject({ method: 'DELETE', url: `/api/jobs/${finalAllowed.id}` })).statusCode).toBe(204);
    await app.close();
    app = await source.open(api.fetch);
    const overBudget = await finished(app, (await submit(app)).json().id);
    expect(overBudget.status).toBe('failed');
    expect(overBudget.reason).toMatch(/monthly.*allowance/i);
    expect(api.submissions()).toBe(1);
    await unpublished(app, overBudget.id);
    expect((await finished(app, (await submit(app, query)).json().id)).status).toBe('completed');
  });
});
