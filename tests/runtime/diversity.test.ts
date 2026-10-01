import { expect, it } from 'vitest';
import { createRouteGroups } from '../../src/diversity.js';
import type { RouteCandidate, SearchQuery } from '../../src/model.js';
import { enumerate, fixture } from '../engine/oracle.js';

it('combines minor variations while preserving different hiking paths, starts and qualified directions', () => {
  const graph = fixture([
    [0, 1, 3500], // Shared approach.
    [1, 2, 650], [2, 1, 350], [2, 1, 350], // Two different cycle branches.
    [0, 3, 1750], [3, 1, 1750], // A physically separate approach of equal length.
    ...Array.from({ length: 11 }, (): [number, number, number] => [4, 4, 1000]), // Separate physical rings at one start.
    [5, 6, 975], [6, 5, 25], [6, 5, 25], // A small substitution within the same cycle.
  ], [0, 1, 4, 5, 2]);
  graph.starts.push({ ...graph.starts[1]!, id: 'another-source-at-the-same-node' });
  const query: SearchQuery = { area: [-1, -1, 1, 1], distance: [1, 10000], gain: [0, 0], repetition: 0.45, includeUnknown: true };
  const valid = enumerate(graph, query);
  function route(start: number, edges: number[], candidates = valid): RouteCandidate {
    const found = candidates.find(candidate => candidate.start === start && candidate.edges.join(',') === edges.join(','));
    if (!found) throw new Error(`Fixture route must independently satisfy constraints: ${start}/${edges}`);
    return { ...found, id: `${start}/${edges}`, kind: found.repetition ? 'lollipop' : 'loop', uncertain: false };
  }
  const group = createRouteGroups(graph);
  const first = route(0, [0, 2, 4, 1]);
  expect(first).toMatchObject({ distance: 8000, repetition: 0.4375 });
  const firstIdentity = group(first)!;
  expect(firstIdentity.groupId).toBe(first.id);
  expect(group(route(0, [0, 5, 3, 1]))).toEqual({ ...firstIdentity, preferred: false }); // Full reversed walk, same original start.
  expect(group({ ...first, id: 'repeated-emission' })).toEqual({ ...firstIdentity, preferred: false });

  const otherCycle = route(0, [0, 2, 6, 1]);
  const otherCycleIdentity = group(otherCycle)!;
  expect(otherCycleIdentity.groupId).toBe(otherCycle.id); // Shared long approach must not hide another cycle.
  expect(group(route(0, [0, 7, 3, 1]))).toEqual({ ...otherCycleIdentity, preferred: false });
  const otherApproach = route(0, [8, 10, 2, 4, 11, 9]);
  const otherApproachIdentity = group(otherApproach)!;
  expect(otherApproachIdentity.groupId).toBe(otherApproach.id);
  expect(group(route(0, [8, 10, 5, 3, 11, 9]))).toEqual({ ...otherApproachIdentity, preferred: false });

  const pureCycle = route(1, [2, 4]);
  const cycleIdentity = group(pureCycle)!;
  expect(cycleIdentity.groupId).toBe(pureCycle.id); // No approach to peel off.
  expect(group(route(1, [5, 3]))).toEqual({ ...cycleIdentity, preferred: false });
  const otherEntrance = route(4, [4, 2]);
  const entranceIdentity = group(otherEntrance)!;
  expect(entranceIdentity.groupId).toBe(pureCycle.id);
  expect(entranceIdentity.optionId).not.toBe(cycleIdentity.optionId);
  const sameNodeEntrance = route(5, [2, 4]);
  const sameNodeIdentity = group(sameNodeEntrance)!;
  expect(sameNodeIdentity.groupId).toBe(pureCycle.id);
  expect(new Set([cycleIdentity.optionId, entranceIdentity.optionId, sameNodeIdentity.optionId]).size).toBe(3);

  // The same option identity is recovered when either direction arrives first.
  const reverseRing = route(2, [13]);
  const ringIdentity = group(reverseRing)!;
  expect(ringIdentity.groupId).toBe(reverseRing.id);
  expect(group(route(2, [12]))).toEqual({ ...ringIdentity, preferred: false });
  const rings = [ringIdentity.optionId];
  for (let ring = 1; ring < 11; ring++) {
    const next = route(2, [12 + ring * 2]);
    const identity = group(next)!;
    expect(identity.groupId).toBe(next.id);
    expect(group(route(2, [13 + ring * 2]))).toEqual({ ...identity, preferred: false });
    rings.push(identity.optionId);
  }
  expect(new Set(rings).size).toBe(11);

  const nearFirst = route(3, [34, 36]);
  const nearOther = route(3, [34, 38]);
  const nearIdentity = group(nearFirst)!;
  expect(nearIdentity.groupId).toBe(nearFirst.id);
  // The 25m substitution does not become a second choice. Exact reverse remains available.
  expect(group(nearOther)).toBeUndefined();
  expect(group(route(3, [39, 35]))).toBeUndefined();
  expect(group(route(3, [37, 35]))).toEqual({ ...nearIdentity, preferred: false });
  expect(group(first)).toEqual({ ...firstIdentity, preferred: false }); // Later options never replace the representative.
  expect(group(otherEntrance)).toEqual({ ...entranceIdentity, preferred: false });

  // This stem puts the square/lollipop overlap at the floating-point 95% boundary.
  // Summing trails in walk order assigned the two lollipop directions to different groups.
  const boundaryGraph = fixture([
    [0, 1, 100.1], [1, 2, 200.2], [2, 3, 300.3], [3, 0, 400.4], [4, 0, 52.68421052631584],
  ], [0, 4]);
  const boundaryRoutes = enumerate(boundaryGraph, query);
  const boundaryGroup = createRouteGroups(boundaryGraph);
  boundaryGroup(route(0, [0, 2, 4, 6], boundaryRoutes));
  const boundaryIdentity = boundaryGroup(route(1, [8, 0, 2, 4, 6, 9], boundaryRoutes));
  expect(boundaryGroup(route(1, [8, 7, 5, 3, 1, 9], boundaryRoutes))).toEqual({ ...boundaryIdentity, preferred: false });
});

