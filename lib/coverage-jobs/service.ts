import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import {
  coverageActionSchema, coverageRequestSchema, type CoverageAction,
  type CoverageCatalog, type CoverageJob, type CoveragePlan, type CoverageRequest,
} from "@/lib/contracts/coverage";
import { CoverageJobStateError, SQLiteCoverageJobStore } from "./store";
import type { CoverageRuntime } from "./types";

/** Bind shared graph and installation roots to one queue, even with custom paths. */
export function bindCoverageWriter(dbPath: string, roots: string[]): void {
  mkdirSync(dirname(dbPath), { recursive: true });
  const canonicalDatabase = existsSync(dbPath) ? realpathSync(dbPath) : join(realpathSync(dirname(dbPath)), basename(dbPath));
  for (const root of roots) {
    mkdirSync(root, { recursive: true });
    const marker = join(realpathSync(root), ".coverage-writer-database");
    try { writeFileSync(marker, canonicalDatabase, { flag: "wx" }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    if (readFileSync(marker, "utf8") !== canonicalDatabase) {
      throw new Error(`Coverage root ${root} is bound to a different jobs database; use its existing ALPINE_COVERAGE_JOBS_DB`);
    }
  }
}

export function coverageJobDatabasePath(): string {
  const dbPath = resolve(/* turbopackIgnore: true */ process.env.ALPINE_COVERAGE_JOBS_DB ?? ".local-data/runtime/coverage-jobs.sqlite");
  bindCoverageWriter(dbPath, [
    resolve(/* turbopackIgnore: true */ process.env.ALPINE_COVERAGE_ROOT ?? ".local-data/coverage"),
    resolve(/* turbopackIgnore: true */ process.env.ALPINE_PACK_ROOT ?? ".local-data/packs"),
  ]);
  return dbPath;
}

/** The build runs in a detached local process, independent of an HTTP request. */
export function startCoverageWorker(dbPath: string): void {
  const store = new SQLiteCoverageJobStore(dbPath);
  const queued = store.listJobs().filter(({ status }) => status === "queued").map(({ id }) => id);
  store.close();
  if (!queued.length) return;
  const failed = (error: unknown) => {
    const jobs = new SQLiteCoverageJobStore(dbPath);
    try { jobs.failUnstarted(queued, error); }
    finally { jobs.close(); }
  };
  try {
    const child = spawn(process.execPath, ["--import", "tsx", resolve(process.cwd(), "lib/coverage-jobs/worker.ts"), dbPath], {
      cwd: process.cwd(), detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"], env: process.env,
    });
    child.once("error", failed);
    child.once("exit", (code, signal) => {
      if (code !== 0) failed(new Error(`Coverage worker exited before starting queued work (${signal ?? code}); check the local Node.js and tsx installation`));
    });
    // Keep short-lived CLI callers alive until imports succeeded or startup failed.
    child.once("message", (message) => {
      if (message === "coverage-worker-ready") {
        child.disconnect();
        child.unref();
      }
    });
  } catch (error) { failed(error); }
}

export class CoverageJobService {
  readonly #store: SQLiteCoverageJobStore;
  readonly #runtime: Pick<CoverageRuntime, "catalog" | "plan">;
  readonly #startWorker: (dbPath: string) => void;
  readonly #dbPath: string;

  constructor(options: {
    dbPath: string;
    runtime: Pick<CoverageRuntime, "catalog" | "plan">;
    startWorker?: (dbPath: string) => void;
    now?: () => number;
  }) {
    this.#dbPath = options.dbPath;
    this.#runtime = options.runtime;
    this.#startWorker = options.startWorker ?? startCoverageWorker;
    this.#store = new SQLiteCoverageJobStore(options.dbPath, options.now);
    this.#store.recoverStaleLease();
    if (this.#store.listJobs().some(({ status }) => status === "queued")) this.#wakeWorker();
  }
  close(): void { this.#store.close(); }
  #wakeWorker(): void {
    try { this.#startWorker(this.#dbPath); }
    catch (error) {
      this.#store.failUnstarted(this.#store.listJobs().filter(({ status }) => status === "queued").map(({ id }) => id), error);
    }
  }

  async catalog(): Promise<CoverageCatalog> {
    this.#store.recoverStaleLease();
    const catalog = await this.#runtime.catalog();
    return { ...catalog, jobs: this.#store.listJobs() };
  }
  async plan(request: CoverageRequest): Promise<CoveragePlan> {
    const parsed = coverageRequestSchema.parse(request);
    return this.#store.savePlan(await this.#runtime.plan(parsed));
  }
  build(planId: string): CoverageJob {
    if (!this.#store.getPlan(planId)) throw new CoverageJobStateError(404, "Coverage plan was not found");
    const job = this.#store.createJob(planId, randomUUID());
    this.#wakeWorker();
    return this.#store.getJob(job.id)!;
  }
  list(): CoverageJob[] {
    this.#store.recoverStaleLease();
    return this.#store.listJobs();
  }
  get(id: string): CoverageJob | null {
    this.#store.recoverStaleLease();
    return this.#store.getJob(id);
  }
  action(id: string, action: CoverageAction): CoverageJob {
    const parsed = coverageActionSchema.parse(action);
    const job = this.#store.action(id, parsed);
    if (parsed === "resume" || parsed === "publish") this.#wakeWorker();
    return this.#store.getJob(job.id)!;
  }
}
