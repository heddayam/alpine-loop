import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import {
  createBatchRouteJobV1Schema,
  routeJobResultSchema,
  routeJobSchema,
  type CreateBatchRouteJobV1,
  type RouteJob,
  type RouteJobResult,
  type RouteJobStatus,
} from "@/lib/contracts";
import { areaGeometrySchema } from "@/lib/contracts";
import type { AreaGeometry } from "@/lib/graph";
import type { PinnedRouteJobPack, ResolvedDriveTime, ResolvedRouteJob } from "./types";

type Row = Record<string, SQLInputValue>;
type StoredJob = {
  id: string;
  request: CreateBatchRouteJobV1;
  pack: PinnedRouteJobPack;
  searchRegion: { id: string; name: string };
  status: RouteJobStatus;
  geometry?: AreaGeometry;
  resolvedAt?: string;
  cancelRequested: boolean;
  deleteRequested: boolean;
};

export type ResultCursor = {
  matchRank: number;
  accessOrdinal: number;
  resultOrdinal: number;
  routeId: string;
};

const TERMINAL = new Set<RouteJobStatus>(["completed", "cancelled", "failed"]);

function requiredString(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error(`Invalid route-job ${key}`);
  return value;
}

function integer(row: Row, key: string): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error(`Invalid route-job ${key}`);
  return value;
}

function parseJson(text: string): unknown {
  try { return JSON.parse(text); } catch { throw new Error("Corrupt route-job JSON"); }
}

function nowIso(now: () => Date): string {
  return now().toISOString();
}

export class SQLiteRouteJobStore {
  readonly #database: DatabaseSync;
  readonly #now: () => Date;

  constructor(path: string, now: () => Date = () => new Date()) {
    mkdirSync(dirname(path), { recursive: true });
    this.#database = new DatabaseSync(path);
    this.#now = now;
    this.#database.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.#migrate();
    this.#recover();
  }

