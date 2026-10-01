import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { StoredRoute, WorkerEvent } from './data-format.js';
import { ROUTES_PER_PAGE, type RouteChoice } from './model.js';

type ChoiceRow = { summary: string; groupId: string; groupSize: number; reverseId: string | null };
const hash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 32);
const choice = (row: ChoiceRow): RouteChoice => ({ ...JSON.parse(row.summary), groupId: row.groupId,
  groupSize: row.groupSize, reverseId: row.reverseId ?? undefined });

/** Private current-search storage. SQLite deletes this unnamed temporary file on close. */
export function createRouteStore() {
  const db = new DatabaseSync('');
  try {
    db.exec(`
      PRAGMA temp_store=FILE;
      PRAGMA cache_size=-4096;
      PRAGMA mmap_size=0;
      CREATE TABLE groups (
        position INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE,
        first_id TEXT NOT NULL, size INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE options (
        position INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE,
        group_id TEXT NOT NULL, first_id TEXT NOT NULL
      );
      CREATE INDEX members ON options(group_id, position);
      CREATE TABLE routes (
        id TEXT PRIMARY KEY NOT NULL, option_id TEXT NOT NULL,
        summary TEXT NOT NULL, sections TEXT NOT NULL
      );
      CREATE INDEX directions ON routes(option_id);
    `);
    const existingRoute = db.prepare('SELECT 1 FROM routes WHERE id = ?');
    const existingOption = db.prepare('SELECT 1 FROM options WHERE id = ?');
    const addGroup = db.prepare('INSERT OR IGNORE INTO groups(id, first_id) VALUES (?, ?)');
    const addOption = db.prepare('INSERT INTO options(id, group_id, first_id) VALUES (?, ?, ?)');
    const growGroup = db.prepare('UPDATE groups SET size = size + 1 WHERE id = ?');
    const addRoute = db.prepare('INSERT INTO routes(id, option_id, summary, sections) VALUES (?, ?, ?, ?)');
    const totals = db.prepare('SELECT (SELECT COUNT(*) FROM options) AS routeCount, (SELECT COUNT(*) FROM groups) AS groupCount');
    const groupSize = db.prepare('SELECT size FROM groups WHERE id = ?');
    const columns = `r.summary, o.group_id AS groupId, g.size AS groupSize,
      (SELECT id FROM routes WHERE option_id = o.id AND id <> r.id ORDER BY rowid LIMIT 1) AS reverseId`;
    // Page queries deliberately never select sections, including for group representatives.
    const overview = db.prepare(`SELECT ${columns} FROM groups g
      JOIN routes r ON r.id = g.first_id JOIN options o ON o.id = r.option_id
      ORDER BY g.position LIMIT ? OFFSET ?`);
    const members = db.prepare(`SELECT ${columns} FROM options o
      JOIN groups g ON g.id = o.group_id JOIN routes r ON r.id = o.first_id
      WHERE o.group_id = ? ORDER BY o.position LIMIT ? OFFSET ?`);
    const detail = db.prepare(`SELECT ${columns}, r.sections FROM routes r
      JOIN options o ON o.id = r.option_id JOIN groups g ON g.id = o.group_id WHERE r.id = ?`);

    return {
      add(event: Extract<WorkerEvent, { type: 'route' }>): void {
        const id = hash(event.route.summary.id);
        if (existingRoute.get(id)) return;
        const summary = JSON.stringify({ ...event.route.summary, id });
        const sections = JSON.stringify(event.route.sections);
        db.exec('BEGIN');
        try {
          if (!existingOption.get(event.optionId)) {
            const groupId = hash(event.groupId);
            addGroup.run(groupId, id);
            addOption.run(event.optionId, groupId, id);
            growGroup.run(groupId);
          }
          addRoute.run(id, event.optionId, summary, sections);
          db.exec('COMMIT');
        } catch (error) {
          // Some SQLite errors roll back automatically; otherwise discard this add only.
          if (db.isTransaction) db.exec('ROLLBACK');
          throw error;
        }
      },
      get counts(): { routeCount: number; groupCount: number } {
        return totals.get() as { routeCount: number; groupCount: number };
      },
      page(offset: number, groupId?: string): { routes: RouteChoice[]; pageTotal: number } | undefined {
        const size = groupId === undefined ? undefined : groupSize.get(groupId);
        if (groupId !== undefined && !size) return undefined;
        const rows = groupId === undefined ? overview.all(ROUTES_PER_PAGE, offset) : members.all(groupId, ROUTES_PER_PAGE, offset);
        return { routes: (rows as ChoiceRow[]).map(choice),
          pageTotal: groupId === undefined ? Number(totals.get()!.groupCount) : Number(size!.size) };
      },
      route(id: string): { stored: StoredRoute; summary: RouteChoice } | undefined {
        const row = detail.get(id) as (ChoiceRow & { sections: string }) | undefined;
        if (!row) return undefined;
        return { stored: { summary: JSON.parse(row.summary), sections: JSON.parse(row.sections) }, summary: choice(row) };
      },
      close(): void { if (db.isOpen) db.close(); },
    };
  } catch (error) {
    db.close();
    throw error;
  }
}
