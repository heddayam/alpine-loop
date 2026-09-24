import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { once } from "node:events";
import { afterEach, expect, it } from "vitest";
import type { CoverageCatalog, CoveragePlan, CoverageSnapshot } from "@/lib/contracts/coverage";
import { bindCoverageWriter, CoverageJobService } from "./service";
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

it("tracks the larger installed union when an expansion must rebuild changed inputs", () => {
  const store = new SQLiteCoverageJobStore(dbPath());
  try {
    store.savePlan(plan); store.createJob(plan.id,"rebuild");
    store.acquireLease("writer",process.pid); store.claimNext("writer");
    const units = ["old-a","old-b","new"].map(id => ({ ...plan.units[0]!, id, status: "prepared" as const }));
    store.report("rebuild","writer",{ stage:"Rebuilding installed coverage",units,completedUnits:2 });
    expect(store.getJob("rebuild")).toMatchObject({totalUnits:3,completedUnits:2});
    store.finish("rebuild","writer",{snapshot,units,completedUnits:3,status:"completed"});
    expect(store.getJob("rebuild")).toMatchObject({status:"completed",totalUnits:3,completedUnits:3});
    store.releaseLease("writer");
  } finally { store.close(); }
});


it("restarts persisted queued work and records a synchronous startup failure", async () => {
  const file = dbPath();
  const setup = new SQLiteCoverageJobStore(file);
  setup.savePlan(plan); setup.createJob(plan.id,"queued"); setup.close();
  let starts = 0;
  const service = new CoverageJobService({ dbPath:file, runtime:{catalog:async()=>catalog,plan:async()=>plan}, startWorker:()=>{ starts++; throw new Error("spawn denied"); } });
  expect(starts).toBe(1);
  expect(service.get("queued")).toMatchObject({status:"failed",error:"spawn denied"});
  expect(service.action("queued","resume")).toMatchObject({status:"failed"});
  expect(starts).toBe(2);
  service.close();
});

it("rejects a second jobs database for either shared installation root", () => {
  const file = dbPath(), shared = join(file,"..","graph"), packs = join(file,"..","packs");
  bindCoverageWriter(file,[shared,packs]);
  expect(()=>bindCoverageWriter(file,[shared,packs])).not.toThrow();
  expect(()=>bindCoverageWriter(join(file,"..","other.sqlite"),[shared])).toThrow(/different jobs database/);
  expect(()=>bindCoverageWriter(join(file,"..","other.sqlite"),[packs])).toThrow(/different jobs database/);
});

it("prevents cancelled publication and preserves already committed publication", async () => {
  const store = new SQLiteCoverageJobStore(dbPath());
  try {
    store.savePlan(plan); store.createJob(plan.id,"job"); store.acquireLease("writer",process.pid); store.claimNext("writer");
    let activations = 0;
    await store.commitPublication("job","writer",async()=>{ activations++; });
    store.action("job","cancel");
    await expect(store.commitPublication("job","writer",async()=>{ activations++; })).rejects.toThrow(/stopped by user/);
    expect(activations).toBe(1);
    store.finishStopped("job","writer");
    expect(store.getJob("job")?.status).toBe("cancelled");
    store.releaseLease("writer");
  } finally { store.close(); }
});


it("serializes cancellation from another process after atomic activation", async () => {
  const file = dbPath(), store = new SQLiteCoverageJobStore(file);
  let canceller: Worker | undefined;
  try {
    store.savePlan(plan); store.createJob(plan.id,"job"); store.acquireLease("writer",process.pid); store.claimNext("writer");
    let cancelled = false;
    await store.commitPublication("job","writer", async () => {
      canceller = new Worker(`
        const {parentPort,workerData}=require('node:worker_threads');
        const {DatabaseSync}=require('node:sqlite');
        const db=new DatabaseSync(workerData); db.exec('PRAGMA busy_timeout=5000');
        parentPort.postMessage('ready');
        db.exec("BEGIN IMMEDIATE; UPDATE coverage_jobs SET status='pausing',control_action='cancel' WHERE id='job'; COMMIT");
        db.close(); parentPort.postMessage('cancelled');
      `, {eval:true,workerData:file});
      canceller.on("message",message=>{if(message==="cancelled")cancelled=true;});
      await once(canceller,"message");
      await new Promise(resolve=>setTimeout(resolve,20));
      expect(cancelled).toBe(false);
    });
    await once(canceller!,"exit");
    expect(cancelled).toBe(true);
    expect(store.checkpoint("job","writer")).toBe("cancel");
    store.finishStopped("job","writer"); store.releaseLease("writer");
  } finally {await canceller?.terminate();store.close();}
});
