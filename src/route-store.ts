import { DatabaseSync } from 'node:sqlite';
import type { StoredRoute } from './data-format.js';
import { ROUTES_PER_PAGE, type JobResults, type Position, type ResultSort, type RouteChoice, type RouteLocation, type RouteView, type SortOrder } from './model.js';

export type SavedChoice = { route: StoredRoute; groupId: string; direction: 0 | 1; reverseId?: string; oppositeId?: string; preferred: boolean };
type ChoiceRow = { summary: string; groupId: string; groupSize: number; reverseId: string | null };
const choice = (row: ChoiceRow): RouteChoice => ({ ...JSON.parse(row.summary), groupId: row.groupId,
  groupSize: row.groupSize, reverseId: row.reverseId ?? undefined });
const selectionNote = 'Each hike represents a distinct main circuit. Minor variations share at least 85% common trail length, preserve its order, and have no connected difference over 1 km. Starting points and qualifying directions are available in the details. Every saved route meets the submitted limits. Searches try a bounded set of alternatives and can miss qualifying hikes.';

/** A worker owns this private file until it closes; the server opens only published files. */
export function createRouteStore(path: string, writable = false) {
  const db = new DatabaseSync(path, { readOnly: !writable });
  try {
    db.exec('PRAGMA cache_size=-4096; PRAGMA mmap_size=0;');
    if (writable) db.exec(`
      PRAGMA journal_mode=DELETE;
      PRAGMA synchronous=FULL;
      CREATE TABLE groups (id TEXT PRIMARY KEY, first_id TEXT NOT NULL);
      CREATE TABLE options (group_id TEXT, start_id TEXT, first_id TEXT NOT NULL, PRIMARY KEY(group_id, start_id));
      CREATE TABLE routes (id TEXT PRIMARY KEY, group_id TEXT NOT NULL, start_id TEXT NOT NULL,
        summary TEXT NOT NULL, steps TEXT NOT NULL, reverse_id TEXT,
        distance REAL NOT NULL, gain REAL NOT NULL, repetition REAL NOT NULL, roadDistance REAL NOT NULL, uncertain INTEGER NOT NULL);
      CREATE INDEX members ON routes(group_id, start_id);
      CREATE TABLE geometry (section_id TEXT, trail_id INTEGER, points TEXT NOT NULL, PRIMARY KEY(section_id, trail_id));
    `);
    const columns = `r.summary, r.group_id AS groupId,
      (SELECT COUNT(*) FROM options WHERE group_id = r.group_id) AS groupSize, r.reverse_id AS reverseId`;
    const totals = db.prepare('SELECT (SELECT COUNT(*) FROM routes) AS routeCount, (SELECT COUNT(*) FROM groups) AS groupCount');
    const detail = db.prepare(`SELECT ${columns}, r.steps FROM routes r WHERE id = ?`);
    const getGeometry = db.prepare('SELECT points FROM geometry WHERE section_id = ? AND trail_id = ?');
    const addRoute = writable ? db.prepare(`INSERT INTO routes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`): undefined;
    const addGroup = writable ? db.prepare('INSERT OR IGNORE INTO groups VALUES (?, ?)') : undefined;
    const setGroup = writable ? db.prepare('UPDATE groups SET first_id = ? WHERE id = ?') : undefined;
    const addOption = writable ? db.prepare('INSERT OR IGNORE INTO options VALUES (?, ?, ?)') : undefined;
    const addGeometry = writable ? db.prepare('INSERT OR IGNORE INTO geometry VALUES (?, ?, ?)') : undefined;
    const preferredOption = db.prepare(`SELECT id FROM routes WHERE group_id = ? AND start_id = ?
      ORDER BY uncertain, roadDistance, repetition, distance, id LIMIT 1`);
    return {
      begin(): void { db.exec('BEGIN'); },
      commit(): void { db.exec('COMMIT'); },
      add(saved: SavedChoice): void {
        if (!addRoute || !addGroup || !setGroup || !addOption) throw new Error('Saved results are immutable');
        const { route, groupId, reverseId, oppositeId, preferred } = saved, summary = route.summary;
        addRoute.run(summary.id, groupId, summary.startId, JSON.stringify({ ...summary, oppositeId }), JSON.stringify(route.sections), reverseId ?? null,
          summary.distance, summary.gain, summary.repetition, summary.roadDistance, Number(summary.uncertain));
        addGroup.run(groupId, summary.id);
        if (preferred) setGroup.run(summary.id, groupId);
        addOption.run(groupId, summary.startId, summary.id);
        const best = preferredOption.get(groupId, summary.startId)!;
        db.prepare('UPDATE options SET first_id = ? WHERE group_id = ? AND start_id = ?').run(best.id as string, groupId, summary.startId);
      },
      saveGeometry(sectionId: string, trailId: number, points: Position[]): void {
        if (!addGeometry || !points.length) throw new Error('Route drawing is missing');
        addGeometry.run(sectionId, trailId, JSON.stringify(points));
      },
      get counts(): { routeCount: number; groupCount: number } { return totals.get() as { routeCount: number; groupCount: number }; },
      page(offset = 0, groupId?: string, sort: ResultSort = 'distance', order: SortOrder = 'asc'): JobResults | undefined {
        const counts = totals.get() as { routeCount: number; groupCount: number };
        const pageTotal = groupId === undefined ? counts.groupCount
          : Number(db.prepare('SELECT COUNT(*) AS size FROM options WHERE group_id = ?').get(groupId)!.size);
        if (groupId !== undefined && !db.prepare('SELECT 1 FROM groups WHERE id = ?').get(groupId)) return undefined;
        const from = groupId === undefined ? 'groups g JOIN routes r ON r.id = g.first_id'
          : 'options o JOIN routes r ON r.id = o.first_id WHERE o.group_id = ?';
        const rows = db.prepare(`SELECT ${columns} FROM ${from} ORDER BY r.${sort} ${order.toUpperCase()}, r.id ASC LIMIT ? OFFSET ?`)
          .all(...(groupId === undefined ? [] : [groupId]), ROUTES_PER_PAGE, offset) as ChoiceRow[];
        return { routes: rows.map(choice), pageTotal, offset, groupId, ...counts, sort, order, selectionNote };
      },
      locations(): RouteLocation[] {
        const rows = db.prepare('SELECT r.summary, r.group_id AS groupId FROM groups g JOIN routes r ON r.id = g.first_id ORDER BY g.id').all() as { summary: string; groupId: string }[];
        return rows.map(row => {
          const { id, startId, startName, startPosition, trailNames, distance } = JSON.parse(row.summary) as RouteChoice;
          return { id, startId, startName, startPosition, trailNames, distance, groupId: row.groupId };
        });
      },
      route(id: string): RouteView | undefined {
        const row = detail.get(id) as (ChoiceRow & { steps: string }) | undefined;
        if (!row) return undefined;
        const coordinates: Position[] = [];
        for (const step of JSON.parse(row.steps) as StoredRoute['sections']) {
          const shape = getGeometry.get(step.section, step.id);
          if (!shape) throw new Error('Saved route drawing is missing');
          const points = JSON.parse(shape.points as string) as Position[];
          if (step.reverse) points.reverse();
          const previous = coordinates.at(-1);
          if (previous && (previous[0] !== points[0]![0] || previous[1] !== points[0]![1])) throw new Error('Saved route drawing has a broken connection');
          for (let index = previous ? 1 : 0; index < points.length; index++) coordinates.push(points[index]!);
        }
        return { ...choice(row), geometry: coordinates };
      },
      close(): void { if (db.isOpen) db.close(); },
    };
  } catch (error) { db.close(); throw error; }
}
