import { expect, it } from 'vitest';
import { solveSection } from '../../src/diversity.js';
import type { SearchQuery } from '../../src/model.js';
import { distinct, fixture, normalized } from '../engine/oracle.js';

const query: SearchQuery = { sections: ['fixture'], distance: [0, 30_000], gain: [0, 10_000], repetition: 1,
  includeUnknown: true, roads: { distance: 30_000, fraction: 1 } };
const families = (routes: Awaited<ReturnType<typeof solveSection>>) => new Set(routes.map(route => route.groupId));

async function compareOutputs(graph: Parameters<typeof solveSection>[0], criteria: SearchQuery) {
  const expected = distinct(graph, criteria);
  const actual = await solveSection(graph, criteria);
  const describe = (item: { route: { start: number; edges: number[] }; direction: number; preferred: boolean }) =>
    `${item.route.start}:${item.route.edges.join(',')}:${item.direction}:${item.preferred}`;
  const actualGroups = [...families(actual)].map(group => actual.filter(item => item.groupId === group).map(describe).sort());
  expect(actualGroups.sort()).toEqual(expected.map(group => group.witnesses.map(describe).sort()).sort());
  return actual;
}

it('combines the same circuit across approaches and starts, preferring explicit start metadata', async () => {
  const graph = fixture([[0, 1, 2000], [0, 2, 1000], [2, 1, 1000],
    [1, 3, 3000], [3, 4, 3000], [4, 1, 3000]], [0, 1, 3, 4]);
  graph.starts[0]!.kind = 'road-contact';
  graph.starts[1]!.kind = 'parking';
  graph.starts[3]!.access = 'unknown';
  const routes = await compareOutputs(graph, { ...query, distance: [9000, 15_000], repetition: 0.2 });
  expect(families(routes).size).toBe(1);
  expect(routes).toHaveLength(8);
  expect(routes.filter(route => route.preferred).map(route => route.route.start)).toEqual([2]);
  expect(new Set(routes.map(route => `${route.route.start}:${route.direction}`)).size).toBe(8);
  expect(routes.every(route => route.reverseId)).toBe(true);
});

it('hides minor substitutions but preserves a substantial different branch', async () => {
  const graph = fixture([[0, 1, 9500], [1, 0, 100], [1, 0, 200], [1, 2, 700], [2, 0, 700]]);
  const routes = await compareOutputs(graph, { ...query, distance: [9000, 12_000], repetition: 0 });
  expect(families(routes).size).toBe(2);
  expect(routes).toHaveLength(4);
  expect(routes.filter(route => route.preferred)).toHaveLength(2);
});

it('finds a minor shortcut or longer trail variation when it alone satisfies strict minimums or maximums', async () => {
  const graph = fixture([[0, 1, 9500, { gain: 9, backGain: 9 }],
    [1, 0, 500, { gain: 1, backGain: 1 }], [1, 0, 400, { gain: 2, backGain: 2 }]]);
  const shortcut = await compareOutputs(graph, { ...query, distance: [9900, 9900], repetition: 0 });
  expect(shortcut).toHaveLength(2);
  expect(shortcut.every(route => route.route.distance === 9900)).toBe(true);
  const longer = await compareOutputs(graph, { ...query, distance: [10_000, 10_000], repetition: 0 });
  expect(longer).toHaveLength(2);
  expect(longer.every(route => route.route.distance === 10_000)).toBe(true);
  const climb = await compareOutputs(graph, { ...query, distance: [0, 11_000], gain: [11, 11], repetition: 0 });
  expect(climb).toHaveLength(2);
  expect(climb.every(route => route.route.gain === 11)).toBe(true);
});

it('rejects road mileage and climb padding before minimum qualification', async () => {
  const graph = fixture([[0, 1, 500], [1, 2, 500],
    [2, 0, 50, { connector: true }], [2, 0, 100, { connector: true, gain: 30, backGain: 30 }]]);
  expect(await compareOutputs(graph, { ...query, distance: [1075, 1200], repetition: 0 })).toEqual([]);
  expect(await compareOutputs(graph, { ...query, distance: [0, 1200], gain: [20, 40], repetition: 0 })).toEqual([]);
  graph.edges.filter(edge => edge.trail === 2).forEach(edge => { edge.gain = 100; });
  const necessary = await compareOutputs(graph, { ...query, distance: [0, 1200], gain: [20, 40], repetition: 0 });
  expect(necessary).toHaveLength(2); // The shorter road violates another upper limit.
  expect(necessary.every(route => route.route.roadDistance === 100)).toBe(true);
});

