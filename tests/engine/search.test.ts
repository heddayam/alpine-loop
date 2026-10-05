import { describe, expect, it } from 'vitest';
import type { RouteCandidate, SearchEvent, SearchQuery, TrailGraph } from '../../src/model.js';
import { search } from '../../src/engine/search.js';
import { enumerate, fixture } from './oracle.js';

const query: SearchQuery = { sections: ['fixture'], distance: [0, 10_000], gain: [0, 10_000], repetition: 1, includeUnknown: true };
const key = (route: { start: number; edges: number[] }) => `${route.start}:${route.edges.join(',')}`;
async function collect(graph: TrailGraph, criteria = query, options: Parameters<typeof search>[2] = {}) {
  const events: SearchEvent[] = [];
  for await (const event of search(graph, criteria, options)) events.push(event);
  const routes = events.flatMap(event => event.type === 'route' ? [event.route] : []);
  const done = events.at(-1)!;
  if (done.type !== 'done') throw new Error('Missing terminal search event');
  return { events, routes, done };
}

async function compare(graph: TrailGraph, criteria = query) {
  const expected = enumerate(graph, criteria);
  const { routes, done } = await collect(graph, criteria, { sliceExpansions: 100_000 });
  expect(done.status).toBe('complete');
  expect(done.progress.attemptedStarts).toBe(done.progress.totalStarts);
  expect(done.progress.completedStarts).toBe(done.progress.totalStarts);
  expect(routes.map(key).sort()).toEqual(expected.map(key).sort());
  expect(new Set(routes.map(route => route.id)).size).toBe(routes.length);
  const byId = new Map(expected.map(route => [key(route), route]));
  for (const route of routes) {
    const reference = byId.get(key(route))!;
    expect([route.distance, route.gain, route.roadDistance, route.repetition])
      .toEqual([reference.distance, reference.gain, reference.roadDistance, reference.repetition]);
  }
  return routes;
}

