import { DatabaseSync } from 'node:sqlite';
import type { StoredRoute } from './data-format.js';
import { MIN_LOOP_SIMILARITY } from './diversity.js';
import { ROUTES_PER_PAGE, type JobResults, type Position, type ResultSort, type RouteChoice, type RouteLocation, type RouteView, type SortOrder } from './model.js';

export type SavedChoice = { route: StoredRoute; groupId: string };
type Counts = { routeCount: number; groupCount: number };
type ChoiceRow = { summary: string; groupId: string };
type StoreOptions = { writable?: boolean; revision?: number; counts?: Counts };
const choice = (row: ChoiceRow): RouteChoice => {
  const summary = JSON.parse(row.summary);
  // Older files include links to alternatives; the public result now has one walk.
  delete summary.oppositeId;
  return { ...summary, groupId: row.groupId };
};
const previousSelectionNote = 'Each hike represents a distinct main circuit. Minor variations share at least 85% common trail length, preserve its order, and have no connected difference over 1 km. Every saved route meets the submitted limits. Searches try a bounded set of alternatives and can miss qualifying hikes.';
const selectionNote = `Each hike shows one preferred qualifying walk. Similar main loops share at least ${MIN_LOOP_SIMILARITY * 100}% of the longer loop, including road sections, in the same order. Alternative loops, starting points and directions are not saved. Every shown route meets the submitted limits. Searches try a bounded set of alternatives and can miss qualifying hikes.`;

