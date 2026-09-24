import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { CoveragePlan } from "@/lib/contracts/coverage";
import { startCoverageWorker } from "./service";
import { SQLiteCoverageJobStore } from "./store";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
const directories: string[] = [];
afterEach(() => { vi.clearAllMocks(); for (const dir of directories.splice(0)) rmSync(dir,{recursive:true,force:true}); });
function setup() {
  const dir = mkdtempSync(join(tmpdir(),"coverage-spawn-")); directories.push(dir);
  const file = join(dir,"jobs.sqlite"), store = new SQLiteCoverageJobStore(file);
  const geometry: CoveragePlan["geometry"] = {type:"Polygon",coordinates:[[[0,0],[1,0],[1,1],[0,1],[0,0]]]};
  store.savePlan({id:"plan",geometry,request:{collectionIds:["test"],memoryLimitMiB:1024,offline:true},units:[],sourceIds:[],estimates:{downloadBytes:0,temporaryBytes:0,reusableBytes:0},warnings:[]});
  store.createJob("plan","job");
  const child = Object.assign(new EventEmitter(), {unref:vi.fn(),disconnect:vi.fn()});
  vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
  return {file,store,child};
}
it.each(["error","exit"])("persists child %s before the queue is claimed", (event) => {
  const {file,store,child} = setup();
  try {
    startCoverageWorker(file);
    if (event === "error") child.emit("error",new Error("spawn denied"));
    else child.emit("exit",1,null);
    expect(store.getJob("job")).toMatchObject({status:"failed",stage:"Worker failed to start"});
  } finally {store.close();}
});
it("does not fail queued work when a competing worker exits normally or holds the lease", () => {
  const {file,store,child} = setup();
  try {
    startCoverageWorker(file); child.emit("exit",0,null);
    expect(store.getJob("job")?.status).toBe("queued");
    store.acquireLease("owner",process.pid);
    startCoverageWorker(file); child.emit("exit",1,null);
    expect(store.getJob("job")?.status).toBe("queued");
    store.releaseLease("owner");
  } finally {store.close();}
});

it("keeps the launcher alive until the worker confirms successful imports", () => {
  const {file,store,child} = setup();
  try {
    startCoverageWorker(file);
    expect(child.unref).not.toHaveBeenCalled();
    child.emit("message","coverage-worker-ready");
    expect(child.disconnect).toHaveBeenCalledOnce();
    expect(child.unref).toHaveBeenCalledOnce();
  } finally {store.close();}
});