describe('independent route oracle', () => {
  it('keeps physical parallel trails, self-loop corridors and direction-specific facts', async () => {
    const graph = fixture([
      [0, 1, 100, { gain: 10, backGain: 7, backDistance: 120 }],
      [0, 1, 150], [1, 1, 250], [0, 0, 200, { oneWay: true }],
    ]);
    const routes = await compare(graph);
    expect(routes.some(route => route.edges.length === 1)).toBe(true);
    expect(routes.some(route => route.edges.length === 2)).toBe(true);
    expect(routes.some(route => route.kind === 'lollipop')).toBe(true);
  });

  it('counts only the extra return traversal as repetition', async () => {
    const graph = fixture([[0, 1, 2_000], [1, 2, 2_000], [2, 3, 2_000], [3, 1, 2_000]]);
    const routes = await compare(graph, { ...query, distance: [10_000, 10_000], repetition: 0.2 });
    expect(routes).toHaveLength(2);
    expect(routes.every(route => route.repetition === 0.2 && route.kind === 'lollipop')).toBe(true);
    expect(await compare(graph, { ...query, repetition: 0.199 })).toHaveLength(0);
  });

  it('counts both road stem traversals while allowing a road prefix to be diluted by trails', async () => {
    const graph = fixture([[0, 1, 100, { connector: true, backDistance: 200 }],
      [1, 2, 900], [2, 3, 900], [3, 1, 900]]);
    const criteria = { ...query, distance: [3_000, 3_000] as SearchQuery['distance'], roads: { distance: 300, fraction: 0.1 } };
    const routes = await compare(graph, criteria);
    expect(routes).toHaveLength(2);
    expect(routes.every(route => route.roadDistance === 300 && route.kind === 'lollipop')).toBe(true);
    expect(await compare(graph, { ...criteria, roads: { distance: 299, fraction: 1 } })).toHaveLength(0);
    expect(await compare(graph, { ...criteria, roads: { distance: 300, fraction: 0.099 } })).toHaveLength(0);
  });

  it('applies both road defaults, zero limits and relaxation to the distance walked in each direction', async () => {
    const graph = fixture([
      [0, 1, 2_000, { connector: true, backDistance: 1_000 }], [1, 2, 9_000], [2, 0, 9_000],
      [0, 3, 200, { connector: true }], [3, 4, 400], [4, 0, 400], [0, 0, 3_000, { oneWay: true }],
    ]);
    const criteria = { ...query, distance: [0, 30_000] as SearchQuery['distance'] };
    // The long forward loop exceeds the default road distance; the short loop
    // exceeds its fraction. The long reverse loop and pure trail ring qualify.
    expect((await compare(graph, criteria)).map(route => route.roadDistance).sort((a, b) => a - b)).toEqual([0, 1_000]);
    for (const roads of [{ distance: 0, fraction: 1 }, { distance: 30_000, fraction: 0 }]) {
      expect((await compare(graph, { ...criteria, roads })).map(route => route.roadDistance)).toEqual([0]);
    }
    expect(await compare(graph, { ...criteria, roads: { distance: 2_000, fraction: 0.1 } })).toHaveLength(3);
    expect(await compare(graph, { ...criteria, roads: { distance: 1_000, fraction: 0.2 } })).toHaveLength(4);
    expect(await compare(graph, { ...criteria, roads: { distance: 2_000, fraction: 0.2 } })).toHaveLength(5);
  });

  it('retains longer alternative stems required by the minimum distance', async () => {
    const graph = fixture([[0, 1, 100], [0, 2, 75], [2, 1, 75], [1, 3, 300], [3, 4, 300], [4, 1, 300]]);
    const routes = await compare(graph, { ...query, distance: [1_180, 1_220] });
    expect(routes).toHaveLength(2);
    expect(routes.every(route => route.distance === 1_200)).toBe(true);
  });

  it('does not turn irreversible stems, extra lobes or pure retraces into routes', async () => {
    const graph = fixture([[0, 1, 100], [1, 2, 100], [2, 0, 100], [0, 3, 100, { oneWay: true }],
      [3, 4, 100], [4, 5, 100], [5, 3, 100], [0, 6, 100]]);
    const routes = await compare(graph);
    expect(routes).toHaveLength(2);
    expect(routes.every(route => route.kind === 'loop' && route.edges.length === 3)).toBe(true);
  });

  it('explores every supplied start regardless of location and applies unknown access to starts and edges', async () => {
    const graph = fixture([[0, 1, 100, { unknown: true }], [1, 2, 100], [2, 0, 100]], [0, 1]);
    graph.starts[1]!.access = 'unknown';
    graph.nodes[1] = [100, 80];
    const routes = await compare(graph);
    expect(routes).toHaveLength(4);
    expect(new Set(routes.map(route => route.start))).toEqual(new Set([0, 1]));
    expect(routes.every(route => route.uncertain)).toBe(true);
    const { done } = await collect(graph);
    expect(done.progress).toMatchObject({ totalStarts: 2, attemptedStarts: 2, completedStarts: 2 });
    expect(await compare(graph, { ...query, includeUnknown: false })).toHaveLength(0);
    graph.edges.forEach(edge => { edge.access = 'public'; });
    const publicRoutes = await compare(graph, { ...query, includeUnknown: false });
    expect(publicRoutes).toHaveLength(2);
    expect(publicRoutes.every(route => route.start === 0)).toBe(true);
    expect((await collect(graph, { ...query, includeUnknown: false })).done.progress)
      .toMatchObject({ totalStarts: 1, attemptedStarts: 1, completedStarts: 1 });
  });

  it('has no universal mileage cap and keeps strict decimal metric boundaries', async () => {
    const graph = fixture([[0, 1, 100_000.1], [1, 2, 100_000.2], [2, 0, 100_000.3]]);
    const forward = graph.edges.filter(edge => !edge.reverse).reduce((sum, edge) => sum + edge.distance, 0);
    expect((await compare(graph, { ...query, distance: [forward, forward] })).length).toBeGreaterThan(0);
  });

  it('preserves directed long outward paths with a short legal return and decimal return bounds', async () => {
    const directed = fixture([[0, 1, 900, { oneWay: true }], [1, 2, 50, { oneWay: true }],
      [2, 0, 50, { oneWay: true }], [1, 3, 50, { oneWay: true }]]);
    expect(await compare(directed, { ...query, distance: [1_000, 1_000] })).toHaveLength(1);
    const lengths = [1_296.97, 2_369.72, 1_787.45, 2_288.28];
    const decimal = fixture(lengths.map((distance, index) => [index, (index + 1) % 4, distance, { oneWay: true }]));
    const total = lengths.reduce((sum, value) => sum + value, 0);
    expect(await compare(decimal, { ...query, distance: [total, total] })).toHaveLength(1);
  });

  it('keeps decimal boundaries and all starts when return bounds must share a bounded allocation', async () => {
    // The many isolated eligible starts make per-start full-network labels too
    // expensive, while the independently enumerable route component stays tiny.
    const graph = fixture([[0, 1, 0.4, { connector: true, gain: 0.4, backGain: 0.2 }],
      [1, 2, 0.6, { gain: 0.6, backGain: 0.8 }], [2, 0, 1.0000000000000002, { gain: 1 }],
      [3_498, 3_499, 0.1, { oneWay: true }]], Array.from({ length: 420 }, (_, index) => index));
    graph.nodes.fill([0, 0]);
    const distance = [0, 2, 4].reduce((sum, index) => sum + graph.edges[index]!.distance, 0);
    const routes = await compare(graph, { ...query, distance: [distance, distance], roads: { distance: 0.4, fraction: 1 } });
    expect(routes.length).toBeGreaterThan(0);
    // Huge finite query limits disable an unsafe integer bound; they are not a
    // mileage cap and must still leave the exact route set unchanged.
    await compare(graph, { ...query, distance: [0, 1e100], gain: [0, 1e100], roads: { distance: 1e100, fraction: 1 } });
  });

  it('matches exhaustive enumeration on 64 weighted directed multigraphs and all their starts', async () => {
    let state = 0x9e3779b9;
    const random = () => { state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0; return state / 2 ** 32; };
    for (let sample = 0; sample < 64; sample++) {
      const graph = fixture(Array.from({ length: 7 }, () => [Math.floor(random() * 4), Math.floor(random() * 4),
        20 + Math.floor(random() * 80), { oneWay: random() < 0.3, unknown: random() < 0.2, connector: random() < 0.25,
          backDistance: 20 + Math.floor(random() * 80), gain: Math.floor(random() * 20), backGain: Math.floor(random() * 20) }]), [0, 1, 2, 3]);
      await compare(graph, { ...query, distance: [Math.floor(random() * 100), 100 + Math.floor(random() * 500)],
        gain: [Math.floor(random() * 30), 30 + Math.floor(random() * 70)],
        repetition: random(), includeUnknown: random() < 0.5,
        roads: random() < 0.5 ? undefined : { distance: random() * 300, fraction: random() } });
    }
  });
});

