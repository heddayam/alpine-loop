import type {
  CoverageCatalog, CoverageJob, CoveragePlan, CoverageRequest, CoverageSnapshot, CoverageUnit,
} from "@/lib/contracts/coverage";

export type CoverageProgressUpdate = {
  stage?: string;
  units?: CoverageUnit[];
  completedUnits?: number;
  snapshot?: CoverageSnapshot | null;
};

export type CoverageRunnerContext = {
  signal: AbortSignal;
  publishOnly: boolean;
  report(update: CoverageProgressUpdate): Promise<void>;
  /** Serialize the atomic active-pointer switch with pause/cancel. No reporting inside activate. */
  commitPublication?(activate: () => Promise<void>): Promise<void>;
  checkpoint(): Promise<"continue" | "pause" | "cancel" | "publish">;
};

export type CoverageRunResult = {
  snapshot: CoverageSnapshot | null;
  completedUnits: number;
  units: CoverageUnit[];
  status: "completed" | "paused";
};

export type CoverageRuntime = {
  catalog(): Promise<CoverageCatalog>;
  plan(request: CoverageRequest): Promise<CoveragePlan>;
  run(plan: CoveragePlan, context: CoverageRunnerContext): Promise<CoverageRunResult>;
};

export type StoredCoverageJob = CoverageJob & { mode: "build" | "publish" };
