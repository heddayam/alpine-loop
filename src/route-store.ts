import { DatabaseSync } from 'node:sqlite';
import type { StoredRoute } from './data-format.js';
import { MIN_LOOP_SIMILARITY, type CandidatePool } from './diversity.js';
import type { RouteCandidate } from './model.js';
import { ROUTES_PER_PAGE, type JobResults, type Position, type ResultSort, type RouteChoice, type RouteLocation, type RouteView, type SortOrder } from './model.js';

export type SavedChoice = { route: StoredRoute; groupId: string; variantId: string; direction: 0 | 1; reverseId?: string; oppositeId?: string; preferred: boolean; preferredVariant: boolean; preferredStart: boolean };
type ChoiceRow = { summary: string; groupId: string; variantId: string; variantCount: number; groupSize: number; reverseId: string | null };
const choice = (row: ChoiceRow): RouteChoice => ({ ...JSON.parse(row.summary), groupId: row.groupId,
  variantId: row.variantId, variantCount: row.variantCount, groupSize: row.groupSize, reverseId: row.reverseId ?? undefined });
const previousSelectionNote = 'Each hike represents a distinct main circuit. Minor variations share at least 85% common trail length, preserve its order, and have no connected difference over 1 km. Starting points and qualifying directions are available in the details. Every saved route meets the submitted limits. Searches try a bounded set of alternatives and can miss qualifying hikes.';
const selectionNote = `Each hike shows one main loop. Preferred routes are selected first. Each route version shares at least ${MIN_LOOP_SIMILARITY * 100}% of the longer main loop with the shown loop, including road sections, in the same order. No two shown main loops meet this rule. Each exact loop keeps its starting points and qualifying directions. Every saved route meets the submitted limits. Searches try a bounded set of alternatives and can miss qualifying hikes.`;

