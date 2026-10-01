import { afterEach, describe, expect, it } from 'vitest';
import { rename, rm } from 'node:fs/promises';
import { createApp } from '../../src/server.js';
import { ROUTES_PER_PAGE, type RouteView, type SearchSnapshot } from '../../src/model.js';
import { createNetworkFixture, query } from './network-fixture.js';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const remove of cleanup.splice(0).reverse()) await remove(); });

async function fixture(options: Parameters<typeof createNetworkFixture>[0] = {}) {
  const data = await createNetworkFixture(options);
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
  it('preserves starting points and directions through grouped pages, inspection and GPX across cells', async () => {
    const count = ROUTES_PER_PAGE + 1;
    const { directory, geometryDirectory, firstLoop } = await fixture({ startCount: count, routeCount: count,
      connectorSections: [0], directional: true });
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
    expect(snapshot.routeCount).toBe(count * count); // Each original start remains available; full reversals share one option.
    expect(snapshot.groupCount).toBe(count);
    expect(snapshot.pageTotal).toBe(count);
    expect(snapshot.groupId).toBeUndefined();
    expect(snapshot.selectionNote).toContain('every starting point and path');
    expect(snapshot.progress).toMatchObject({ totalStarts: count, attemptedStarts: count, completedStarts: count });
    const lastPage = (await app.inject(`/api/search/${id}?offset=${ROUTES_PER_PAGE}`)).json() as SearchSnapshot;
    expect(lastPage.routes).toHaveLength(1);
    expect(lastPage.offset).toBe(ROUTES_PER_PAGE);
    expect(lastPage.pageTotal).toBe(count);
    const representatives = [...snapshot.routes, ...lastPage.routes];
    expect(new Set(representatives.map(route => route.groupId)).size).toBe(count);
    expect(representatives.every(route => route.groupSize === count)).toBe(true);
    const groupId = representatives.find(route => route.roadDistance === 200)!.groupId;
    const scope = `group=${groupId}&offset=${ROUTES_PER_PAGE}`;
    const members = (await app.inject(`/api/search/${id}?group=${groupId}`)).json() as SearchSnapshot;
    const memberLastPage = (await app.inject(`/api/search/${id}?${scope}`)).json() as SearchSnapshot;
    expect(members).toMatchObject({ groupId, pageTotal: count, routeCount: count * count, groupCount: count, offset: 0 });
    expect(members.routes).toHaveLength(ROUTES_PER_PAGE);
    expect(memberLastPage).toMatchObject({ groupId, pageTotal: count, offset: ROUTES_PER_PAGE });
    expect(memberLastPage.routes).toHaveLength(1);
    const options = [...members.routes, ...memberLastPage.routes];
    expect(new Set(options.map(route => route.startId))).toEqual(new Set(Array.from({ length: count }, (_, i) => `start-${i}`)));
    expect(new Set(options.map(route => route.id)).size).toBe(count);
    // Startup, worker search and summaries have succeeded with all drawings absent.
    await rename(heldGeometry, geometryDirectory);
    for (const summary of [members.routes[0]!, memberLastPage.routes[0]!]) {
      expect(summary).not.toHaveProperty('geometry');
      expect(summary).not.toHaveProperty('edges');
      const route = (await app.inject(`/api/search/${id}/routes/${summary.id}`)).json() as RouteView;
      expect(route.id).toHaveLength(32);
      expect(route.reverseId).toBeTruthy();
      const reverse = (await app.inject(`/api/search/${id}/routes/${route.reverseId}`)).json() as RouteView;
      expect(reverse.reverseId).toBe(route.id);
      expect(reverse.geometry).toEqual(route.geometry.toReversed());
      const publicDirection = [route, reverse].find(direction => !direction.uncertain)!;
      const uncertainDirection = [route, reverse].find(direction => direction.uncertain)!;
      expect(publicDirection.gain).toBe(60);
      expect(publicDirection.geometry).toEqual(firstLoop);
      expect(uncertainDirection.gain).toBe(80);
      expect(uncertainDirection.geometry).toEqual(firstLoop.toReversed());
      for (const direction of [route, reverse]) {
        expect(direction).toMatchObject({ startId: summary.startId, groupId, groupSize: count, distance: 600, roadDistance: 200 });
        expect(direction.geometry.some(point => point[0] > query.area[2]!)).toBe(true);
        const exported = await app.inject(`/api/search/${id}/routes/${direction.id}.gpx`);
        expect(exported.statusCode).toBe(200);
        expect(exported.headers['content-type']).toContain('application/gpx+xml');
        expect(exported.body).toContain(`Creek &amp; Ridge &lt;loop&gt; ${summary.startId.slice('start-'.length)}`);
        const points = [...exported.body.matchAll(/<trkpt lat="([^"]+)" lon="([^"]+)"><ele>([^<]+)<\/ele><\/trkpt>/g)]
          .map(([, lat, lon, elevation]) => [Number(lon), Number(lat), Number(elevation)]);
        expect(points).toEqual(direction.geometry);
      }
    }
    expect((await app.inject(`/api/search/${id}`)).json()).toEqual(snapshot);
    expect((await app.inject('/api/search')).json()).toEqual(snapshot);
    expect((await app.inject(`/api/search/${id}?${scope}`)).json()).toEqual(memberLastPage);
    expect((await app.inject({ method: 'POST', url: `/api/search/${id}/stop?${scope}` })).json()).toEqual(memberLastPage);
    const oneDirection = await app.inject({ method: 'POST', url: '/api/search', payload: { ...criteria, gain: [0, 70] } });
    expect(oneDirection.statusCode).toBe(202);
    const constrained = await finished(app, oneDirection.json());
    expect(constrained.status).toBe('complete');
    expect(constrained.routeCount).toBe(count * count);
    const single = constrained.routes.find(route => route.roadDistance === 200)!;
    expect(single.reverseId).toBeUndefined();
    const singleView = (await app.inject(`/api/search/${constrained.id}/routes/${single.id}`)).json() as RouteView;
    expect(singleView).toMatchObject({ gain: 60, uncertain: false, geometry: firstLoop });
    expect(singleView.reverseId).toBeUndefined();
    const replacement = await app.inject({ method: 'POST', url: '/api/search', payload: { ...criteria, roads: { distance: 0, fraction: 0 } } });
    expect(replacement.statusCode).toBe(202);
    expect((await app.inject('/api/search')).json().id).toBe(replacement.json().id);
    expect((await app.inject(`/api/search/${id}`)).statusCode).toBe(404);
    const trailOnly = await finished(app, replacement.json());
    expect(trailOnly.routeCount).toBe(count * ROUTES_PER_PAGE);
    expect(trailOnly.groupCount).toBe(ROUTES_PER_PAGE);
    expect(trailOnly.pageTotal).toBe(ROUTES_PER_PAGE);
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
    const { directory } = await fixture({ dense: true, startCount: 2 });
    const { createApp: builtApp } = await import('../../dist/server/server.js');
    const app = await builtApp(directory);
    cleanup.push(() => app.close());
    const response = await app.inject({ method: 'POST', url: '/api/search', payload: { ...query, distance: [600, 2600], gain: [0, 1000] } });
    let snapshot = response.json() as SearchSnapshot;
    const deadline = Date.now() + 3000;
    while (!snapshot.routes.some(route => route.groupSize === 2) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 20));
      snapshot = (await app.inject(`/api/search/${snapshot.id}`)).json();
    }
    expect(snapshot.status).toBe('running');
    const groupId = snapshot.routes.find(route => route.groupSize === 2)!.groupId;
    const scope = `group=${groupId}&offset=0`;
    expect((await app.inject('/api/search')).json()).toMatchObject({ id: snapshot.id, query: snapshot.query });
    expect((await app.inject(`/api/search/${snapshot.id}?${scope}`)).json()).toMatchObject({ groupId, pageTotal: 2, offset: 0 });
    const before = performance.now();
    const stopped = (await app.inject({ method: 'POST', url: `/api/search/${snapshot.id}/stop?${scope}` })).json() as SearchSnapshot;
    expect(performance.now() - before).toBeLessThan(1000);
    expect(stopped.status).toBe('stopped');
    expect(stopped.reason).toContain('unfinished');
    expect(stopped).toMatchObject({ groupId, pageTotal: 2, offset: 0 });
    expect((await app.inject(`/api/search/${snapshot.id}?${scope}`)).json()).toEqual(stopped);
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
