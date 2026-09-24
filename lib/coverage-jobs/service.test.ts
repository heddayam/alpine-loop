import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { CoverageCatalog, CoveragePlan, CoverageSnapshot } from "@/lib/contracts/coverage";
import { CoverageJobService } from "./service";
import { SQLiteCoverageJobStore } from "./store";

const area: CoveragePlan["geometry"] = { type: "Polygon", coordinates: [[[0,0],[1,0],[1,1],[0,1],[0,0]]] };
const request = { collectionIds: ["test"], memoryLimitMiB: 1024, offline: true };
const plan: CoveragePlan = {
  id: "plan-1", request, geometry: area, sourceIds: ["fixture"],
  units: [{ id: "unit-1", geometry: area, status: "pending" }],
  estimates: { downloadBytes: 0, temporaryBytes: 100, reusableBytes: 0 }, warnings: [],
};
const snapshot: CoverageSnapshot = {
  schemaVersion: 1, id: "snapshot-1", dataVersion: "test-v1", geometry: area,
  unitIds: ["unit-1"], createdAt: "2026-09-24T00:00:00.000Z", sourceFingerprint: "fixture",
  auditStatus: "passed", limitations: [],
};
const catalog: CoverageCatalog = { collections: [], installed: null, jobs: [], prerequisites: [] };
const dirs: string[] = [];
function dbPath(): string { const dir = mkdtempSync(join(tmpdir(), "coverage-jobs-")); dirs.push(dir); return join(dir,"jobs.sqlite"); }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir,{recursive:true,force:true}); });

it("persists a plan and job across service restart while keeping one build writer", async () => {
  const file = dbPath();
  const runtime = { catalog: async () => catalog, plan: async () => plan };
  const started: string[] = [];
  const first = new CoverageJobService({ dbPath: file, runtime, startWorker: (path) => { started.push(path); } });
  await first.plan(request);
  const job = first.build("plan-1");
  expect(started).toEqual([file]);
  first.close();
  const second = new CoverageJobService({ dbPath: file, runtime, startWorker: () => {} });
  expect(second.get(job.id)?.status).toBe("queued");
  expect((await second.catalog()).jobs.map(({ id }) => id)).toEqual([job.id]);
  const workerA = new SQLiteCoverageJobStore(file);
  const workerB = new SQLiteCoverageJobStore(file);
  expect(workerA.acquireLease("A",process.pid)).toBe(true);
  expect(workerB.acquireLease("B",process.pid)).toBe(false);
  expect(workerA.claimNext("A")?.id).toBe(job.id);
  expect(second.get(job.id)?.status).toBe("running");
  workerA.releaseLease("A"); workerA.close(); workerB.close(); second.close();
});

it("does not pause an active worker, but pauses an interrupted job after a stale lease", async () => {
  const file = dbPath(); let clock = 1_000;
  const store = new SQLiteCoverageJobStore(file, () => clock);
  store.savePlan(plan);
  const job = store.createJob(plan.id,"job-1");
  expect(store.acquireLease("live",process.pid)).toBe(true);
  expect(store.claimNext("live")?.id).toBe(job.id);
  clock += 20_000;
  expect(store.recoverStaleLease()).toBe(false);
  expect(store.getJob(job.id)?.status).toBe("running");
  store.releaseLease("live");
  store.action(job.id,"resume");
  expect(store.acquireLease("dead",99999999)).toBe(true);
  expect(store.claimNext("dead")?.id).toBe(job.id);
  clock += 20_000;
  expect(store.recoverStaleLease()).toBe(true);
  expect(store.getJob(job.id)?.status).toBe("paused");
  store.close();
});

it("preserves completed units and a validated snapshot across pause, resume, failure, and cancel", () => {
  const file = dbPath();
  const store = new SQLiteCoverageJobStore(file);
  store.savePlan(plan);
  store.createJob(plan.id,"job-1");
  expect(store.acquireLease("writer",process.pid)).toBe(true);
  store.claimNext("writer");
  const prepared = [{ ...plan.units[0]!, status: "prepared" as const }];
  store.report("job-1","writer",{ stage: "Prepared", completedUnits: 1, units: prepared, snapshot });
  store.action("job-1","pause");
  expect(store.checkpoint("job-1","writer")).toBe("pause");
  store.finishStopped("job-1","writer");
  expect(store.getJob("job-1")?.snapshot).toEqual(snapshot);
  store.action("job-1","resume");
  store.claimNext("writer");
  store.fail("job-1","writer",new Error("offline source unavailable"));
  expect(store.getJob("job-1")).toMatchObject({ status: "failed", completedUnits: 1, error: "offline source unavailable", snapshot });
  store.action("job-1","cancel");
  expect(store.getJob("job-1")).toMatchObject({ status: "cancelled", completedUnits: 1, snapshot });
  store.releaseLease("writer"); store.close();
});

it("queues publish for paused work and rejects simultaneous publish", () => {
  const file = dbPath();
  const store = new SQLiteCoverageJobStore(file);
  store.savePlan(plan); store.createJob(plan.id,"job-1");
  store.action("job-1","pause");
  expect(store.action("job-1","publish").status).toBe("queued");
  expect(() => store.action("job-1","publish")).toThrow(/Cannot publish/);
  expect(store.acquireLease("writer",process.pid)).toBe(true);
  expect(store.claimNext("writer")?.mode).toBe("publish");
  expect(store.checkpoint("job-1","writer")).toBe("publish");
  store.finish("job-1","writer",{ snapshot, completedUnits: 1, units: [{ ...plan.units[0]!, status: "installed" }], status: "completed" });
  expect(store.getJob("job-1")?.status).toBe("paused");
  store.releaseLease("writer"); store.close();
});
