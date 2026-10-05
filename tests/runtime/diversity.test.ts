import { expect, it } from 'vitest';
import { solveSection } from '../../src/diversity.js';
import type { SearchQuery } from '../../src/model.js';
import { fixture } from '../engine/oracle.js';

const query: SearchQuery = { sections: ['fixture'], distance: [0, 30_000], gain: [0, 10_000], repetition: 1,
  includeUnknown: true, roads: { distance: 30_000, fraction: 1 } };
const families = (routes: Awaited<ReturnType<typeof solveSection>>) => new Set(routes.map(route => route.groupId));

it('combines the same circuit across approaches and starts, preferring explicit start metadata', async () => {
  const graph = fixture([[0, 1, 2000], [0, 2, 1000], [2, 1, 1000],
    [1, 3, 3000], [3, 4, 3000], [4, 1, 3000]], [0, 1, 3, 4]);
  graph.starts[0]!.kind = 'road-contact';
  graph.starts[1]!.kind = 'parking';
  graph.starts[3]!.access = 'unknown';
  const routes = await solveSection(graph, { ...query, distance: [9000, 15_000], repetition: 0.2 });
  expect(families(routes).size).toBe(1);
  expect(routes).toHaveLength(8);
  expect(routes.filter(route => route.preferred).map(route => route.route.start)).toEqual([2]);
  expect(new Set(routes.map(route => `${route.route.start}:${route.direction}`)).size).toBe(8);
  expect(routes.every(route => route.reverseId)).toBe(true);
});

it('hides minor substitutions but preserves a substantial different branch', async () => {
  const graph = fixture([[0, 1, 9500], [1, 0, 100], [1, 0, 200], [1, 2, 700], [2, 0, 700]]);
  const routes = await solveSection(graph, { ...query, distance: [9000, 12_000], repetition: 0 });
  expect(families(routes).size).toBe(2);
  expect(routes).toHaveLength(4);
  expect(routes.filter(route => route.preferred)).toHaveLength(2);
});

it('finds a minor shortcut or longer trail variation when it alone satisfies strict minimums or maximums', async () => {
  const graph = fixture([[0, 1, 9500, { gain: 9, backGain: 9 }],
    [1, 0, 500, { gain: 1, backGain: 1 }], [1, 0, 400, { gain: 2, backGain: 2 }]]);
  const shortcut = await solveSection(graph, { ...query, distance: [9900, 9900], repetition: 0 });
  expect(shortcut).toHaveLength(2);
  expect(shortcut.every(route => route.route.distance === 9900)).toBe(true);
  const longer = await solveSection(graph, { ...query, distance: [10_000, 10_000], repetition: 0 });
  expect(longer).toHaveLength(2);
  expect(longer.every(route => route.route.distance === 10_000)).toBe(true);
  const climb = await solveSection(graph, { ...query, distance: [0, 11_000], gain: [11, 11], repetition: 0 });
  expect(climb).toHaveLength(2);
  expect(climb.every(route => route.route.gain === 11)).toBe(true);
});

it('rejects road mileage and climb padding before minimum qualification', async () => {
  const graph = fixture([[0, 1, 500], [1, 2, 500],
    [2, 0, 50, { connector: true }], [2, 0, 100, { connector: true, gain: 30, backGain: 30 }]]);
  expect(await solveSection(graph, { ...query, distance: [1075, 1200], repetition: 0 })).toEqual([]);
  expect(await solveSection(graph, { ...query, distance: [0, 1200], gain: [20, 40], repetition: 0 })).toEqual([]);
  graph.edges.filter(edge => edge.trail === 2).forEach(edge => { edge.gain = 100; });
  const necessary = await solveSection(graph, { ...query, distance: [0, 1200], gain: [20, 40], repetition: 0 });
  expect(necessary).toHaveLength(2); // The shorter road violates another upper limit.
  expect(necessary.every(route => route.route.roadDistance === 100)).toBe(true);
});

it('preserves equal-road metric witnesses and does not let uncertain shortcuts suppress known access', async () => {
  const tied = fixture([[0, 1, 1000], [1, 0, 100, { connector: true }],
    [1, 0, 100, { connector: true, gain: 20, backGain: 20 }]]);
  const routes = await solveSection(tied, { ...query, gain: [20, 20], repetition: 0 });
  expect(routes).toHaveLength(2);
  expect(routes.every(route => route.route.gain === 20)).toBe(true);
  const unknown = fixture([[0, 1, 1000], [1, 0, 50, { connector: true, unknown: true }],
    [1, 0, 100, { connector: true }]]);
  const known = await solveSection(unknown, { ...query, distance: [1075, 1100], repetition: 0 });
  expect(known).toHaveLength(2);
  expect(known.every(route => !route.route.uncertain && route.route.roadDistance === 100)).toBe(true);
});

it('does not link reverse directions represented by different minor witnesses', async () => {
  const graph = fixture([[0, 1, 9000], [1, 0, 100, { connector: true, gain: 10 }],
    [1, 0, 100, { connector: true, backGain: 10 }]]);
  const routes = await solveSection(graph, { ...query, gain: [10, 10], repetition: 0 });
  expect(families(routes).size).toBe(1);
  expect(new Set(routes.map(route => route.direction))).toEqual(new Set([0, 1]));
  expect(routes.every(route => !route.reverseId)).toBe(true);
});

it('prevents aggregate drift and assigns identical IDs despite graph storage order', async () => {
  const graph = fixture([[0, 1, 1500], [1, 2, 500], [1, 2, 500], [2, 3, 1500],
    [3, 4, 500], [3, 4, 500], [4, 0, 3000]], [0, 2]);
  const criteria = { ...query, distance: [7000, 7000] as SearchQuery['distance'], repetition: 0 };
  const routes = await solveSection(graph, criteria);
  // Each one-patch difference meets 85%, but merging every combination would
  // lower the common/combined fraction to 75%.
  expect(families(routes).size).toBe(2);
  graph.edges.reverse(); graph.starts.reverse();
  const reordered = await solveSection(graph, criteria);
  expect(reordered.map(route => [route.route.id, route.groupId, route.direction, route.preferred]).sort())
    .toEqual(routes.map(route => [route.route.id, route.groupId, route.direction, route.preferred]).sort());
});

it('preserves cyclic common-trail order even when footprints match', async () => {
  const graph = fixture([[0, 1, 1000], [2, 3, 1000], [4, 5, 1000], [6, 7, 1000],
    [1, 2, 1, { connector: true }], [3, 4, 1, { connector: true }], [5, 6, 1, { connector: true }], [7, 0, 1, { connector: true }],
    [1, 4, 1, { connector: true }], [5, 2, 1, { connector: true }], [3, 6, 1, { connector: true }]]);
  const routes = await solveSection(graph, { ...query, distance: [4004, 4004], repetition: 0 });
  expect(families(routes).size).toBeGreaterThan(1);
});

it('keeps both road-circuit directions reached through a trail approach', async () => {
  const graph = fixture([[0, 1, 100], [1, 2, 1000, { connector: true }], [2, 3, 1000, { connector: true }], [3, 1, 1000, { connector: true }]]);
  const routes = await solveSection(graph, query);
  expect(routes).toHaveLength(2);
  expect(routes.every(route => route.reverseId && route.route.kind === 'lollipop')).toBe(true);
});
