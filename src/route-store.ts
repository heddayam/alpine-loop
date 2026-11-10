import { DatabaseSync } from 'node:sqlite';
import type { StoredRoute } from './data-format.js';
import { MIN_LOOP_SIMILARITY } from './diversity.js';
import { highestElevation } from './grade.js';
import { ROUTES_PER_PAGE, type Bounds, type JobResults, type Position, type ResultSort, type RouteChoice, type RouteLocation, type RoutePath, type RouteSegment, type RouteView, type SortOrder } from './model.js';

export type SavedChoice = { route: StoredRoute; groupId: string };
type Counts = { routeCount: number; groupCount: number };
type ChoiceRow = { summary: string; groupId: string };
export type IndexedPath = { extent: Bounds; path: RoutePath };
export const visiblePaths = (paths: IndexedPath[], bounds: Bounds): RoutePath[] => paths
  .filter(({ extent }) => extent[0] <= bounds[2] && extent[2] >= bounds[0] && extent[1] <= bounds[3] && extent[3] >= bounds[1])
  .map(({ path }) => path);
const extentOf = (points: Position[]): Bounds => {
  const extent: Bounds = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [longitude, latitude] of points) {
    extent[0] = Math.min(extent[0], longitude);
    extent[1] = Math.min(extent[1], latitude);
    extent[2] = Math.max(extent[2], longitude);
    extent[3] = Math.max(extent[3], latitude);
  }
  return extent;
};
const choice = (row: ChoiceRow): RouteChoice => ({ ...JSON.parse(row.summary), groupId: row.groupId });
const selectionNote = `Each hike shows one preferred qualifying walk. Similar main loops share at least ${MIN_LOOP_SIMILARITY * 100}% of the longer loop, including road sections, in the same order. Alternative loops, starting points and directions are not saved. Every shown route meets the submitted limits. Searches try a bounded set of alternatives and can miss qualifying hikes.`;

/** A worker owns this private file until it closes; the server opens only published files.
 * Each file holds one immutable publication, stored as revision 0. */
