import { expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ROUTES_PER_PAGE } from '../../src/model.js';
import { createRouteStore, type SavedChoice } from '../../src/route-store.js';

const drawing: [number, number][] = [[0, 0], [1, 0], [0, 1], [0, 0]];
const saved = (variantId: string, startId: string, selected: boolean, firstVariant = true, firstStart = true): SavedChoice => ({
  groupId: 'hike', variantId, direction: selected ? 1 : 0,
  preferred: selected && firstVariant && firstStart, preferredVariant: selected && firstStart, preferredStart: selected,
  reverseId: `${selected ? 'a' : 'z'}-${variantId}-${startId}`, oppositeId: `${selected ? 'a' : 'z'}-${variantId}-${startId}`,
  route: {
    summary: { id: `${selected ? 'z' : 'a'}-${variantId}-${startId}`, startId, startName: startId, startKind: 'trailhead',
      startPosition: [0, 0], trailNames: ['Circuit'], distance: 5000, gain: 200,
      roadDistance: 0, repetition: 0, kind: 'loop', uncertain: false },
    sections: [{ section: 'fixture', id: 0, reverse: selected }],
  },
});

it.each(['first', 'last'])('keeps selected representatives when they arrive %s, including tied directions', async order => {
  const directory = await mkdtemp(join(tmpdir(), 'alpine-representatives-'));
  const file = join(directory, 'results.sqlite');
  const store = createRouteStore(file, true);
  try {
    const choices = [saved('circuit', 'west', true, true, false), saved('circuit', 'east', true),
      saved('circuit', 'west', false, true, false), saved('circuit', 'east', false)];
    if (order === 'last') choices.reverse();
    store.begin();
    for (const item of choices) store.add(item);
    store.saveGeometry('fixture', 0, drawing);
    store.commit();
    store.close();
    const published = createRouteStore(file);
    try {
      expect(published.counts).toEqual({ routeCount: 4, groupCount: 1 });
      expect(published.page()!.routes.map(route => route.id)).toEqual(['z-circuit-east']);
      expect(published.locations().map(route => route.id)).toEqual(['z-circuit-east']);
      expect(published.page(0, 'hike')!.routes.map(route => route.id)).toEqual(['z-circuit-east']);
      expect(published.page(0, undefined, 'distance', 'asc', 'circuit')!.routes.map(route => route.id)).toEqual(['z-circuit-east', 'z-circuit-west']);
      const west = published.route('z-circuit-west')!;
      expect([west.reverseId, west.oppositeId, west.groupSize, west.variantId, west.variantCount])
        .toEqual(['a-circuit-west', 'a-circuit-west', 2, 'circuit', 1]);
      expect(west.geometry).toEqual(drawing.toReversed());
      expect(published.route('a-circuit-west')!.reverseId).toBe('z-circuit-west');
    } finally { published.close(); }
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

it('keeps versions at the same start distinct and pages versions and starting points independently', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'alpine-versions-'));
  const file = join(directory, 'results.sqlite');
  const store = createRouteStore(file, true);
  const count = ROUTES_PER_PAGE + 1;
  try {
    store.begin();
    for (let variant = count - 1; variant >= 0; variant--) {
      for (let start = (variant === 0 ? count : 1) - 1; start >= 0; start--) {
        for (const selected of [false, true]) {
          const item = saved(`v${variant.toString().padStart(2, '0')}`, `s${start.toString().padStart(2, '0')}`, selected, variant === 0, start === 0);
          item.route.summary.distance += variant;
          store.add(item);
        }
      }
    }
    store.saveGeometry('fixture', 0, drawing);
    store.commit();
    store.close();
    const published = createRouteStore(file);
    try {
      expect(published.counts).toEqual({ groupCount: 1, routeCount: 4 * count - 2 });
      expect(published.page()!.routes[0]).toMatchObject({ id: 'z-v00-s00', variantCount: count, groupSize: count });
      const versions = [...published.page(0, 'hike')!.routes, ...published.page(ROUTES_PER_PAGE, 'hike')!.routes];
      expect(versions.map(route => route.variantId)).toEqual(Array.from({ length: count }, (_, i) => `v${i.toString().padStart(2, '0')}`));
      expect(versions.every(route => route.startId === 's00' && route.variantCount === count)).toBe(true);
      expect(versions[1]!.groupSize).toBe(1);
      expect(published.page(0, 'hike', 'distance', 'desc')!.routes[0]!.variantId).toBe('v50');
      const firstStarts = published.page(0, undefined, 'distance', 'asc', 'v00')!;
      const lastStarts = published.page(ROUTES_PER_PAGE, undefined, 'distance', 'asc', 'v00')!;
      expect(firstStarts).toMatchObject({ variantId: 'v00', pageTotal: count });
      expect(firstStarts.routes).toHaveLength(ROUTES_PER_PAGE);
      expect(lastStarts.routes.map(route => route.startId)).toEqual(['s50']);
      const route = published.route('z-v00-s00')!;
      const opposite = published.route(route.oppositeId!)!;
      expect(opposite).toMatchObject({ variantId: route.variantId, startId: route.startId, oppositeId: route.id });
      expect(opposite.geometry).toEqual(route.geometry.toReversed());
      expect(published.page(0, 'missing')).toBeUndefined();
      expect(published.page(0, undefined, 'distance', 'asc', 'missing')).toBeUndefined();
      expect(published.page()!.selectionNote).toContain('60%');
    } finally { published.close(); }
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

it.each([false, true])('reads previous published results without changing their file (revision column: %s)', async withRevision => {
  const directory = await mkdtemp(join(tmpdir(), 'alpine-previous-results-'));
  const file = join(directory, 'results.sqlite');
  const revision = withRevision ? 3 : 0;
  const fixture = new DatabaseSync(file);
  try {
    const revisionColumn = withRevision ? 'revision INTEGER, ' : '';
    fixture.exec(`
      CREATE TABLE groups (${revisionColumn}id TEXT, first_id TEXT);
      CREATE TABLE options (${revisionColumn}group_id TEXT, start_id TEXT, first_id TEXT);
      CREATE TABLE routes (${revisionColumn}id TEXT, group_id TEXT, start_id TEXT, summary TEXT, steps TEXT, reverse_id TEXT,
        distance REAL, gain REAL, repetition REAL, roadDistance REAL, uncertain INTEGER);
      CREATE TABLE geometry (section_id TEXT, trail_id INTEGER, points TEXT);
    `);
    const prefix = withRevision ? [revision] : [];
    const placeholders = (size: number) => Array(size + prefix.length).fill('?').join(',');
    fixture.prepare(`INSERT INTO groups VALUES (${placeholders(2)})`).run(...prefix, 'hike', 'z-old-east');
    for (const startId of ['east', 'west']) {
      fixture.prepare(`INSERT INTO options VALUES (${placeholders(3)})`).run(...prefix, 'hike', startId, `z-old-${startId}`);
      for (const selected of [true, false]) {
        const item = saved('old', startId, selected), summary = item.route.summary;
        fixture.prepare(`INSERT INTO routes VALUES (${placeholders(11)})`).run(...prefix, summary.id, 'hike', startId,
          JSON.stringify({ ...summary, oppositeId: item.oppositeId }), JSON.stringify(item.route.sections), item.reverseId!,
          summary.distance, summary.gain, summary.repetition, summary.roadDistance, Number(summary.uncertain));
      }
    }
    fixture.prepare('INSERT INTO geometry VALUES (?, ?, ?)').run('fixture', 0, JSON.stringify(drawing));
    fixture.close();
    const before = await readFile(file);
    const published = createRouteStore(file, false, revision);
    try {
      expect(published.page()!.routes[0]).toMatchObject({ id: 'z-old-east', variantId: 'hike', variantCount: 1, groupSize: 2 });
      expect(published.page(0, 'hike')!.routes.map(route => route.id)).toEqual(['z-old-east']);
      expect(published.page(0, undefined, 'distance', 'asc', 'hike')!.routes.map(route => route.id)).toEqual(['z-old-east', 'z-old-west']);
      expect(published.route('z-old-west')!.geometry).toEqual(drawing.toReversed());
      expect(published.page()!.selectionNote).toContain('85%');
      expect(() => published.add(saved('old', 'east', true))).toThrow('immutable');
    } finally { published.close(); }
    expect(await readFile(file)).toEqual(before);
  } finally { if (fixture.isOpen) fixture.close(); await rm(directory, { recursive: true, force: true }); }
});