/** A worker owns this private file until it closes; the server opens only published files. */
export function createRouteStore(path: string, { writable = false, revision = 0, counts: suppliedCounts }: StoreOptions = {}) {
  if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('Invalid saved-results revision');
  if (suppliedCounts && Object.values(suppliedCounts).some(count => !Number.isSafeInteger(count) || count < 0)) throw new Error('Invalid saved-results counts');
  const db = new DatabaseSync(path, { readOnly: !writable });
  try {
    db.exec('PRAGMA cache_size=-4096; PRAGMA mmap_size=0; PRAGMA temp_store=FILE; PRAGMA temp.cache_size=-4096;');
    const existing = db.prepare('PRAGMA table_info(routes)').all();
    const oldFormat = existing.some(column => column.name === 'start_id');
    const hasRevision = !existing.length || existing.some(column => column.name === 'revision');
    if (!hasRevision && revision !== 0) throw new Error('This results revision is not available');
    if (writable) {
      if (oldFormat) throw new Error('Previous saved results are immutable');
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
      db.prepare('INSERT OR IGNORE INTO results VALUES (?, 0, 0, ?)').run(revision, selectionNote);
    }
    const revisionFilter = hasRevision ? `r.revision = ${revision}` : '1';
    const from = oldFormat
      ? `groups g JOIN routes r ON ${hasRevision ? 'r.revision = g.revision AND ' : ''}r.id = g.first_id WHERE ${revisionFilter}`
      : `routes r WHERE ${revisionFilter}`;
    const metadata = !oldFormat ? db.prepare('SELECT routeCount, groupCount, note FROM results WHERE revision = ?').get(revision) : undefined;
    if (!oldFormat && !metadata) throw new Error('This results revision is not available');
    const savedNote = oldFormat && existing.some(column => column.name === 'variant_id')
      ? db.prepare('SELECT note FROM grouping').get()!.note as string
      : metadata?.note as string | undefined ?? previousSelectionNote;
    let counts: Counts | undefined = metadata ? { routeCount: Number(metadata.routeCount), groupCount: Number(metadata.groupCount) } : suppliedCounts && { ...suppliedCounts };
    const readCounts = (): Counts => {
      // Published counts never change. Old files need at most one fallback scan
      // per connection; completed job metadata normally supplies these totals.
      return counts ??= db.prepare(`SELECT (SELECT COUNT(*) FROM routes r WHERE ${revisionFilter}) AS routeCount,
        (SELECT COUNT(*) FROM ${from}) AS groupCount`).get() as Counts;
    };
    const columns = 'r.summary, r.group_id AS groupId';
    const detail = db.prepare(`SELECT ${columns}, r.steps FROM routes r WHERE ${revisionFilter} AND r.id = ?`);
    const getGeometry = db.prepare('SELECT points FROM geometry WHERE section_id = ? AND trail_id = ?');
    const addRoute = writable ? db.prepare('INSERT INTO routes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)') : undefined;
    const addGeometry = writable ? db.prepare('INSERT OR IGNORE INTO geometry VALUES (?, ?, ?)') : undefined;
    const saveCounts = writable ? db.prepare('UPDATE results SET routeCount = ?, groupCount = ? WHERE revision = ?') : undefined;
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
        const current = readCounts();
        saveCounts!.run(current.routeCount, current.groupCount, revision);
        db.exec('COMMIT');
      },
      add({ route, groupId }: SavedChoice): void {
        requireTransaction();
        const summary = route.summary;
        addRoute!.run(revision, summary.id, groupId, JSON.stringify(summary), JSON.stringify(route.sections),
          summary.distance, summary.gain, summary.repetition, summary.roadDistance);
        const current = readCounts();
        current.routeCount++; current.groupCount++;
      },
      saveGeometry(sectionId: string, trailId: number, points: Position[]): void {
        requireTransaction();
        if (!points.length) throw new Error('Route drawing is missing');
        addGeometry!.run(sectionId, trailId, JSON.stringify(points));
      },
      get counts(): Counts { return { ...readCounts() }; },
      page(offset = 0, sort: ResultSort = 'distance', order: SortOrder = 'asc'): JobResults {
        if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid saved-results offset');
        if (!['distance', 'gain', 'repetition', 'roadDistance'].includes(sort) || !['asc', 'desc'].includes(order)) throw new Error('Invalid saved-results ordering');
        const current = readCounts();
        const rows = db.prepare(`SELECT ${columns} FROM ${from} ORDER BY r.${sort} ${order.toUpperCase()}, r.id ASC LIMIT ? OFFSET ?`)
          .all(ROUTES_PER_PAGE, offset) as ChoiceRow[];
        return { routes: rows.map(choice), pageTotal: current.groupCount, offset, ...current, sort, order, selectionNote: savedNote };
      },
      locations(): RouteLocation[] {
        const rows = db.prepare(`SELECT ${columns} FROM ${from} ORDER BY r.group_id`).all() as ChoiceRow[];
        return rows.map(row => {
          const { id, startId, startName, startPosition, trailNames, distance, groupId } = choice(row);
          return { id, startId, startName, startPosition, trailNames, distance, groupId };
        });
      },
      route(id: string): RouteView | undefined {
        const row = detail.get(id) as (ChoiceRow & { steps: string }) | undefined;
        if (!row) return undefined;
        const coordinates: Position[] = [], shapes = new Map<string, Position[]>();
        for (const step of JSON.parse(row.steps) as StoredRoute['sections']) {
          const key = `${step.section}:${step.id}`;
          let points = shapes.get(key);
          if (!points) {
            const shape = getGeometry.get(step.section, step.id);
            if (!shape) throw new Error('Saved route drawing is missing');
            points = JSON.parse(shape.points as string) as Position[];
            if (!points.length) throw new Error('Saved route drawing is missing');
            shapes.set(key, points);
          }
          const previous = coordinates.at(-1), first = points[step.reverse ? points.length - 1 : 0]!;
          if (previous && (previous[0] !== first[0] || previous[1] !== first[1])) throw new Error('Saved route drawing has a broken connection');
          for (let index = previous ? 1 : 0; index < points.length; index++) coordinates.push(points[step.reverse ? points.length - 1 - index : index]!);
        }
        return { ...choice(row), geometry: coordinates };
      },
      close(): void { if (db.isOpen) db.close(); },
    };
  } catch (error) { db.close(); throw error; }
}
