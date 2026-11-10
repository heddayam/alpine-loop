import { expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ROUTES_PER_PAGE, type Position } from '../../src/model.js';
import { createRouteStore, visiblePaths, type SavedChoice } from '../../src/route-store.js';

const drawing: Position[] = [[0, 0, 10], [1, 0, 20], [0, 1, 30], [0, 0, 10]];
const saved = (id: string, groupId = id, reverse = false): SavedChoice => ({
  groupId,
  route: {
    summary: { id, startId: 'east', startName: 'East trailhead', startKind: 'trailhead',
      startPosition: [0, 0, 10], trailNames: ['Circuit'], distance: 5000, gain: 200,
      roadDistance: 0, repetition: 0, kind: 'loop', uncertain: false },
    sections: [{ section: 'fixture', id: 0, reverse, name: null }],
  },
});

it('stores only one walk per hike, with immutable totals and preferred-only pagination', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'alpine-preferred-routes-'));
  const file = join(directory, 'results.sqlite');
  const store = createRouteStore(file, { writable: true });
  const count = ROUTES_PER_PAGE + 2;
  try {
    store.begin();
    for (let index = count - 1; index >= 0; index--) {
      const item = saved(`r${index.toString().padStart(2, '0')}`);
      item.route.summary.distance += index;
      store.add(item);
    }
    expect(() => store.add(saved('alternative', 'r00'))).toThrow('UNIQUE');
    store.saveGeometry('fixture', 0, drawing);
    store.commit(); store.close();
    const fixture = new DatabaseSync(file, { readOnly: true });
    try {
      expect(fixture.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all().map(row => row.name))
        .toEqual(['geometry', 'results', 'routes']);
      expect(fixture.prepare('SELECT COUNT(*) AS count FROM geometry').get()!.count).toBe(1);
    } finally { fixture.close(); }
    const published = createRouteStore(file);
    try {
      expect(published.counts).toEqual({ routeCount: count, groupCount: count });
      const exposedCounts = published.counts;
      exposedCounts.routeCount = 0;
      expect(published.page()).toMatchObject({ routeCount: count, groupCount: count, pageTotal: count, offset: 0 });
      expect(published.page().routes).toHaveLength(ROUTES_PER_PAGE);
      expect(published.page(ROUTES_PER_PAGE).routes.map(route => route.id)).toEqual(['r50', 'r51']);
      expect(published.page(0, 'distance', 'desc').routes[0]!.id).toBe('r51');
      expect(published.locations()).toHaveLength(count);
      expect(published.locations().every(route => route.highPoint === 30)).toBe(true);
      const paths = visiblePaths(published.paths(), [-1, -1, 1, 1]);
      expect(paths).toHaveLength(1);
      expect(paths[0]!.geometry).toEqual(drawing.map(([lon, lat]) => [lon, lat]));
      expect(paths[0]!.routeIds).toEqual(Array.from({ length: count }, (_, index) => `r${index.toString().padStart(2, '0')}`));
      expect(visiblePaths(published.paths(), [2, 2, 3, 3])).toEqual([]);
      expect(published.route('alternative')).toBeUndefined();
      expect(published.page().selectionNote).toContain('Alternative loops, starting points and directions are not saved');
      expect(() => published.begin()).toThrow('immutable');
      expect(() => published.add(saved('other'))).toThrow('immutable');
    } finally { published.close(); }
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

it('reuses a lollipop approach without reversing its saved drawing or losing elevation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'alpine-lollipop-drawing-'));
  const file = join(directory, 'results.sqlite');
  const store = createRouteStore(file, { writable: true });
  const approach: Position[] = [[0, 0, 10], [1, 0, 120], [2, 0, 30]];
  const loop: Position[] = [[2, 0, 30], [2, 1, 40], [3, 0, 50], [2, 0, 30]];
  const expected: Position[] = [...approach, ...loop.slice(1), ...approach.toReversed().slice(1)];
  try {
    const item = saved('lollipop');
    item.route.summary.kind = 'lollipop';
    item.route.sections = [{ section: 'fixture', id: 0, reverse: false, name: null },
      { section: 'fixture', id: 1, reverse: false, name: null }, { section: 'fixture', id: 0, reverse: true, name: null }];
    item.route.sections[0]!.name = 'Approach';
    item.route.sections[1]!.name = null;
    item.route.sections[2]!.name = 'Approach';
    store.begin(); store.add(item);
    store.saveGeometry('fixture', 0, approach); store.saveGeometry('fixture', 1, loop);
    store.saveGeometry('fixture', 99, [[-10, -10], [10, 10]]);
    store.commit(); store.close();
    const published = createRouteStore(file);
    try {
      expect(published.route('lollipop')!.geometry).toEqual(expected);
      expect(published.route('lollipop')!.segments).toEqual([
        { id: 'fixture:0', name: 'Approach', start: 0, end: 2 },
        { id: 'fixture:1', name: null, start: 2, end: 5 },
        { id: 'fixture:0', name: 'Approach', start: 5, end: 7 },
      ]);
      expect(published.route('lollipop')!.geometry).toEqual(expected);
      expect(published.locations()[0]!.bounds).toEqual([0, 0, 3, 1]);
      expect(published.locations()[0]!.highPoint).toBe(120);
      expect(visiblePaths(published.paths(), [-1, -1, 4, 2]).map(path => path.routeIds)).toEqual([['lollipop'], ['lollipop']]);
      expect(visiblePaths(published.paths(), [2.5, -.5, 3.5, .5]).map(path => path.geometry))
        .toEqual([loop.map(([lon, lat]) => [lon, lat])]);
    } finally { published.close(); }
    const fixture = new DatabaseSync(file, { readOnly: true });
    try { expect(JSON.parse(fixture.prepare('SELECT points FROM geometry WHERE trail_id = 0').get()!.points as string)).toEqual(approach); }
    finally { fixture.close(); }
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

it('keeps unknown high points distinct from zero and negative elevations in compact summaries', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'alpine-high-point-summaries-'));
  const file = join(directory, 'results.sqlite');
  const store = createRouteStore(file, { writable: true });
  try {
    const known = saved('known'), unknown = saved('unknown');
    unknown.route.sections = [{ section: 'fixture', id: 1, reverse: false, name: null }, { section: 'fixture', id: 0, reverse: true, name: null }];
    store.begin(); store.add(known); store.add(unknown);
    store.saveGeometry('fixture', 0, [[0, 0, -30], [1, 0, -10], [2, 0, -20]]);
    store.saveGeometry('fixture', 1, [[2, 0, -20], [3, 0], [4, 0, 100]]);
    store.commit(); store.close();
    const published = createRouteStore(file);
    try {
      const rows = published.locations();
      expect(rows.find(row => row.id === 'known')!.highPoint).toBe(-10);
      expect(rows.find(row => row.id === 'unknown')!.highPoint).toBeNull();
      expect(rows.every(row => !('geometry' in row))).toBe(true);
    } finally { published.close(); }
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

it.each(['missing', 'empty', 'disconnected'] as const)('rejects a %s saved drawing', async corruption => {
  const directory = await mkdtemp(join(tmpdir(), 'alpine-broken-drawing-'));
  const file = join(directory, 'results.sqlite');
  const store = createRouteStore(file, { writable: true });
  try {
    const item = saved('route');
    item.route.sections.push({ section: 'fixture', id: 1, reverse: false, name: null });
    store.begin(); store.add(item); store.saveGeometry('fixture', 0, drawing);
    if (corruption === 'disconnected') store.saveGeometry('fixture', 1, [[5, 5], [0, 0]]);
    store.commit(); store.close();
    if (corruption === 'empty') {
      const fixture = new DatabaseSync(file);
      try { fixture.prepare('INSERT INTO geometry VALUES (?, ?, ?)').run('fixture', 1, '[]'); }
      finally { fixture.close(); }
    }
    const published = createRouteStore(file);
    try { expect(() => published.route('route')).toThrow(corruption === 'disconnected' ? 'broken connection' : 'missing'); }
    finally { published.close(); }
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});