it('combines independent small detours and safely improves a starting point without mixing reverse walks', async () => {
  const graph = fixture([
    [0, 1, 7000], [1, 2, 100], [1, 3, 150], [3, 2, 150],
    [2, 4, 7000], [4, 5, 100], [4, 6, 150], [6, 5, 150], [5, 0, 7000],
    [1, 7, 350], [7, 2, 350],
  ]);
  const query: SearchQuery = { area: [-1, -1, 1, 1], distance: [1, 30000], gain: [0, 0], repetition: 0, includeUnknown: true };
  function candidate(network: typeof graph, edges: number[]): RouteCandidate {
    const valid = enumerate(network, query).find(route => route.start === 0 && route.edges.join(',') === edges.join(','));
    if (!valid) throw Error(`Route must independently qualify: ${edges}`);
    return { ...valid, id: edges.join('-'), kind: 'loop', uncertain: edges.some(index => network.edges[index]!.access === 'unknown') };
  }
  const group = createRouteGroups(graph);
  const first = group(candidate(graph, [0, 2, 8, 10, 16]))!;
  expect(group(candidate(graph, [0, 4, 6, 8, 12, 14, 16]))).toBeUndefined(); // Two independent 400m differences.
  expect(group(candidate(graph, [0, 18, 20, 8, 10, 16]))!.groupId).not.toBe(first.groupId); // One 800m alternative.

  const roads = fixture([[0, 1, 1000], [1, 2, 1000], [2, 0, 100, { connector: true }], [2, 0, 200, { connector: true }]]);
  let choose = createRouteGroups(roads);
  const { createRouteStore } = await import('../../src/route-store.js');
  let store = createRouteStore();
  function add(edges: number[]) {
    const route = candidate(roads, edges);
    const identity = choose(route);
    if (identity) store.add({ type: 'route', ...identity, route: {
      summary: { ...route, startId: roads.starts[0]!.id, startName: 'Test start', startPosition: roads.nodes[0]!, trailNames: ['Trail'] },
      sections: edges.map(index => ({ cell: '0_0', id: roads.edges[index]!.trail, reverse: roads.edges[index]!.reverse })),
    } });
    return identity;
  }
  try {
    add([0, 2, 6]);
    add([7, 3, 1]);
    const original = store.page(0)!.routes[0]!;
    expect(original.reverseId).toBeTruthy();
    add([0, 2, 4]); // A better road connection replaces the displayed walk.
    const improved = store.page(0)!.routes[0]!;
    expect(store.counts).toEqual({ groupCount: 1, routeCount: 1 });
    expect(improved.roadDistance).toBe(100);
    expect(improved.reverseId).toBeUndefined(); // The former walk's reverse is not this walk's reverse.
    expect(store.route(original.id)!.summary.reverseId).toBe(original.reverseId); // Open details remain stable.
    expect(add([0, 2, 6])).toBeUndefined();
    add([5, 3, 1]);
    const final = store.page(0)!.routes[0]!;
    expect(final.reverseId).toBeTruthy();
    expect(store.route(final.reverseId!)!.stored.sections.map(section => section.id)).toEqual([2, 1, 0]);
  } finally { store.close(); }
  roads.edges[0]!.access = 'unknown';
  choose = createRouteGroups(roads);
  store = createRouteStore();
  try {
    add([0, 2, 4]);
    const uncertain = store.page(0)!.routes[0]!;
    expect(uncertain.uncertain).toBe(true);
    add([5, 3, 1]);
    expect(store.page(0)!.routes[0]).toMatchObject({ uncertain: false, reverseId: uncertain.id });
  } finally { store.close(); }
});