describe('private candidate lifecycle', () => {
  const graph = fixture([[0, 1, 100], [1, 2, 100], [2, 0, 100]], [0, 1, 2]);
  it('validates road limits and snapshots them before yielding progress', async () => {
    for (const roads of [{ distance: -1, fraction: 0.1 }, { distance: Infinity, fraction: 0.1 },
      { distance: NaN, fraction: 0.1 }, { distance: 100, fraction: -0.1 },
      { distance: 100, fraction: 1.1 }, { distance: 100, fraction: NaN }]) {
      await expect(collect(graph, { ...query, roads })).rejects.toThrow(/road limits/i);
    }
    const roadsGraph = fixture([[0, 1, 100, { connector: true }], [1, 2, 100], [2, 0, 100]]);
    const criteria = { ...query, roads: { distance: 100, fraction: 1 } };
    const expected = enumerate(roadsGraph, criteria).map(key).sort();
    const iterator = search(roadsGraph, criteria);
    expect((await iterator.next()).value).toMatchObject({ type: 'progress' });
    criteria.roads.distance = 0; criteria.roads.fraction = 0;
    const routes: RouteCandidate[] = [];
    for await (const event of iterator) if (event.type === 'route') routes.push(event.route);
    expect(routes.map(key).sort()).toEqual(expected);
  });

  it('reports explicit diagnostic expansion allowances honestly', async () => {
    const { done, events } = await collect(graph, query, { maxExpansions: 3, sliceExpansions: 10_000 });
    expect(done).toMatchObject({ status: 'limited', progress: { totalStarts: 3, attemptedStarts: 3, completedStarts: 0, expansions: 3 } });
    expect(events[0]).toMatchObject({ type: 'progress', progress: { attemptedStarts: 0, completedStarts: 0 } });
  });

  it('emits exact candidates before completion and distinguishes result limits from exhaustive absence', async () => {
    const { routes, done } = await collect(graph, query, { maxResults: 1 });
    expect(routes).toHaveLength(1);
    expect(done.status).toBe('limited');
    expect(done.reason).toContain('Result allowance');
    expect((await collect(graph, query, { maxExpansions: 0 })).done.status).toBe('limited');
    expect((await collect({ ...graph, starts: [] })).done)
      .toMatchObject({ status: 'complete', progress: { totalStarts: 0, attemptedStarts: 0, completedStarts: 0 } });
  });

  it('yields to the event loop so a timer can stop a search even without matches', async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 0);
    try {
      const { done } = await collect(graph, { ...query, distance: [9_000, 10_000] }, { signal: controller.signal });
      expect(done.status).toBe('stopped');
      expect(done.progress.completedStarts).toBeLessThan(done.progress.totalStarts);
    } finally { clearTimeout(timer); }
  });

  it('retains emitted results on cancellation without reporting completed exploration', async () => {
    const controller = new AbortController();
    const routes: RouteCandidate[] = [];
    let terminal: SearchEvent | undefined;
    for await (const event of search(graph, query, { signal: controller.signal })) {
      if (event.type === 'route') { routes.push(event.route); controller.abort(); }
      if (event.type === 'done') terminal = event;
    }
    expect(routes).toHaveLength(1);
    expect(terminal).toMatchObject({ type: 'done', status: 'stopped' });
  });
});