it('preserves equal-road metric witnesses and does not let uncertain shortcuts suppress known access', async () => {
  const tied = fixture([[0, 1, 1000], [1, 0, 100, { connector: true }],
    [1, 0, 100, { connector: true, gain: 20, backGain: 20 }]]);
  const routes = await compareOutputs(tied, { ...query, gain: [20, 20], repetition: 0 });
  expect(routes).toHaveLength(2);
  expect(routes.every(route => route.route.gain === 20)).toBe(true);
  const unknown = fixture([[0, 1, 1000], [1, 0, 50, { connector: true, unknown: true }],
    [1, 0, 100, { connector: true }]]);
  const known = await compareOutputs(unknown, { ...query, distance: [1075, 1100], repetition: 0 });
  expect(known).toHaveLength(2);
  expect(known.every(route => !route.route.uncertain && route.route.roadDistance === 100)).toBe(true);
});

it('does not link reverse directions represented by different minor witnesses', async () => {
  const graph = fixture([[0, 1, 9000], [1, 0, 100, { connector: true, gain: 10 }],
    [1, 0, 100, { connector: true, backGain: 10 }]]);
  const routes = await compareOutputs(graph, { ...query, gain: [10, 10], repetition: 0 });
  expect(families(routes).size).toBe(1);
  expect(new Set(routes.map(route => route.direction))).toEqual(new Set([0, 1]));
  expect(routes.every(route => !route.reverseId && route.oppositeId)).toBe(true);
});

it('prevents aggregate drift and assigns identical IDs despite graph storage order', async () => {
  const graph = fixture([[0, 1, 1500], [1, 2, 500], [1, 2, 500], [2, 3, 1500],
    [3, 4, 500], [3, 4, 500], [4, 0, 3000]], [0, 2]);
  const criteria = { ...query, distance: [7000, 7000] as SearchQuery['distance'], repetition: 0 };
  const routes = await compareOutputs(graph, criteria);
  // Each one-patch difference meets 85%, but merging every combination would
  // lower the common/combined fraction to 75%.
  expect(families(routes).size).toBe(2);
  graph.edges.reverse(); graph.starts.reverse();
  const reordered = await compareOutputs(graph, criteria);
  expect(reordered.map(route => [route.route.id, route.groupId, route.direction, route.preferred]).sort())
    .toEqual(routes.map(route => [route.route.id, route.groupId, route.direction, route.preferred]).sort());
});

it('preserves cyclic common-trail order even when footprints match', async () => {
  const graph = fixture([[0, 1, 1000], [2, 3, 1000], [4, 5, 1000], [6, 7, 1000],
    [1, 2, 1, { connector: true }], [3, 4, 1, { connector: true }], [5, 6, 1, { connector: true }], [7, 0, 1, { connector: true }],
    [1, 4, 1, { connector: true }], [5, 2, 1, { connector: true }], [3, 6, 1, { connector: true }]]);
  const routes = await compareOutputs(graph, { ...query, distance: [4004, 4004], repetition: 0 });
  expect(families(routes).size).toBeGreaterThan(1);
});

it('keeps both road-circuit directions reached through a trail approach', async () => {
  const graph = fixture([[0, 1, 100], [1, 2, 1000, { connector: true }], [2, 3, 1000, { connector: true }], [3, 1, 1000, { connector: true }]]);
  const routes = await compareOutputs(graph, query);
  expect(routes).toHaveLength(2);
  expect(routes.every(route => route.reverseId && route.route.kind === 'lollipop')).toBe(true);
});

it('keeps asymmetric long outward approaches under tight repetition and strict decimal limits', async () => {
  const graph = fixture([[0, 1, 900, { backDistance: 100 }], [1, 2, 200], [2, 3, 100], [3, 1, 200]], [0, 1, 2]);
  const routes = await compareOutputs(graph, { ...query, distance: [1500, 1500], repetition: 100 / 1500 });
  expect(routes).toHaveLength(2);
  expect(routes.every(item => item.route.start === 0 && item.route.repetition === 100 / 1500)).toBe(true);
  const decimal = fixture([[0, 1, 0.9000000000000001, { backDistance: 0.10000000000000002, gain: 0.1, backGain: 0.2 }],
    [1, 2, 0.1, { gain: 0.1, backGain: 0.1 }], [2, 3, 0.2, { gain: 0.2, backGain: 0.2 }],
    [3, 1, 0.3, { gain: 0.3, backGain: 0.3 }]]);
  const edges = [0, 2, 4, 6, 1];
  const distance = edges.reduce((sum, id) => sum + decimal.edges[id]!.distance, 0);
  const gain = edges.reduce((sum, id) => sum + decimal.edges[id]!.gain, 0);
  expect((await compareOutputs(decimal, { ...query, distance: [distance, distance], gain: [gain, gain],
    repetition: decimal.edges[1]!.distance / distance })).length).toBeGreaterThan(0);
});

