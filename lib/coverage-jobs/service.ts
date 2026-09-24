import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
  coverageActionSchema, coverageRequestSchema, type CoverageAction,
  type CoverageCatalog, type CoverageJob, type CoveragePlan, type CoverageRequest,
} from "@/lib/contracts/coverage";
import { CoverageJobStateError, SQLiteCoverageJobStore } from "./store";
import type { CoverageRuntime } from "./types";

export function coverageJobDatabasePath(): string {
  return resolve(process.env.ALPINE_COVERAGE_JOBS_DB ?? ".local-data/runtime/coverage-jobs.sqlite");
}

/** The build runs in a detached local process, independent of an HTTP request. */
export function startCoverageWorker(dbPath: string): void {
  const child = spawn(process.execPath, ["--import", "tsx", resolve(process.cwd(), "lib/coverage-jobs/worker.ts"), dbPath], {
    cwd: process.cwd(), detached: true, stdio: "ignore", env: process.env,
  });
  child.unref();
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
  }
  close(): void { this.#store.close(); }

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
    this.#startWorker(this.#dbPath);
    return job;
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
    if (parsed === "resume" || parsed === "publish") this.#startWorker(this.#dbPath);
    return job;
  }
}
