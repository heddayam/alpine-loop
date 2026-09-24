import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  coverageJobSchema, coveragePlanSchema, coverageSnapshotSchema, coverageUnitSchema,
  type CoverageJob, type CoveragePlan,
} from "@/lib/contracts/coverage";
import type { CoverageProgressUpdate, CoverageRunResult, StoredCoverageJob } from "./types";

const LEASE_STALE_MS = 15_000;
type Row = Record<string, unknown>;
type Clock = () => number;

function requiredString(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error(`Corrupt coverage job ${key}`);
  return value;
}
function requiredInteger(row: Row, key: string): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error(`Corrupt coverage job ${key}`);
  return value;
}
function parseJson(value: unknown): unknown {
  if (typeof value !== "string") throw new Error("Corrupt coverage job JSON");
  return JSON.parse(value);
}
function processAlive(pid: number): boolean {
  if (pid <= 0 || !Number.isSafeInteger(pid)) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

export class SQLiteCoverageJobStore {
  readonly #db: DatabaseSync;
  readonly #now: Clock;

  constructor(file: string, now: Clock = Date.now) {
    mkdirSync(dirname(file), { recursive: true });
    this.#db = new DatabaseSync(file);
    this.#now = now;
    this.#db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS coverage_plans (
        id TEXT PRIMARY KEY, payload_json TEXT NOT NULL, created_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS coverage_jobs (
        id TEXT PRIMARY KEY,
        plan_id TEXT NOT NULL REFERENCES coverage_plans(id),
        status TEXT NOT NULL CHECK(status IN ('queued','running','pausing','paused','cancelled','failed','completed')),
        mode TEXT NOT NULL CHECK(mode IN ('build','publish')),
        control_action TEXT CHECK(control_action IN ('pause','cancel')),
        stage TEXT NOT NULL, completed_units INTEGER NOT NULL CHECK(completed_units >= 0),
        total_units INTEGER NOT NULL CHECK(total_units >= 0), units_json TEXT NOT NULL,
        snapshot_json TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS coverage_jobs_queue ON coverage_jobs(status,created_at,id);
      CREATE TABLE IF NOT EXISTS coverage_writer_lease (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1), token TEXT NOT NULL,
        pid INTEGER NOT NULL, heartbeat_ms INTEGER NOT NULL
      ) STRICT;
    `);
  }

  close(): void { this.#db.close(); }
  #iso(): string { return new Date(this.#now()).toISOString(); }
  #tx<T>(fn: () => T): T {
    this.#db.exec("BEGIN IMMEDIATE");
    try { const result = fn(); this.#db.exec("COMMIT"); return result; }
    catch (error) { this.#db.exec("ROLLBACK"); throw error; }
  }
  #lease(): Row | undefined {
    return this.#db.prepare("SELECT token,pid,heartbeat_ms FROM coverage_writer_lease WHERE singleton=1").get() as Row | undefined;
  }
  #recoverStaleLocked(): boolean {
    const lease = this.#lease();
    if (lease) {
      const heartbeat = requiredInteger(lease, "heartbeat_ms");
      const pid = requiredInteger(lease, "pid");
      if (this.#now() - heartbeat < LEASE_STALE_MS || processAlive(pid)) return false;
      this.#db.prepare("DELETE FROM coverage_writer_lease WHERE singleton=1").run();
    }
    // No live lease can own these states. Preserve prepared units and prior snapshots.
    const timestamp = this.#iso();
    this.#db.prepare(`UPDATE coverage_jobs SET status=CASE WHEN control_action='cancel' THEN 'cancelled' ELSE 'paused' END,
      stage=CASE WHEN control_action='cancel' THEN 'Cancelled after worker exit' ELSE 'Paused after worker exit' END,
      control_action=NULL,updated_at=? WHERE status IN ('running','pausing')`).run(timestamp);
    return true;
  }
  recoverStaleLease(): boolean { return this.#tx(() => this.#recoverStaleLocked()); }
  acquireLease(token: string, pid: number): boolean {
    return this.#tx(() => {
      this.#recoverStaleLocked();
      if (this.#lease()) return false;
      this.#db.prepare("INSERT INTO coverage_writer_lease VALUES (1,?,?,?)").run(token, pid, this.#now());
      return true;
    });
  }
  heartbeat(token: string): boolean {
    const result = this.#db.prepare("UPDATE coverage_writer_lease SET heartbeat_ms=? WHERE singleton=1 AND token=?")
      .run(this.#now(), token);
    return result.changes === 1;
  }
  releaseLease(token: string): void {
    this.#tx(() => {
      const row = this.#lease();
      if (!row || row.token !== token) return;
      this.#db.prepare("DELETE FROM coverage_writer_lease WHERE singleton=1 AND token=?").run(token);
      this.#recoverStaleLocked();
    });
  }
  private assertOwner(token: string): void {
    if (this.#lease()?.token !== token) throw new Error("Coverage writer lease was lost");
  }

  savePlan(plan: CoveragePlan): CoveragePlan {
    const value = coveragePlanSchema.parse(plan);
    const payload = JSON.stringify(value);
    this.#tx(() => {
      const row = this.#db.prepare("SELECT payload_json FROM coverage_plans WHERE id=?").get(value.id) as Row | undefined;
      if (row && row.payload_json !== payload) throw new Error(`Coverage plan ${value.id} has conflicting content`);
      if (!row) this.#db.prepare("INSERT INTO coverage_plans VALUES (?,?,?)").run(value.id, payload, this.#iso());
    });
    return value;
  }
  getPlan(id: string): CoveragePlan | null {
    const row = this.#db.prepare("SELECT payload_json FROM coverage_plans WHERE id=?").get(id) as Row | undefined;
    return row ? coveragePlanSchema.parse(parseJson(row.payload_json)) : null;
  }
  createJob(planId: string, id: string = randomUUID()): CoverageJob {
    const plan = this.getPlan(planId);
    if (!plan) throw new Error(`Coverage plan ${planId} was not found`);
    const timestamp = this.#iso();
    this.#db.prepare(`INSERT INTO coverage_jobs(id,plan_id,status,mode,stage,completed_units,total_units,units_json,created_at,updated_at)
      VALUES (?,?,'queued','build','Queued',0,?,?,?,?)`).run(id,planId,plan.units.length,JSON.stringify(plan.units),timestamp,timestamp);
    return this.getJob(id)!;
  }
  #job(row: Row): StoredCoverageJob {
    const plan = this.getPlan(requiredString(row, "plan_id"));
    if (!plan) throw new Error("Coverage job references a missing plan");
    const snapshot = row.snapshot_json === null ? null : coverageSnapshotSchema.parse(parseJson(row.snapshot_json));
    const units = coverageUnitSchema.array().parse(parseJson(row.units_json));
    return { ...coverageJobSchema.parse({
      id: row.id, plan: { ...plan, units }, status: row.status, stage: row.stage,
      completedUnits: row.completed_units, totalUnits: row.total_units,
      createdAt: row.created_at, updatedAt: row.updated_at, error: row.error, snapshot,
    }), mode: requiredString(row, "mode") as "build" | "publish" };
  }
  getStoredJob(id: string): StoredCoverageJob | null {
    const row = this.#db.prepare("SELECT * FROM coverage_jobs WHERE id=?").get(id) as Row | undefined;
    return row ? this.#job(row) : null;
  }
  getJob(id: string): CoverageJob | null {
    const job = this.getStoredJob(id);
    if (!job) return null;
    return coverageJobSchema.parse(job);
  }
  listJobs(): CoverageJob[] {
    const rows = this.#db.prepare("SELECT * FROM coverage_jobs ORDER BY created_at DESC,id DESC").all() as Row[];
    return rows.map((row) => coverageJobSchema.parse(this.#job(row)));
  }
  claimNext(token: string): StoredCoverageJob | null {
    return this.#tx(() => {
      this.assertOwner(token);
      const row = this.#db.prepare("SELECT id FROM coverage_jobs WHERE status='queued' ORDER BY created_at,id LIMIT 1").get() as Row | undefined;
      if (!row) return null;
      const id = requiredString(row, "id");
      this.#db.prepare("UPDATE coverage_jobs SET status='running',stage=CASE WHEN mode='publish' THEN 'Publishing prepared units' ELSE 'Building coverage' END,updated_at=? WHERE id=?").run(this.#iso(),id);
      return this.getStoredJob(id);
    });
  }
  checkpoint(id: string, token: string): "continue" | "pause" | "cancel" | "publish" {
    this.assertOwner(token);
    const row = this.#db.prepare("SELECT status,control_action,mode FROM coverage_jobs WHERE id=?").get(id) as Row | undefined;
    if (!row) return "cancel";
    if (row.control_action === "cancel" || row.status === "cancelled") return "cancel";
    if (row.control_action === "pause" || row.status === "pausing") return "pause";
    return row.mode === "publish" ? "publish" : "continue";
  }
  report(id: string, token: string, update: CoverageProgressUpdate): void {
    this.assertOwner(token);
    const row = this.#db.prepare("SELECT * FROM coverage_jobs WHERE id=?").get(id) as Row | undefined;
    if (!row || !["running","pausing"].includes(requiredString(row,"status"))) throw new Error("Coverage job is not running");
    const stage = update.stage ?? requiredString(row,"stage");
    const units = update.units === undefined ? parseJson(row.units_json) : coverageUnitSchema.array().parse(update.units);
    const completed = update.completedUnits ?? requiredInteger(row,"completed_units");
    if (!Number.isSafeInteger(completed) || completed < 0 || completed > requiredInteger(row,"total_units")) throw new Error("Invalid completed unit count");
    const snapshot = update.snapshot === undefined ? row.snapshot_json : update.snapshot === null ? null : JSON.stringify(coverageSnapshotSchema.parse(update.snapshot));
    this.#db.prepare("UPDATE coverage_jobs SET stage=?,completed_units=?,units_json=?,snapshot_json=?,updated_at=? WHERE id=?")
      .run(stage,completed,JSON.stringify(units),snapshot as string|null,this.#iso(),id);
  }
  finish(id: string, token: string, result: CoverageRunResult): CoverageJob {
    return this.#tx(() => {
      this.assertOwner(token);
      const control = this.checkpoint(id,token);
      const row = this.#db.prepare("SELECT mode,snapshot_json,total_units FROM coverage_jobs WHERE id=?").get(id) as Row;
      const status = control === "cancel" ? "cancelled" : control === "pause" || row.mode === "publish" ? "paused" : result.status;
      const units = coverageUnitSchema.array().parse(result.units);
      if (!Number.isSafeInteger(result.completedUnits) || result.completedUnits < 0 || result.completedUnits > requiredInteger(row,"total_units")) throw new Error("Invalid completed unit count");
      const snapshot = result.snapshot === null ? row.snapshot_json : JSON.stringify(coverageSnapshotSchema.parse(result.snapshot));
      this.#db.prepare(`UPDATE coverage_jobs SET status=?,stage=?,completed_units=?,units_json=?,snapshot_json=?,control_action=NULL,error=NULL,updated_at=? WHERE id=?`)
        .run(status,status === "completed" ? "Completed" : status === "cancelled" ? "Cancelled" : "Paused",result.completedUnits,JSON.stringify(units),snapshot as string|null,this.#iso(),id);
      return this.getJob(id)!;
    });
  }
  finishStopped(id: string, token: string): CoverageJob {
    return this.#tx(() => {
      this.assertOwner(token);
      const action = this.checkpoint(id,token);
      const status = action === "cancel" ? "cancelled" : "paused";
      this.#db.prepare("UPDATE coverage_jobs SET status=?,stage=?,control_action=NULL,updated_at=? WHERE id=?")
        .run(status,status === "cancelled" ? "Cancelled" : "Paused",this.#iso(),id);
      return this.getJob(id)!;
    });
  }
  fail(id: string, token: string, error: unknown): CoverageJob {
    return this.#tx(() => {
      this.assertOwner(token);
      const action = this.checkpoint(id,token);
      const status = action === "cancel" ? "cancelled" : action === "pause" ? "paused" : "failed";
      const message = error instanceof Error ? error.message : String(error);
      this.#db.prepare("UPDATE coverage_jobs SET status=?,stage=?,control_action=NULL,error=?,updated_at=? WHERE id=?")
        .run(status,status === "failed" ? "Failed" : status === "cancelled" ? "Cancelled" : "Paused",status === "failed" ? message : null,this.#iso(),id);
      return this.getJob(id)!;
    });
  }
  action(id: string, action: "pause"|"resume"|"cancel"|"publish"): CoverageJob {
    return this.#tx(() => {
      this.#recoverStaleLocked();
      const row = this.#db.prepare("SELECT status,mode FROM coverage_jobs WHERE id=?").get(id) as Row | undefined;
      if (!row) throw new CoverageJobStateError(404,"Coverage job was not found");
      const status = requiredString(row,"status");
      const timestamp = this.#iso();
      if (action === "pause") {
        if (status === "queued") this.#db.prepare("UPDATE coverage_jobs SET status='paused',stage='Paused',updated_at=? WHERE id=?").run(timestamp,id);
        else if (status === "running") this.#db.prepare("UPDATE coverage_jobs SET status='pausing',control_action='pause',stage='Pausing',updated_at=? WHERE id=?").run(timestamp,id);
        else if (status !== "paused" && status !== "pausing") throw new CoverageJobStateError(409,`Cannot pause a ${status} job`);
      } else if (action === "cancel") {
        if (["queued","paused","failed"].includes(status)) this.#db.prepare("UPDATE coverage_jobs SET status='cancelled',stage='Cancelled',control_action=NULL,updated_at=? WHERE id=?").run(timestamp,id);
        else if (["running","pausing"].includes(status)) this.#db.prepare("UPDATE coverage_jobs SET status='pausing',control_action='cancel',stage='Cancelling',updated_at=? WHERE id=?").run(timestamp,id);
        else if (status !== "cancelled") throw new CoverageJobStateError(409,`Cannot cancel a ${status} job`);
      } else if (action === "resume") {
        if (status !== "paused" && status !== "failed") throw new CoverageJobStateError(409,`Cannot resume a ${status} job`);
        this.#db.prepare("UPDATE coverage_jobs SET status='queued',mode='build',stage='Queued',control_action=NULL,error=NULL,updated_at=? WHERE id=?").run(timestamp,id);
      } else {
        if (status !== "paused") throw new CoverageJobStateError(409,`Cannot publish a ${status} job`);
        this.#db.prepare("UPDATE coverage_jobs SET status='queued',mode='publish',stage='Queued to publish prepared units',control_action=NULL,error=NULL,updated_at=? WHERE id=?").run(timestamp,id);
      }
      return this.getJob(id)!;
    });
  }
}

export class CoverageJobStateError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

// Queue inspection after lease release closes the enqueue/exit race between callers.
export function hasQueuedCoverageJobs(file: string): boolean {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const row = db.prepare("SELECT 1 AS pending FROM coverage_jobs WHERE status='queued' LIMIT 1").get();
    return Boolean(row);
  } finally { db.close(); }
}