export function createRouteStore(path: string, { writable = false } = {}) {
  const db = new DatabaseSync(path, { readOnly: !writable });
  try {
    db.exec('PRAGMA cache_size=-4096; PRAGMA mmap_size=0; PRAGMA temp_store=FILE; PRAGMA temp.cache_size=-4096;');
    if (writable) {
      db.exec(`
        PRAGMA journal_mode=DELETE;
        PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS routes (revision INTEGER, id TEXT, group_id TEXT NOT NULL,
          summary TEXT NOT NULL, steps TEXT NOT NULL,
          distance REAL NOT NULL, gain REAL NOT NULL, repetition REAL NOT NULL, roadDistance REAL NOT NULL,
          PRIMARY KEY(revision, id), UNIQUE(revision, group_id));
        CREATE TABLE IF NOT EXISTS geometry (section_id TEXT, trail_id INTEGER, points TEXT NOT NULL, PRIMARY KEY(section_id, trail_id));
        CREATE TABLE IF NOT EXISTS results (revision INTEGER PRIMARY KEY, routeCount INTEGER NOT NULL, groupCount INTEGER NOT NULL, note TEXT NOT NULL);
      `);
      db.prepare('INSERT OR IGNORE INTO results VALUES (0, 0, 0, ?)').run(selectionNote);
    }
    const from = 'routes r WHERE r.revision = 0';
    const metadata = db.prepare('SELECT routeCount, groupCount, note FROM results WHERE revision = 0').get();
    if (!metadata) throw new Error('These saved results are not available');
    const savedNote = metadata.note as string;
    const counts: Counts = { routeCount: Number(metadata.routeCount), groupCount: Number(metadata.groupCount) };
    const columns = 'r.summary, r.group_id AS groupId';
    const detail = db.prepare(`SELECT ${columns}, r.steps FROM ${from} AND r.id = ?`);
    const getGeometry = db.prepare('SELECT points FROM geometry WHERE section_id = ? AND trail_id = ?');
    const shape = (step: StoredRoute['sections'][number]): Position[] => {
      const row = getGeometry.get(step.section, step.id);
      const points = row && JSON.parse(row.points as string) as Position[];
      if (!points?.length) throw new Error('Saved route drawing is missing');
      return points;
    };
    const addRoute = writable ? db.prepare('INSERT INTO routes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)') : undefined;
    const addGeometry = writable ? db.prepare('INSERT OR IGNORE INTO geometry VALUES (?, ?, ?)') : undefined;
    const saveCounts = writable ? db.prepare('UPDATE results SET routeCount = ?, groupCount = ? WHERE revision = 0') : undefined;
    const requireTransaction = () => {
      if (!writable) throw new Error('Saved results are immutable');
      if (!db.isTransaction) throw new Error('Begin a saved-results transaction before writing');
    };
    return {
      begin(): void {
        if (!writable) throw new Error('Saved results are immutable');
        db.exec('BEGIN');
      },
      commit(): void {
        requireTransaction();
        saveCounts!.run(counts.routeCount, counts.groupCount);
        db.exec('COMMIT');
      },
      add({ route, groupId }: SavedChoice): void {
        requireTransaction();
        const summary = route.summary;
        addRoute!.run(0, summary.id, groupId, JSON.stringify(summary), JSON.stringify(route.sections),
          summary.distance, summary.gain, summary.repetition, summary.roadDistance);
        counts.routeCount++; counts.groupCount++;
      },
      saveGeometry(sectionId: string, trailId: number, points: Position[]): void {
        requireTransaction();
        if (!points.length) throw new Error('Route drawing is missing');
        addGeometry!.run(sectionId, trailId, JSON.stringify(points));
      },
      get counts(): Counts { return { ...counts }; },
      page(offset = 0, sort: ResultSort = 'distance', order: SortOrder = 'asc'): JobResults {
        if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid saved-results offset');
        if (!['distance', 'gain', 'repetition', 'roadDistance'].includes(sort) || !['asc', 'desc'].includes(order)) throw new Error('Invalid saved-results ordering');
        const rows = db.prepare(`SELECT ${columns} FROM ${from} ORDER BY r.${sort} ${order.toUpperCase()}, r.id ASC LIMIT ? OFFSET ?`)
          .all(ROUTES_PER_PAGE, offset) as ChoiceRow[];
        return { routes: rows.map(choice), pageTotal: counts.groupCount, offset, ...counts, sort, order, selectionNote: savedNote };
      },
      locations(): RouteLocation[] {
        const rows = db.prepare(`SELECT ${columns}, r.steps FROM ${from} ORDER BY r.group_id`).all() as (ChoiceRow & { steps: string })[];
        // Only small extents cross the API; shared trail drawings are read once.
        const shapes = new Map<string, { bounds: Bounds; highPoint: number | null }>();
        return rows.map(row => {
          const { id, startId, startName, startPosition, trailNames, distance, gain, repetition, roadDistance, groupId } = choice(row);
          const bounds: Bounds = [Infinity, Infinity, -Infinity, -Infinity];
          let highPoint: number | null = -Infinity;
          const steps = JSON.parse(row.steps) as StoredRoute['sections'];
          if (!steps.length) throw new Error('Saved route drawing is missing');
          for (const step of steps) {
            const key = `${step.section}:${step.id}`;
            let facts = shapes.get(key);
            if (!facts) {
              const points = shape(step);
              facts = { bounds: extentOf(points), highPoint: highestElevation(points) };
              shapes.set(key, facts);
            }
            bounds[0] = Math.min(bounds[0], facts.bounds[0]);
            bounds[1] = Math.min(bounds[1], facts.bounds[1]);
            bounds[2] = Math.max(bounds[2], facts.bounds[2]);
            bounds[3] = Math.max(bounds[3], facts.bounds[3]);
            highPoint = highPoint !== null && facts.highPoint !== null ? Math.max(highPoint, facts.highPoint) : null;
          }
          return { id, startId, startName, startPosition, trailNames, distance, gain, repetition, roadDistance, groupId, bounds, highPoint };
        });
      },
      /** Every shared trail drawing with its extent; callers filter by viewport. */
      paths(): IndexedPath[] {
        const rows = db.prepare(`SELECT r.id, r.steps FROM ${from} ORDER BY r.distance, r.id`).all() as { id: string; steps: string }[];
        const paths = new Map<string, IndexedPath>();
        for (const row of rows) {
          for (const step of JSON.parse(row.steps) as StoredRoute['sections']) {
            const key = `${step.section}:${step.id}`;
            let indexed = paths.get(key);
            if (!indexed) {
              const points = shape(step);
              paths.set(key, indexed = { extent: extentOf(points), path: { id: key, routeIds: [], geometry: points.map(([lon, lat]) => [lon, lat]) } });
            }
            if (indexed.path.routeIds.at(-1) !== row.id) indexed.path.routeIds.push(row.id);
          }
        }
        return [...paths.values()];
      },
      route(id: string): RouteView | undefined {
        const row = detail.get(id) as (ChoiceRow & { steps: string }) | undefined;
        if (!row) return undefined;
        const coordinates: Position[] = [], segments: RouteSegment[] = [], shapes = new Map<string, Position[]>();
        for (const step of JSON.parse(row.steps) as StoredRoute['sections']) {
          const key = `${step.section}:${step.id}`;
          let points = shapes.get(key);
          if (!points) shapes.set(key, points = shape(step));
          const previous = coordinates.at(-1), first = points[step.reverse ? points.length - 1 : 0]!;
          if (previous && (previous[0] !== first[0] || previous[1] !== first[1])) throw new Error('Saved route drawing has a broken connection');
          const start = Math.max(0, coordinates.length - 1);
          for (let index = previous ? 1 : 0; index < points.length; index++) coordinates.push(points[step.reverse ? points.length - 1 - index : index]!);
          segments.push({ id: key, start, end: coordinates.length - 1, name: step.name });
        }
        return { ...choice(row), geometry: coordinates, segments };
      },
      close(): void { if (db.isOpen) db.close(); },
    };
  } catch (error) { db.close(); throw error; }
}