  #migrate(): void {
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS route_job_migrations (
        version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS route_jobs (
        id TEXT PRIMARY KEY,
        request_json TEXT NOT NULL,
        pack_id TEXT NOT NULL,
        pack_data_version TEXT NOT NULL,
        pack_built_at TEXT NOT NULL,
        search_region_id TEXT NOT NULL,
        search_region_name TEXT NOT NULL,
        status TEXT NOT NULL,
        drive_time_geometry_json TEXT,
        drive_time_resolved_at TEXT,
        cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK(cancel_requested IN (0, 1)),
        delete_requested INTEGER NOT NULL DEFAULT 0 CHECK(delete_requested IN (0, 1)),
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT
      ) STRICT;
      CREATE INDEX IF NOT EXISTS route_jobs_queue ON route_jobs(status, created_at, id);
      CREATE TABLE IF NOT EXISTS route_job_access_points (
        job_id TEXT NOT NULL REFERENCES route_jobs(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
        access_point_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending', 'running', 'done', 'failed')),
        truncated INTEGER NOT NULL DEFAULT 0 CHECK(truncated IN (0, 1)),
        diagnostics_json TEXT,
        error TEXT,
        started_at TEXT,
        completed_at TEXT,
        PRIMARY KEY(job_id, ordinal),
        UNIQUE(job_id, access_point_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS route_job_results (
        job_id TEXT NOT NULL REFERENCES route_jobs(id) ON DELETE CASCADE,
        match_rank INTEGER NOT NULL CHECK(match_rank IN (0, 1)),
        access_ordinal INTEGER NOT NULL CHECK(access_ordinal >= 0),
        result_ordinal INTEGER NOT NULL CHECK(result_ordinal >= 0),
        route_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        PRIMARY KEY(job_id, match_rank, access_ordinal, result_ordinal, route_id),
        UNIQUE(job_id, route_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS route_job_results_order
        ON route_job_results(job_id, match_rank, access_ordinal, result_ordinal, route_id);
    `);
    this.#database.prepare("INSERT OR IGNORE INTO route_job_migrations(version, applied_at) VALUES (1, ?)")
      .run(nowIso(this.#now));
  }

  #recover(): void {
    const timestamp = nowIso(this.#now);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#database.prepare("DELETE FROM route_jobs WHERE status = 'deleting' OR delete_requested = 1").run();
      this.#database.prepare("UPDATE route_job_access_points SET status = 'pending', started_at = NULL WHERE status = 'running'").run();
      this.#database.prepare(`UPDATE route_jobs SET status = 'queued', updated_at = ?
        WHERE status IN ('resolving-drive-time', 'running')`).run(timestamp);
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  create(id: string, request: CreateBatchRouteJobV1, resolved: ResolvedRouteJob): void {
    const timestamp = nowIso(this.#now);
    this.#database.prepare(`INSERT INTO route_jobs(
      id, request_json, pack_id, pack_data_version, pack_built_at,
      search_region_id, search_region_name, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`).run(
      id, JSON.stringify(request), resolved.pack.id, resolved.pack.dataVersion, resolved.pack.builtAt,
      resolved.searchRegion.id, resolved.searchRegion.name, timestamp, timestamp,
    );
  }

  claimNext(): StoredJob | null {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.#database.prepare(`SELECT * FROM route_jobs
        WHERE status = 'queued' AND cancel_requested = 0 AND delete_requested = 0
        ORDER BY created_at, id LIMIT 1`).get() as Row | undefined;
      if (!row) {
        this.#database.exec("COMMIT");
        return null;
      }
      const status = row.drive_time_geometry_json === null ? "resolving-drive-time" : "running";
      const timestamp = nowIso(this.#now);
      this.#database.prepare(`UPDATE route_jobs SET status = ?, started_at = COALESCE(started_at, ?), updated_at = ?
        WHERE id = ?`).run(status, timestamp, timestamp, requiredString(row, "id"));
      this.#database.exec("COMMIT");
      return this.getStored(requiredString(row, "id"));
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  getStored(id: string): StoredJob | null {
    const row = this.#database.prepare("SELECT * FROM route_jobs WHERE id = ?").get(id) as Row | undefined;
    if (!row) return null;
    const geometryText = row.drive_time_geometry_json;
    return {
      id,
      request: createBatchRouteJobV1Schema.parse(parseJson(requiredString(row, "request_json"))),
      pack: {
        id: requiredString(row, "pack_id"),
        dataVersion: requiredString(row, "pack_data_version"),
        builtAt: requiredString(row, "pack_built_at"),
      },
      searchRegion: { id: requiredString(row, "search_region_id"), name: requiredString(row, "search_region_name") },
      status: requiredString(row, "status") as RouteJobStatus,
      ...(typeof geometryText === "string" ? { geometry: areaGeometrySchema.parse(parseJson(geometryText)) } : {}),
      ...(typeof row.drive_time_resolved_at === "string" ? { resolvedAt: row.drive_time_resolved_at } : {}),
      cancelRequested: integer(row, "cancel_requested") === 1,
      deleteRequested: integer(row, "delete_requested") === 1,
    };
  }

  saveDriveTime(id: string, driveTime: ResolvedDriveTime): void {
    this.#database.prepare(`UPDATE route_jobs SET drive_time_geometry_json = ?, drive_time_resolved_at = ?,
      status = 'running', updated_at = ? WHERE id = ?`).run(
      JSON.stringify(driveTime.geometry), driveTime.resolvedAt, nowIso(this.#now), id,
    );
  }

  initializeAccessPoints(id: string, accessPointIds: readonly string[]): void {
    const unique = [...new Set(accessPointIds)];
    if (unique.length !== accessPointIds.length) throw new Error("Eligible access-point identifiers must be unique");
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const count = this.#database.prepare("SELECT COUNT(*) AS count FROM route_job_access_points WHERE job_id = ?")
        .get(id) as Row;
      if (integer(count, "count") === 0) {
        const insert = this.#database.prepare(`INSERT INTO route_job_access_points(job_id, ordinal, access_point_id, status)
          VALUES (?, ?, ?, 'pending')`);
        accessPointIds.forEach((accessPointId, ordinal) => insert.run(id, ordinal, accessPointId));
      }
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  nextAccessPoint(id: string): { ordinal: number; accessPointId: string } | null {
    const row = this.#database.prepare(`SELECT ordinal, access_point_id FROM route_job_access_points
      WHERE job_id = ? AND status = 'pending' ORDER BY ordinal LIMIT 1`).get(id) as Row | undefined;
    if (!row) return null;
    const timestamp = nowIso(this.#now);
    const ordinal = integer(row, "ordinal");
    this.#database.prepare(`UPDATE route_job_access_points SET status = 'running', started_at = ?
      WHERE job_id = ? AND ordinal = ?`).run(timestamp, id, ordinal);
    return { ordinal, accessPointId: requiredString(row, "access_point_id") };
  }

  completeAccessPoint(
    id: string,
    ordinal: number,
    results: readonly RouteJobResult[],
    truncated: boolean,
    diagnostics?: unknown,
  ): void {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#database.prepare("DELETE FROM route_job_results WHERE job_id = ? AND access_ordinal = ?").run(id, ordinal);
      const insert = this.#database.prepare(`INSERT INTO route_job_results(
        job_id, match_rank, access_ordinal, result_ordinal, route_id, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?)`);
      let exactOrdinal = 0;
      let nearOrdinal = 0;
      for (const raw of results) {
        const result = routeJobResultSchema.parse(raw);
        const matchRank = result.matchType === "exact" ? 0 : 1;
        const resultOrdinal = matchRank === 0 ? exactOrdinal++ : nearOrdinal++;
        insert.run(id, matchRank, ordinal, resultOrdinal, result.route.id, JSON.stringify(result));
      }
      this.#database.prepare(`UPDATE route_job_access_points SET status = 'done', truncated = ?, diagnostics_json = ?,
        error = NULL, completed_at = ? WHERE job_id = ? AND ordinal = ?`).run(
        truncated ? 1 : 0, diagnostics === undefined ? null : JSON.stringify(diagnostics),
        nowIso(this.#now), id, ordinal,
      );
      this.#database.prepare("UPDATE route_jobs SET updated_at = ? WHERE id = ?").run(nowIso(this.#now), id);
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  failAccessPoint(id: string, ordinal: number, error: string): void {
    this.#database.prepare(`UPDATE route_job_access_points SET status = 'failed', error = ?, completed_at = ?
      WHERE job_id = ? AND ordinal = ?`).run(error, nowIso(this.#now), id, ordinal);
    this.#database.prepare("UPDATE route_jobs SET updated_at = ? WHERE id = ?").run(nowIso(this.#now), id);
  }

  finish(id: string, status: "completed" | "cancelled" | "failed", error?: string): void {
    const timestamp = nowIso(this.#now);
    this.#database.prepare(`UPDATE route_jobs SET status = ?, error = ?, completed_at = ?, updated_at = ?
      WHERE id = ?`).run(status, error ?? null, timestamp, timestamp, id);
  }

  requestCancel(id: string): "missing" | "terminal" | "cancelled" | "requested" {
    const job = this.getStored(id);
    if (!job) return "missing";
    if (TERMINAL.has(job.status)) return "terminal";
    const timestamp = nowIso(this.#now);
    if (job.status === "queued") {
      this.#database.prepare(`UPDATE route_jobs SET status = 'cancelled', cancel_requested = 1,
        completed_at = ?, updated_at = ? WHERE id = ?`).run(timestamp, timestamp, id);
      return "cancelled";
    }
    this.#database.prepare("UPDATE route_jobs SET cancel_requested = 1, updated_at = ? WHERE id = ?")
      .run(timestamp, id);
    return "requested";
  }

  requestDelete(id: string): "missing" | "deleted" | "requested" {
    const job = this.getStored(id);
    if (!job) return "missing";
    if (["resolving-drive-time", "running", "deleting"].includes(job.status)) {
      this.#database.prepare(`UPDATE route_jobs SET status = 'deleting', delete_requested = 1,
        cancel_requested = 1, updated_at = ? WHERE id = ?`).run(nowIso(this.#now), id);
      return "requested";
    }
    this.delete(id);
    return "deleted";
  }

  delete(id: string): void {
    this.#database.prepare("DELETE FROM route_jobs WHERE id = ?").run(id);
  }

  listIds(): string[] {
    return (this.#database.prepare("SELECT id FROM route_jobs ORDER BY created_at DESC, id DESC").all() as Row[])
      .map((row) => requiredString(row, "id"));
  }

  toPublic(id: string, stale: boolean): RouteJob | null {
    const row = this.#database.prepare(`SELECT j.*,
      (SELECT COUNT(*) FROM route_job_access_points a WHERE a.job_id = j.id) AS eligible_count,
      (SELECT COUNT(*) FROM route_job_access_points a WHERE a.job_id = j.id AND a.status IN ('done','failed')) AS processed_count,
      (SELECT COUNT(*) FROM route_job_results r WHERE r.job_id = j.id AND r.match_rank = 0) AS exact_count,
      (SELECT COUNT(*) FROM route_job_results r WHERE r.job_id = j.id AND r.match_rank = 1) AS near_count,
      (SELECT COUNT(*) FROM route_job_access_points a WHERE a.job_id = j.id AND a.truncated = 1) AS truncated_count
      FROM route_jobs j WHERE j.id = ?`).get(id) as Row | undefined;
    if (!row) return null;
    const status = requiredString(row, "status") as RouteJobStatus;
    const started = typeof row.started_at === "string" ? Date.parse(row.started_at) : Date.parse(requiredString(row, "created_at"));
    const ended = typeof row.completed_at === "string" ? Date.parse(row.completed_at) : this.#now().getTime();
    return routeJobSchema.parse({
      version: 1,
      id,
      status,
      request: createBatchRouteJobV1Schema.parse(parseJson(requiredString(row, "request_json"))),
      pack: { id: requiredString(row, "pack_id"), dataVersion: requiredString(row, "pack_data_version"), builtAt: requiredString(row, "pack_built_at") },
      searchRegion: { id: requiredString(row, "search_region_id"), name: requiredString(row, "search_region_name") },
      progress: {
        eligibleAccessPointCount: integer(row, "eligible_count"),
        processedAccessPointCount: integer(row, "processed_count"),
        exactRouteCount: integer(row, "exact_count"),
        nearMissRouteCount: integer(row, "near_count"),
        truncatedAccessPointCount: integer(row, "truncated_count"),
        elapsedMs: Math.max(0, ended - started),
      },
      partial: status === "cancelled" && integer(row, "processed_count") < integer(row, "eligible_count"),
      stale,
      createdAt: requiredString(row, "created_at"),
      updatedAt: requiredString(row, "updated_at"),
      ...(typeof row.completed_at === "string" ? { completedAt: row.completed_at } : {}),
      ...(typeof row.error === "string" ? { error: row.error } : {}),
    });
  }

  pageResults(id: string, cursor: ResultCursor | undefined, limit: number): { results: RouteJobResult[]; next?: ResultCursor } {
    const clauses = cursor ? `AND (
      match_rank > ? OR
      (match_rank = ? AND access_ordinal > ?) OR
      (match_rank = ? AND access_ordinal = ? AND result_ordinal > ?) OR
      (match_rank = ? AND access_ordinal = ? AND result_ordinal = ? AND route_id > ?)
    )` : "";
    const parameters: SQLInputValue[] = [id];
    if (cursor) parameters.push(
      cursor.matchRank,
      cursor.matchRank, cursor.accessOrdinal,
      cursor.matchRank, cursor.accessOrdinal, cursor.resultOrdinal,
      cursor.matchRank, cursor.accessOrdinal, cursor.resultOrdinal, cursor.routeId,
    );
    parameters.push(limit + 1);
    const rows = this.#database.prepare(`SELECT * FROM route_job_results WHERE job_id = ? ${clauses}
      ORDER BY match_rank, access_ordinal, result_ordinal, route_id LIMIT ?`).all(...parameters) as Row[];
    const page = rows.slice(0, limit);
    const results = page.map((row) => routeJobResultSchema.parse(parseJson(requiredString(row, "payload_json"))));
    const last = page.at(-1);
    return {
      results,
      ...(rows.length > limit && last ? { next: {
        matchRank: integer(last, "match_rank"),
        accessOrdinal: integer(last, "access_ordinal"),
        resultOrdinal: integer(last, "result_ordinal"),
        routeId: requiredString(last, "route_id"),
      } } : {}),
    };
  }

  close(): void { this.#database.close(); }
}
