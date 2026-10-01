import { afterEach, describe, expect, it } from 'vitest';
import { rename, rm } from 'node:fs/promises';
import { createApp } from '../../src/server.js';
import { createSearches } from '../../dist/server/searches.js';
import { readDataset } from '../../src/dataset.js';
import { ROUTES_PER_PAGE, type HikeRoute, type SearchSnapshot } from '../../src/model.js';
import { createNetworkFixture, query } from './network-fixture.js';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const remove of cleanup.splice(0).reverse()) await remove(); });

async function fixture(dense = false, startCount = 1, routeCount = 1, connectorSections: number[] = []) {
  const data = await createNetworkFixture(dense, startCount, routeCount, connectorSections);
  cleanup.push(() => rm(data.directory, { recursive: true, force: true }));
  return data;
}

async function finished(app: Awaited<ReturnType<typeof createApp>>, initial: SearchSnapshot) {
  let snapshot = initial;
  const deadline = Date.now() + 3000;
  while (snapshot.status === 'running' && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 20));
    snapshot = (await app.inject(`/api/search/${snapshot.id}`)).json();
  }
  return snapshot;
}

describe('real application integration', () => {
  it('searches across cells without geometry, reconnects through pages, and exports GPX beyond the start area', async () => {
    const { directory, geometryDirectory } = await fixture(false, 2, ROUTES_PER_PAGE + 1, [0]);
    const criteria = { ...query, roads: { distance: 200, fraction: 1 / 3 } };
    const heldGeometry = `${geometryDirectory}-held`;
    await rename(geometryDirectory, heldGeometry);
    // Exercise the built worker, not a mocked solver or development TS loader.
    const { createApp: builtApp } = await import('../../dist/server/server.js');
    const app = await builtApp(directory);
    cleanup.push(() => app.close());
    expect((await app.inject('/api/catalog')).json().id).toBe('fixture');
    expect((await app.inject('/api/search')).json()).toBeNull();
    const response = await app.inject({ method: 'POST', url: '/api/search', payload: criteria });
    expect(response.statusCode).toBe(202);
    const id = response.json().id;
    const snapshot = await finished(app, response.json());
    expect(snapshot.status).toBe('complete');
    expect(snapshot.query.roads).toEqual(criteria.roads);
    expect(snapshot.routes).toHaveLength(ROUTES_PER_PAGE);
    expect(snapshot.routeCount).toBe(ROUTES_PER_PAGE + 1); // Neither reversal nor another start multiplies a hike.
    expect(snapshot.selectionNote).toContain('does not stop exploration');
    expect(snapshot.progress).toMatchObject({ totalStarts: 2, attemptedStarts: 2, completedStarts: 2 });
    const lastPage = (await app.inject(`/api/search/${id}?offset=${ROUTES_PER_PAGE}`)).json() as SearchSnapshot;
    expect(lastPage.routes).toHaveLength(1);
    expect(lastPage.offset).toBe(ROUTES_PER_PAGE);
    // Startup, worker search and summaries have succeeded with all drawings absent.
    await rename(heldGeometry, geometryDirectory);
    for (const summary of [snapshot.routes[0]!, lastPage.routes[0]!]) {
      expect(summary).not.toHaveProperty('geometry');
      expect(summary).not.toHaveProperty('edges');
      const route = (await app.inject(`/api/search/${id}/routes/${summary.id}`)).json() as HikeRoute;
      expect(route.id).toHaveLength(32);
      expect(route.distance).toBe(600);
      expect(route.gain).toBe(60);
      expect(route.roadDistance).toBe(summary === snapshot.routes[0] ? 200 : 0);
      expect(route.geometry[0]).toEqual(route.geometry.at(-1));
      expect(route.geometry.some(point => point[0] > query.area[2]!)).toBe(true);
    }
    expect((await app.inject(`/api/search/${id}`)).json()).toEqual(snapshot);
    expect((await app.inject('/api/search')).json()).toEqual(snapshot);
    const exported = await app.inject(`/api/search/${id}/routes/${lastPage.routes[0]!.id}.gpx`);
    expect(exported.statusCode).toBe(200);
    expect(exported.headers['content-type']).toContain('application/gpx+xml');
    expect(exported.body).toContain('Creek &amp; Ridge &lt;loop&gt;');
    expect(exported.body.match(/<trkpt /g)).toHaveLength(4);
    expect(exported.body).toContain('<ele>120</ele>');
    const replacement = await app.inject({ method: 'POST', url: '/api/search', payload: { ...criteria, roads: { distance: 0, fraction: 0 } } });
    expect(replacement.statusCode).toBe(202);
    expect((await app.inject('/api/search')).json().id).toBe(replacement.json().id);
    expect((await app.inject(`/api/search/${id}`)).statusCode).toBe(404);
    const trailOnly = await finished(app, replacement.json());
    expect(trailOnly.routeCount).toBe(ROUTES_PER_PAGE);
    expect(trailOnly.routes.every(route => route.roadDistance === 0)).toBe(true);
  });

  it('rejects malformed constraints and reports expired searches without starting work', async () => {
    const app = await createApp((await fixture()).directory);
    cleanup.push(() => app.close());
    expect((await app.inject({ method: 'POST', url: '/api/search', payload: { ...query, distance: [100, 10] } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/search', payload: { ...query, area: null } })).statusCode).toBe(400);
    expect((await app.inject('/api/search/expired')).statusCode).toBe(404);
  });

  it('stops the actual worker promptly and retains an honest unfinished state', async () => {
    const { directory } = await fixture(true);
    const searches = createSearches(directory, await readDataset(directory));
    cleanup.push(() => searches.close());
    const snapshot = searches.start({ ...query, distance: [10000, 20000], gain: [0, 1000] });
    await new Promise(resolve => setTimeout(resolve, 100));
    const before = performance.now();
    const stopped = await searches.stop(snapshot.id);
    expect(performance.now() - before).toBeLessThan(1000);
    expect(stopped.status).toBe('stopped');
    expect(stopped.reason).toContain('unfinished');
    expect(searches.get(snapshot.id)).toEqual(stopped);
  });

  it('reports missing declared topology as a failure rather than a completed empty search', async () => {
    const { directory, missingTopology } = await fixture();
    await rm(missingTopology);
    const { createApp: builtApp } = await import('../../dist/server/server.js');
    const app = await builtApp(directory);
    cleanup.push(() => app.close());
    const response = await app.inject({ method: 'POST', url: '/api/search', payload: query });
    expect(response.statusCode).toBe(202);
    const snapshot = await finished(app, response.json());
    expect(snapshot.status).toBe('failed');
    expect(snapshot.reason).toBeTruthy();
  });

  it('keeps source-boundary incompleteness visible after exhausting the available graph', async () => {
    const { directory } = await fixture();
    const { createApp: builtApp } = await import('../../dist/server/server.js');
    const app = await builtApp(directory);
    cleanup.push(() => app.close());
    const response = await app.inject({ method: 'POST', url: '/api/search', payload: { ...query, distance: [600, 20000] } });
    expect(response.statusCode).toBe(202);
    const snapshot = await finished(app, response.json());
    expect(snapshot.status).toBe('limited');
    expect(snapshot.coverageNote).toBeTruthy();
    expect(snapshot.progress).toMatchObject({ totalStarts: 1, attemptedStarts: 1, completedStarts: 1 });
    expect(snapshot.routeCount).toBe(1);
  });
});