/** A worker owns this private file until it closes; the server opens only published files. */
export function createRouteStore(path: string, writable = false, revision = 0) {
  if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('Invalid saved-results revision');
  const db = new DatabaseSync(path, { readOnly: !writable });
  try {
    db.exec('PRAGMA cache_size=-4096; PRAGMA mmap_size=0; PRAGMA temp_store=FILE; PRAGMA temp.cache_size=-4096;');
    const existing = db.prepare('PRAGMA table_info(routes)').all();
    const legacy = existing.length > 0 && !existing.some(column => column.name === 'revision');
    const previous = existing.length > 0 && !existing.some(column => column.name === 'variant_id');
    if (previous && !writable) {
      if (legacy && revision !== 0) throw new Error('This results revision is not available');
      const savedRevision = legacy ? '0' : 'revision';
      if (legacy) db.exec('CREATE TEMP VIEW groups AS SELECT 0 AS revision, * FROM main.groups');
      db.exec(`
        CREATE TEMP VIEW variants AS SELECT ${savedRevision} AS revision, id, id AS group_id, first_id FROM main.groups;
        CREATE TEMP VIEW options AS SELECT ${savedRevision} AS revision, group_id AS variant_id, start_id, first_id FROM main.options;
        CREATE TEMP VIEW routes AS SELECT ${legacy ? '0 AS revision, ' : ''}*, group_id AS variant_id FROM main.routes;
      `);
    }
    if (writable) {
      if (previous) throw new Error('Previous saved results are immutable');
      db.exec(`
        PRAGMA journal_mode=DELETE;
        PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS groups (revision INTEGER, id TEXT, first_id TEXT NOT NULL, PRIMARY KEY(revision, id));
        CREATE TABLE IF NOT EXISTS variants (revision INTEGER, id TEXT, group_id TEXT NOT NULL, first_id TEXT NOT NULL, PRIMARY KEY(revision, id));
        CREATE INDEX IF NOT EXISTS grouped_variants ON variants(revision, group_id);
        CREATE TABLE IF NOT EXISTS grouping (note TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS options (revision INTEGER, variant_id TEXT, start_id TEXT, first_id TEXT NOT NULL, PRIMARY KEY(revision, variant_id, start_id));
        CREATE TABLE IF NOT EXISTS routes (revision INTEGER, id TEXT, group_id TEXT NOT NULL, variant_id TEXT NOT NULL, start_id TEXT NOT NULL,
          summary TEXT NOT NULL, steps TEXT NOT NULL, reverse_id TEXT,
          distance REAL NOT NULL, gain REAL NOT NULL, repetition REAL NOT NULL, roadDistance REAL NOT NULL, uncertain INTEGER NOT NULL,
          PRIMARY KEY(revision, id));
        CREATE INDEX IF NOT EXISTS members ON routes(revision, variant_id, start_id);
        CREATE TABLE IF NOT EXISTS geometry (section_id TEXT, trail_id INTEGER, points TEXT NOT NULL, PRIMARY KEY(section_id, trail_id));
        CREATE TEMP TABLE candidates (core TEXT, id TEXT, route TEXT NOT NULL, PRIMARY KEY(core, id));
      `);
      if (!db.prepare('SELECT 1 FROM grouping').get()) db.prepare('INSERT INTO grouping VALUES (?)').run(selectionNote);
    }
    const savedNote = previous ? previousSelectionNote : db.prepare('SELECT note FROM grouping').get()!.note as string;
    const addCandidate = writable ? db.prepare('INSERT INTO temp.candidates VALUES (?, ?, ?)') : undefined;
    const candidates = writable ? db.prepare('SELECT route FROM temp.candidates WHERE core = ? ORDER BY id') : undefined;
    const deleteCandidates = writable ? db.prepare('DELETE FROM temp.candidates WHERE core = ?') : undefined;
    const candidatePool: CandidatePool | undefined = writable ? {
      add: (core, route) => { addCandidate!.run(core, route.id, JSON.stringify(route)); },
      *routes(core) { for (const row of candidates!.iterate(core)) yield JSON.parse(row.route as string) as RouteCandidate; },
      delete: core => { deleteCandidates!.run(core); },
    } : undefined;
    const columns = `r.summary, r.group_id AS groupId, r.variant_id AS variantId,
      (SELECT COUNT(*) FROM variants WHERE revision = r.revision AND group_id = r.group_id) AS variantCount,
      (SELECT COUNT(*) FROM options WHERE revision = r.revision AND variant_id = r.variant_id) AS groupSize, r.reverse_id AS reverseId`;
    const totals = db.prepare(`SELECT (SELECT COUNT(*) FROM routes WHERE revision = ${revision}) AS routeCount,
      (SELECT COUNT(*) FROM groups WHERE revision = ${revision}) AS groupCount`);
    const detail = db.prepare(`SELECT ${columns}, r.steps FROM routes r WHERE revision = ${revision} AND id = ?`);
    const getGeometry = db.prepare('SELECT points FROM geometry WHERE section_id = ? AND trail_id = ?');
    const addRoute = writable ? db.prepare('INSERT INTO routes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)') : undefined;
    const addGroup = writable ? db.prepare('INSERT INTO groups VALUES (?, ?, ?)') : undefined;
    const addVariant = writable ? db.prepare('INSERT INTO variants VALUES (?, ?, ?, ?)') : undefined;
    const addOption = writable ? db.prepare('INSERT INTO options VALUES (?, ?, ?, ?)') : undefined;
    const addGeometry = writable ? db.prepare('INSERT OR IGNORE INTO geometry VALUES (?, ?, ?)') : undefined;
    return {
      candidatePool,
      begin(): void { db.exec('BEGIN'); },
      commit(): void { db.exec('COMMIT'); },
      add(saved: SavedChoice): void {
        if (!addRoute || !addGroup || !addVariant || !addOption) throw new Error('Saved results are immutable');
        const { route, groupId, variantId, reverseId, oppositeId, preferred, preferredVariant, preferredStart } = saved, summary = route.summary;
        addRoute.run(revision, summary.id, groupId, variantId, summary.startId, JSON.stringify({ ...summary, oppositeId }), JSON.stringify(route.sections), reverseId ?? null,
          summary.distance, summary.gain, summary.repetition, summary.roadDistance, Number(summary.uncertain));
        if (preferred) addGroup.run(revision, groupId, summary.id);
        if (preferredVariant) addVariant.run(revision, variantId, groupId, summary.id);
        if (preferredStart) addOption.run(revision, variantId, summary.startId, summary.id);
      },
      saveGeometry(sectionId: string, trailId: number, points: Position[]): void {
        if (!addGeometry || !points.length) throw new Error('Route drawing is missing');
        addGeometry.run(sectionId, trailId, JSON.stringify(points));
      },
      get counts(): { routeCount: number; groupCount: number } { return totals.get() as { routeCount: number; groupCount: number }; },
      page(offset = 0, groupId?: string, sort: ResultSort = 'distance', order: SortOrder = 'asc', variantId?: string): JobResults | undefined {
        if (groupId !== undefined && variantId !== undefined) throw new Error('Choose route versions or starting points, not both');
        const counts = totals.get() as { routeCount: number; groupCount: number };
        const filter = variantId ?? groupId;
        const table = variantId !== undefined ? 'variants' : 'groups';
        if (filter !== undefined && !db.prepare(`SELECT 1 FROM ${table} WHERE revision = ${revision} AND id = ?`).get(filter)) return undefined;
        const from = variantId !== undefined
          ? `options o JOIN routes r ON r.revision = o.revision AND r.id = o.first_id WHERE o.revision = ${revision} AND o.variant_id = ?`
          : groupId !== undefined
            ? `variants v JOIN routes r ON r.revision = v.revision AND r.id = v.first_id WHERE v.revision = ${revision} AND v.group_id = ?`
            : `groups g JOIN routes r ON r.revision = g.revision AND r.id = g.first_id WHERE g.revision = ${revision}`;
        const parameters = filter === undefined ? [] : [filter];
        const pageTotal = filter === undefined ? counts.groupCount
          : Number(db.prepare(`SELECT COUNT(*) AS size FROM ${from}`).get(...parameters)!.size);
        const rows = db.prepare(`SELECT ${columns} FROM ${from} ORDER BY r.${sort} ${order.toUpperCase()}, r.id ASC LIMIT ? OFFSET ?`)
          .all(...parameters, ROUTES_PER_PAGE, offset) as ChoiceRow[];
        return { routes: rows.map(choice), pageTotal, offset, groupId, variantId, ...counts, sort, order,
          selectionNote: savedNote };
      },
      locations(): RouteLocation[] {
        const rows = db.prepare(`SELECT r.summary, r.group_id AS groupId FROM groups g JOIN routes r ON r.revision = g.revision
          AND r.id = g.first_id WHERE g.revision = ${revision} ORDER BY g.id`).all() as { summary: string; groupId: string }[];
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
