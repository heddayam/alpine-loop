import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  it('preserves starting points and directions through grouped pages, inspection and GPX from an independent section', async () => {
    const count = ROUTES_PER_PAGE + 1;
    const { directory, firstLoop } = await fixture({ startCount: count, routeCount: count,
      connectorSections: [0], directional: true });
    const criteria = { ...query, roads: { distance: 200, fraction: 1 / 3 } };
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
    expect(snapshot.selectionNote).toContain('representative choices');
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
    expect(new Set(options.map(route => route.startId))).toEqual(new Set(Array.from({ length: count }, (_, i) => `fixture-0/start-${i}`)));
    expect(new Set(options.map(route => route.id)).size).toBe(count);
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
        const exported = await app.inject(`/api/search/${id}/routes/${direction.id}.gpx`);
        expect(exported.statusCode).toBe(200);
        expect(exported.headers['content-type']).toContain('application/gpx+xml');
        expect(exported.body).toContain(`Creek &amp; Ridge &lt;loop&gt; ${summary.startId.split('start-')[1]}`);
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
    for (const sections of [null, [], ['fixture-0', 'fixture-0'], [42], ['unknown'], ['fixture-0', 'unknown']]) {
      const response = await app.inject({ method: 'POST', url: '/api/search', payload: { ...query, sections } });
      expect(response.statusCode).toBe(400);
      expect((await app.inject('/api/search')).json()).toBeNull();
    }
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

  it('requires the complete selected section before admitting a search', async () => {
    const { directory, missingTopology, catalog } = await fixture();
    await rm(missingTopology);
    const { createApp: builtApp } = await import('../../dist/server/server.js');
    const app = await builtApp(directory);
    cleanup.push(() => app.close());
    const response = await app.inject({ method: 'POST', url: '/api/search', payload: query });
    expect(response.statusCode).toBe(409);
    expect(response.json().missing).toEqual(['fixture-0']);
    expect((await app.inject('/api/search')).json()).toBeNull();
    await writeFile(missingTopology, Buffer.alloc(catalog.sections[0]!.files.graph.bytes));
    const view = await app.inject('/api/catalog');
    expect(view.statusCode).toBe(200);
    expect(view.json().sections[0]).toMatchObject({ installed: false, needsRepair: true });
    expect((await app.inject({ method: 'POST', url: '/api/search', payload: query })).statusCode).toBe(409);
  });

  it('selects exact region identities despite overlapping bounds and unavailable neighboring data', async () => {
    const { directory, catalog } = await fixture({ sectionCount: 2, startCount: 2 });
    // Their bounding rectangles overlap. The missing neighbor must neither enlarge scope nor require a download.
    await rm(join(directory, catalog.sections[1]!.files.graph.path));
    const { createApp: builtApp } = await import('../../dist/server/server.js');
    const app = await builtApp(directory);
    cleanup.push(() => app.close());
    const coverage = (await app.inject({ method: 'POST', url: '/api/coverage', payload: query })).json();
    expect(coverage).toEqual({ sections: ['fixture-0'], missing: [], bytes: 0 });
    const response = await app.inject({ method: 'POST', url: '/api/search', payload: query });
    expect(response.statusCode).toBe(202);
    const snapshot = await finished(app, response.json());
    expect(snapshot.status).toBe('complete');
    expect(snapshot.query.sections).toEqual(['fixture-0']);
    expect(snapshot.progress).toMatchObject({ totalStarts: 2, attemptedStarts: 2, completedStarts: 2 });
    expect(snapshot.routes.every(route => route.startId.startsWith('fixture-0/'))).toBe(true);
    const neighbor = (await app.inject({ method: 'POST', url: '/api/coverage', payload: { ...query, sections: ['fixture-1'] } })).json();
    expect(neighbor).toMatchObject({ sections: ['fixture-1'], missing: ['fixture-1'] });
  });
});

it('explores independent section graphs without joining their local identities', async () => {
  const { directory } = await fixture({ sectionCount: 2 });
  const { createApp: builtApp } = await import('../../dist/server/server.js');
  const app = await builtApp(directory); cleanup.push(() => app.close());
  const criteria = { ...query, sections: ['fixture-0', 'fixture-1'] };
  const coverage = (await app.inject({ method: 'POST', url: '/api/coverage', payload: criteria })).json();
  expect(coverage).toMatchObject({ sections: ['fixture-0','fixture-1'], missing: [], bytes: 0 });
  const response = await app.inject({ method: 'POST', url: '/api/search', payload: criteria });
  expect(response.statusCode).toBe(202);
  const snapshot = await finished(app, response.json());
  expect(snapshot.status).toBe('complete');
  expect(snapshot.progress).toMatchObject({ totalStarts: 2, attemptedStarts: 2, completedStarts: 2 });
  expect(snapshot.groupCount).toBe(2);
  expect(new Set(snapshot.routes.map(route => route.startId))).toEqual(new Set(['fixture-0/start-0','fixture-1/start-0']));
  for (const summary of snapshot.routes) {
    const response = await app.inject(`/api/search/${snapshot.id}/routes/${summary.id}`);
    expect(response.statusCode).toBe(200);
    const route = response.json() as RouteView;
    expect(route.geometry[0]).toEqual(route.geometry.at(-1));
    const range = route.geometry.map(p => p[0]);
    expect(Math.max(...range) - Math.min(...range)).toBeLessThan(.002);
  }
});

it('downloads missing sections then searches the unchanged request through the built app', async () => {
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
  if (!address || typeof address === 'string') throw new Error('Missing local fixture service');
  const directory = await mkdtemp(join(tmpdir(), 'alpine-empty-install-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'catalog.json'), JSON.stringify({ ...source.catalog, baseUrl: `http://127.0.0.1:${address.port}/` }));
  const { createApp: builtApp } = await import('../../dist/server/server.js');
  const app = await builtApp(directory); cleanup.push(() => app.close());
  const catalog = (await app.inject('/api/catalog')).json();
  expect(catalog.sections[0].installed).toBe(false);
  const required = (await app.inject({ method: 'POST', url: '/api/coverage', payload: query })).json();
  expect(required).toMatchObject({ sections: ['fixture-0'], missing: ['fixture-0'], bytes: catalog.sections[0].bytes });
  expect((await app.inject({ method: 'POST', url: '/api/search', payload: query })).statusCode).toBe(409);
  const initial = await app.inject({ method: 'POST', url: '/api/downloads', payload: { sections: required.missing } });
  expect(initial.statusCode).toBe(202);
  expect(initial.json().status).toBe('running');
  let download = initial.json();
  const deadline = Date.now() + 3000;
  while (download.status === 'running' && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 20));
    download = (await app.inject('/api/downloads')).json();
  }
  expect(download).toMatchObject({ status: 'complete', completedBytes: required.bytes, totalBytes: required.bytes });
  expect((await app.inject('/api/catalog')).json().sections[0].installed).toBe(true);
  const response = await app.inject({ method: 'POST', url: '/api/search', payload: query });
  expect(response.statusCode).toBe(202);
  const snapshot = await finished(app, response.json());
  expect(snapshot).toMatchObject({ status: 'complete', query: { ...query, roads: { distance: 1609.344, fraction: .1 } }, routeCount: 1 });
  const route = await app.inject(`/api/search/${snapshot.id}/routes/${snapshot.routes[0]!.id}.gpx`);
  expect(route.statusCode).toBe(200);
  expect(route.body).toContain('<trkpt');
});
