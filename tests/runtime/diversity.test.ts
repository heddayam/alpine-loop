import { expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { solveSection, type CandidatePool } from '../../src/diversity.js';
import { createRouteStore } from '../../src/route-store.js';
import { search } from '../../src/engine/search.js';
import type { SearchQuery } from '../../src/model.js';
import { distinct, fixture, groupPool, measure, normalized } from '../engine/oracle.js';

const query: SearchQuery = { sections: ['fixture'], distance: [0, 30_000], gain: [0, 10_000], repetition: 1,
  includeUnknown: true, roads: { distance: 30_000, fraction: 1 } };
const families = (routes: Awaited<ReturnType<typeof solveSection>>) => new Set(routes.map(route => route.groupId));

async function compareOutputs(graph: Parameters<typeof solveSection>[0], criteria: SearchQuery, foundPool = false, savedPool?: CandidatePool) {
  const references = normalized(graph, criteria);
  const key = (route: { start: number; edges: number[] }) => `${route.start}:${route.edges.join(',')}`;
  const byWalk = new Map(references.map(route => [key(route), route]));
  const pool = [];
  for await (const event of search(graph, criteria)) if (event.type === 'route') {
    const valid = byWalk.get(key(event.route));
    expect(measure(graph, criteria, event.route.start, event.route.edges)).toBeDefined();
    expect(valid).toBeDefined();
    pool.push(valid!);
  }
  const exhaustive = distinct(graph, criteria);
  const expected = foundPool ? groupPool(graph, pool) : exhaustive;
  if (foundPool) {
    // This committed tiny corpus still discovers every family/start/direction.
    // Preference may differ when a sensible approach omits a winding detour.
    const coverage = (groups: typeof exhaustive) => groups.map(group => JSON.stringify([group.seed,
      group.witnesses.map(item => `${item.route.start}:${item.direction}`).sort()])).sort();
    expect(coverage(expected)).toEqual(coverage(exhaustive));
  }
  const actual = await solveSection(graph, criteria, undefined, savedPool);
  for (const { route } of actual) {
    const valid = measure(graph, criteria, route.start, route.edges);
    expect(valid).toBeDefined();
    expect(byWalk.get(key(route))).toBeDefined();
    expect([route.distance, route.gain, route.roadDistance, route.repetition])
      .toEqual([valid!.distance, valid!.gain, valid!.roadDistance, valid!.repetition]);
  }
  const describe = (item: { route: { start: number; edges: number[] }; direction: number; preferred: boolean; preferredStart: boolean }) =>
    `${item.route.start}:${item.route.edges.join(',')}:${item.direction}:${item.preferred}:${item.preferredStart}`;
  const actualGroups = [...families(actual)].map(group => actual.filter(item => item.groupId === group).map(describe).sort());
  expect(actualGroups.sort()).toEqual(expected.map(group => group.witnesses.map(item => describe({ ...item,
    preferredStart: group.witnesses.find(candidate => candidate.route.start === item.route.start) === item })).sort()).sort());
  return actual;
}

it('keeps private disk candidates exact across consecutive sections without publishing the scratch table', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'alpine-candidate-pool-'));
  const file = join(directory, 'results.sqlite'), store = createRouteStore(file, true);
  try {
    const graph = fixture([[0, 1, 1500], [1, 2, 500], [1, 2, 500], [2, 3, 1500],
      [3, 4, 500], [3, 4, 500], [4, 0, 3000]], [0, 2]);
    store.begin();
    const grouped = await compareOutputs(graph, { ...query, distance: [7000, 7000], repetition: 0 }, false, store.candidatePool);
    expect(families(grouped).size).toBe(2);
    store.commit();
    // Numeric trail/start IDs overlap, but the next section has different facts.
    const directed = fixture([[0, 1, 900, { backDistance: 100 }], [1, 2, 200],
      [2, 3, 100], [3, 1, 200]], [0, 1, 2]);
    store.begin();
    const next = await compareOutputs(directed, { ...query, distance: [1500, 1500], repetition: 100 / 1500 }, false, store.candidatePool);
    expect(next).toHaveLength(2);
    expect(store.counts).toEqual({ groupCount: 0, routeCount: 0 });
    store.commit(); store.close();
    const saved = new DatabaseSync(file, { readOnly: true });
    try { expect(saved.prepare("SELECT name FROM sqlite_master WHERE name = 'candidates'").all()).toEqual([]); }
    finally { saved.close(); }
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

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

it('prefers a qualifying known approach before less road walking on an uncertain approach', async () => {
  const graph = fixture([[0, 1, 100, { connector: true, unknown: true }],
    [0, 1, 200, { connector: true }], [1, 2, 1000], [2, 1, 1000]]);
  const routes = await compareOutputs(graph, { ...query, distance: [0, 3000], repetition: 0.2,
    roads: { distance: 1000, fraction: 0.5 } });
  expect(routes).toHaveLength(2);
  expect(routes.every(item => !item.route.uncertain && item.route.roadDistance === 400
    && item.route.distance === 2400)).toBe(true);
});

it('keeps road-minimum certificates separate for known and uncertain starts at the same location', async () => {
  const graph = fixture([[0, 1, 1000], [1, 0, 50, { connector: true, unknown: true }],
    [1, 0, 100, { connector: true }]], [0, 0]);
  graph.starts[1]!.id = 'uncertain-entry';
  graph.starts[1]!.access = 'unknown';
  const routes = await compareOutputs(graph, { ...query, distance: [1075, 1100], repetition: 0 });
  // The below-minimum unknown shortcut cannot suppress a certain hike, but
  // it is equally uncertain from the second entrance and prevents padding.
  expect(routes).toHaveLength(2);
  expect(routes.every(item => item.route.start === 0 && !item.route.uncertain
    && item.route.roadDistance === 100)).toBe(true);
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

it('discovers a sensible intermediate approach when distance and climb extremes both fail', async () => {
  const graph = fixture([[0, 1, 1000, { gain: 500, backGain: 500 }], [0, 1, 2000],
    [0, 1, 1500, { gain: 200, backGain: 200 }], [1, 2, 2000, { gain: 100, backGain: 100 }],
    [2, 3, 2000, { gain: 100, backGain: 100 }], [3, 1, 2000, { gain: 100, backGain: 100 }]]);
  const routes = await compareOutputs(graph, { ...query, distance: [8800, 9200], gain: [650, 750], repetition: 0.2,
    roads: { distance: 0, fraction: 0 } });
  expect(routes).toHaveLength(2);
  expect(routes.every(item => item.route.distance === 9000 && item.route.gain === 700)).toBe(true);
});

it('checks both access directions of an approach while retaining qualifying circuit starts', async () => {
  const graph = fixture([[0, 1, 100], [1, 2, 300], [2, 3, 300], [3, 1, 300]], [0, 1]);
  graph.edges[1]!.access = 'unknown';
  const routes = await compareOutputs(graph, { ...query, includeUnknown: false, repetition: 0.2 });
  expect(routes).toHaveLength(2);
  expect(routes.every(item => item.route.start === 1 && item.route.kind === 'loop' && !item.route.uncertain)).toBe(true);
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

it('preserves every start and direction when merging removes the initial common-trail anchor', async () => {
  const graph = fixture([[0, 1, 100, { gain: 10 }], [0, 1, 200, { backGain: 10 }], [1, 2, 4500], [2, 0, 4500]], [0, 1, 2]);
  graph.starts[0]!.kind = 'road-contact';
  graph.starts[1]!.kind = 'parking';
  graph.starts[2]!.access = 'unknown';
  const routes = await compareOutputs(graph, { ...query, distance: [9100, 9200], gain: [10, 10], repetition: 0 });
  expect(families(routes).size).toBe(1);
  expect(routes).toHaveLength(6);
  expect(new Set(routes.map(item => `${item.route.start}:${item.direction}`)).size).toBe(6);
  expect(routes.find(item => item.preferred)!.route.start).toBe(2);
  expect(routes.every(item => item.oppositeId && !item.reverseId)).toBe(true);
});

it('retains a road-only main circuit when an asymmetric trail stem satisfies the road and repetition limits', async () => {
  const graph = fixture([[0, 1, 1000, { backDistance: 1 }], [1, 2, 30, { connector: true }],
    [2, 3, 30, { connector: true }], [3, 1, 40, { connector: true }]]);
  const routes = await compareOutputs(graph, { ...query, distance: [1101, 1101], repetition: 0.2,
    roads: { distance: 100, fraction: 0.1 } });
  expect(routes).toHaveLength(2);
  expect(routes.every(item => item.route.roadDistance === 100 && item.route.repetition === 1 / 1101)).toBe(true);
});

it('keeps a different trail approach after a better-looking road witness is eliminated as padding', async () => {
  const graph = fixture([[0, 1, 10, { connector: true }], [0, 1, 5, { connector: true }],
    [0, 2, 20, { connector: true }], [2, 1, 10], [1, 3, 300], [3, 4, 300], [4, 1, 300]]);
  const routes = await compareOutputs(graph, { ...query, distance: [919, 1000], repetition: 0.2 });
  expect(routes).toHaveLength(2);
  expect(routes.every(item => item.route.distance === 960 && item.route.roadDistance === 40)).toBe(true);
});

it('keeps preferred approaches when a finite asymmetric edge makes ratio bounds unusable', async () => {
  const graph = fixture([[0, 1, 0.3], [0, 2, 0.1], [2, 1, 0.1], [1, 3, 200], [3, 4, 200], [4, 1, 100],
    [10, 11, 1, { backDistance: Number.MIN_VALUE }]]);
  const routes = await compareOutputs(graph, { ...query, distance: [500, 501], repetition: 0.2,
    roads: { distance: 0, fraction: 0 } });
  expect(routes).toHaveLength(2);
  expect(routes.every(item => item.route.edges.length === 7)).toBe(true);
});

it('preserves actual gain order when the climb limit disables integer bounds', async () => {
  const graph = fixture([[0, 4, 50], [4, 2, 50], [1, 2, 100, { gain: 1e100, backGain: 1e100 }],
    [2, 3, 100, { gain: 1e84, backGain: 1e84 }], [3, 1, 100, { gain: 1e84, backGain: 1e84 }]]);
  const edges = [0, 2, 6, 8, 4, 3, 1];
  const gain = edges.reduce((sum, id) => sum + graph.edges[id]!.gain, 0);
  const routes = await compareOutputs(graph, { ...query, distance: [500, 500], gain: [gain, gain], repetition: 0.2,
    roads: { distance: 0, fraction: 0 } });
  expect(routes).toHaveLength(1);
  expect(routes[0]!.route.edges).toEqual(edges);
});

it('retains every qualifying circuit when tied road mileage moves a road from approach into the core', async () => {
  const graph = fixture([[0, 1, 100], [3, 4, 1000], [4, 3, 100, { connector: true }],
    [1, 3, 5, { connector: true }], [4, 1, 105, { connector: true }]]);
  const routes = await compareOutputs(graph, { ...query, distance: [1310, 1310] });
  expect(routes).toHaveLength(2);
  expect(routes.every(item => item.route.roadDistance === 110 && item.route.repetition === 100 / 1310)).toBe(true);
});

it('extends the normal candidate pool when searching deeper and regroups the expanded discoveries deterministically', async () => {
  const graph = fixture([[0, 1, 9500], [1, 0, 100], [1, 0, 200], [1, 2, 700], [2, 0, 700],
    [0, 3, 2000], [3, 4, 2500], [4, 0, 3000]], [0, 1, 2, 3, 4]);
  const criteria: SearchQuery = { ...query, distance: [7000, 12_000], repetition: 0.2,
    roads: { distance: 0, fraction: 0 } };
  const pool = async (effort: 'normal' | 'deep') => {
    const keys = new Set<string>();
    for await (const event of search(graph, { ...criteria, effort })) if (event.type === 'route') {
      keys.add(`${event.route.start}:${event.route.edges.join(',')}`);
    }
    return keys;
  };
  const normal = await pool('normal'), deeper = await pool('deep');
  expect(normal.size).toBeGreaterThan(0);
  expect([...normal].every(key => deeper.has(key))).toBe(true);
  const routes = await compareOutputs(graph, { ...criteria, effort: 'deep' });
  const repeated = await compareOutputs(graph, { ...criteria, effort: 'deep' });
  expect(repeated).toEqual(routes);
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
    const routes = await compareOutputs(graph, criteria, true);
    if (!expected.length) expect(routes).toHaveLength(0);
    for (const { route } of routes) {
      const reference = expected.find(other => other.start === route.start && other.edges.join(',') === route.edges.join(','));
      expect(reference).toBeDefined();
      expect([route.distance, route.gain, route.roadDistance, route.repetition])
        .toEqual([reference!.distance, reference!.gain, reference!.roadDistance, reference!.repetition]);
    }
  }
});