it('finds every start and direction when only a longer trail approach supplies both minimums', async () => {
  const graph = fixture([[0, 1, 100, { gain: 5, backGain: 5 }], [0, 2, 80, { gain: 20, backGain: 20 }],
    [2, 1, 80, { gain: 20, backGain: 20 }], [1, 3, 300], [3, 4, 300], [4, 1, 300]], [0, 1, 3, 4]);
  graph.starts[0]!.kind = 'road-contact';
  const routes = await compareOutputs(graph, { ...query, distance: [1210, 1230], gain: [70, 90], repetition: 0.2 });
  expect(routes).toHaveLength(2);
  expect(routes.every(item => item.route.start === 0 && item.route.distance === 1220 && item.route.gain === 80)).toBe(true);
});

it('rejects a padded road approach using a below-minimum substitute with the same ordered trail itinerary', async () => {
  const graph = fixture([[0, 1, 50, { connector: true }], [0, 2, 60, { connector: true, gain: 20, backGain: 20 }],
    [2, 1, 60, { connector: true, gain: 20, backGain: 20 }], [1, 3, 300], [3, 4, 300], [4, 1, 300]]);
  const criteria: SearchQuery = { ...query, distance: [1130, 1150], gain: [70, 90], repetition: 0.2 };
  expect(await compareOutputs(graph, criteria)).toHaveLength(0);
  graph.edges.filter(edge => edge.trail === 0).forEach(edge => { edge.access = 'unknown'; });
  const known = await compareOutputs(graph, criteria);
  expect(known).toHaveLength(2);
  expect(known.every(item => !item.route.uncertain && item.route.roadDistance === 240)).toBe(true);
});

it('retains a longer road approach when a shorter asymmetric substitute violates repetition', async () => {
  const graph = fixture([[0, 1, 100, { connector: true, backDistance: 300 }],
    [0, 1, 400, { connector: true, backDistance: 100 }], [1, 2, 400], [2, 3, 300], [3, 1, 300]]);
  const routes = await compareOutputs(graph, { ...query, distance: [1500, 1500], repetition: 0.2 });
  expect(routes).toHaveLength(2);
  expect(routes.every(item => item.route.roadDistance === 500 && item.route.repetition === 100 / 1500)).toBe(true);
});

it('does not use a shorter road substitute that intersects another part of the main circuit', async () => {
  const graph = fixture([[0, 2, 10, { connector: true }], [2, 1, 10, { connector: true }],
    [0, 4, 100, { connector: true }], [4, 1, 100, { connector: true }],
    [1, 2, 400], [2, 3, 300], [3, 1, 300]]);
  const routes = await compareOutputs(graph, { ...query, distance: [1400, 1400], repetition: 0.2 });
  expect(routes.some(item => item.route.roadDistance === 400 && item.route.kind === 'lollipop')).toBe(true);
});

it('retains independently qualified witnesses on weighted directed tiny graphs', async () => {
  let state = 123456789;
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 2 ** 32; };
  for (let sample = 0; sample < 32; sample++) {
    const graph = fixture(Array.from({ length: 6 }, () => [Math.floor(random() * 3), Math.floor(random() * 3),
      20 + Math.floor(random() * 80), { oneWay: random() < 0.2, unknown: random() < 0.2,
        connector: random() < 0.4, backDistance: 20 + Math.floor(random() * 80), gain: random() * 20, backGain: random() * 20 }]), [0, 1, 2]);
    const criteria: SearchQuery = { ...query, distance: [random() * 100, 200 + random() * 300],
      gain: [random() * 20, 30 + random() * 60], repetition: random(), includeUnknown: random() < 0.5,
      roads: { distance: random() * 400, fraction: random() } };
    const expected = normalized(graph, criteria);
    const routes = await compareOutputs(graph, criteria);
    if (!expected.length) expect(routes).toHaveLength(0);
    else expect(routes.length).toBeGreaterThan(0);
    for (const { route } of routes) {
      const reference = expected.find(other => other.start === route.start && other.edges.join(',') === route.edges.join(','));
      expect(reference).toBeDefined();
      expect([route.distance, route.gain, route.roadDistance, route.repetition])
        .toEqual([reference!.distance, reference!.gain, reference!.roadDistance, reference!.repetition]);
    }
  }
});
