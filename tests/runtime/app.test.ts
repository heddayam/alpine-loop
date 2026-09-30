import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createApp } from '../../src/server.js';
import { createSearches } from '../../dist/server/searches.js';
import { readDataset } from '../../src/dataset.js';
import type { SearchQuery, SearchSnapshot, TrailGraph, TrailGeometry } from '../../src/model.js';

const query: SearchQuery = { area: [-122.001, 46.999, -121.999, 47.001], distance: [600, 600], gain: [0, 100], repetition: 0, includeUnknown: true };
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const remove of cleanup.splice(0).reverse()) await remove(); });

async function fixture(dense = false) {
  const directory = await mkdtemp(join(tmpdir(), 'alpine-test-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const graph: TrailGraph = {
    version: 1,
    info: { id: 'fixture', name: 'Offline trails', bounds: [-122.01, 46.99, -121.95, 47.05], sourceDate: '2026-01-01', attribution: [], limitations: [], places: [], startCount: 1 },
    nodes: [[-122, 47, 100], [-121.99, 47.01, 120], [-121.98, 47, 100]], edges: [],
    starts: [{ id: 'start', node: 0, name: 'Creek & Ridge <loop>', access: 'public' }],
  };
  const geometry: TrailGeometry[] = [];
  if (dense) for (let i = 3; i < 14; i++) graph.nodes.push([-122 + i / 10000, 47 + i / 10000]);
  const pairs = dense ? graph.nodes.flatMap((_, a) => graph.nodes.flatMap((_, b) => a < b ? [[a, b]] : [])) : [[0, 1], [1, 2], [2, 0]];
  for (const [from, to] of pairs as [number, number][]) {
    const trail = geometry.length;
    geometry.push({ id: String(trail), name: 'Creek & Ridge', coordinates: [graph.nodes[from]!, graph.nodes[to]!] });
    graph.edges.push({ from, to, trail, reverse: false, distance: 200, gain: 20, access: 'public' },
      { from: to, to: from, trail, reverse: true, distance: 200, gain: 20, access: 'public' });
  }
  await writeFile(join(directory, 'graph.json.gz'), gzipSync(JSON.stringify(graph)));
  await writeFile(join(directory, 'geometry.json.gz'), gzipSync(JSON.stringify(geometry)));
  return directory;
}

describe('real application integration', () => {
  it('serves exact worker results, keeps them across reconnect, and exports continuous GPX beyond the selected start area', async () => {
    const directory = await fixture();
    // Exercise the built worker, not a mocked solver or development TS loader.
    const { createApp: builtApp } = await import('../../dist/server/server.js');
    const app = await builtApp(directory);
    cleanup.push(() => app.close());
    expect((await app.inject('/api/catalog')).json().id).toBe('fixture');
    const response = await app.inject({ method: 'POST', url: '/api/search', payload: query });
    expect(response.statusCode).toBe(202);
    const id = response.json().id;
    let snapshot = response.json() as SearchSnapshot;
    const deadline = Date.now() + 3000;
    while (snapshot.status === 'running' && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 20));
      snapshot = (await app.inject(`/api/search/${id}`)).json();
    }
    expect(snapshot.status).toBe('complete');
    expect(snapshot.routes).toHaveLength(2);
    expect(snapshot.progress).toMatchObject({ totalStarts: 1, attemptedStarts: 1, completedStarts: 1 });
    for (const route of snapshot.routes) {
      expect(route.id).toHaveLength(32);
      expect(route.distance).toBe(600);
      expect(route.gain).toBe(60);
      expect(route.geometry[0]).toEqual(route.geometry.at(-1));
      expect(route.geometry.some(point => point[0] > query.area[2]!)).toBe(true);
    }
    expect((await app.inject(`/api/search/${id}`)).json()).toEqual(snapshot);
    const exported = await app.inject(`/api/search/${id}/routes/${snapshot.routes[0]!.id}.gpx`);
    expect(exported.statusCode).toBe(200);
    expect(exported.headers['content-type']).toContain('application/gpx+xml');
    expect(exported.body).toContain('Creek &amp; Ridge &lt;loop&gt;');
    expect(exported.body.match(/<trkpt /g)).toHaveLength(4);
    expect(exported.body).toContain('<ele>120</ele>');
  });

  it('rejects malformed constraints and reports expired searches without starting work', async () => {
    const app = await createApp(await fixture());
    cleanup.push(() => app.close());
    expect((await app.inject({ method: 'POST', url: '/api/search', payload: { ...query, distance: [100, 10] } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/search', payload: { ...query, area: null } })).statusCode).toBe(400);
    expect((await app.inject('/api/search/expired')).statusCode).toBe(404);
  });

  it('stops the actual worker promptly and retains an honest unfinished state', async () => {
    const directory = await fixture(true);
    const searches = createSearches(directory, await readDataset(directory), { maxResults: 10000, maxExpansions: 1e9, maxMilliseconds: 120000 });
    cleanup.push(() => searches.close());
    const snapshot = searches.start({ ...query, area: query.area as [number, number, number, number], distance: [10000, 20000], gain: [0, 1000] });
    await new Promise(resolve => setTimeout(resolve, 100));
    const before = performance.now();
    const stopped = await searches.stop(snapshot.id);
    expect(performance.now() - before).toBeLessThan(1000);
    expect(stopped.status).toBe('stopped');
    expect(stopped.reason).toContain('unfinished');
    expect(searches.get(snapshot.id)).toEqual(stopped);
  });
});
