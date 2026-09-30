import { describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CoverageResourceGuard, processTreeRss, linuxUnlinkedDiskBytes, type CoverageResourceSample } from "./resources";

describe("coverage resource measurements", () => {
  it("counts only the current process tree", () => {
    expect(processTreeRss("10 1 100\n11 10 200\n12 11 300\n13 1 900\n", 10)).toBe(600 * 1024);
  });

  it("counts allocated unlinked files across descendants once and excludes unrelated or linked files", async () => {
    const proc = await mkdtemp(path.join(tmpdir(),"coverage-proc-"));
    try {
      const fds = new Map<string,{dev:number;ino:number;nlink:number;blocks:number;isFile:()=>boolean}>();
      for (const [pid,parent] of [[10,1],[11,10],[12,11],[13,1]]) {
        await mkdir(`${proc}/${pid}/fd`,{recursive:true});
        await writeFile(`${proc}/${pid}/status`,`PPid:\t${parent}\n`);
      }
      for (const [pid,fd,ino,nlink,blocks,regular] of [
        [10,1,100,0,8,1], [11,2,100,0,8,1], // Inherited descriptor: count once.
        [12,3,101,0,16,1], [11,4,102,1,32,1], [10,5,103,0,64,0],
        [13,6,104,0,128,1],
      ]) {
        const file=`${proc}/${pid}/fd/${fd}`;
        await writeFile(file,"");
        fds.set(file,{dev:1,ino:ino!,nlink:nlink!,blocks:blocks!,isFile:()=>Boolean(regular)});
      }
      await writeFile(`${proc}/10/fd/closed`,"");
      const inspect=vi.fn(async(file:string)=>{
        const item=fds.get(file);
        if (!item) throw Object.assign(new Error("descriptor closed"),{code:"ENOENT"});
        return item;
      });
      expect(await linuxUnlinkedDiskBytes(proc,10,inspect)).toBe((8+16)*512);
      expect(inspect).not.toHaveBeenCalledWith(`${proc}/13/fd/6`);
      expect(await linuxUnlinkedDiskBytes(proc,10,async()=>{throw Object.assign(new Error("denied"),{code:"EACCES"});})).toBeNull();
    } finally { await rm(proc,{recursive:true,force:true}); }
  });

  it("retains periodic disk peaks even when scratch disappears before the final stage", async () => {
    vi.useFakeTimers();
    let diskBytes=100;
    const probe=vi.fn(async(_paths:readonly string[],disk:boolean):Promise<CoverageResourceSample>=>({
      at:"2026-09-24T00:00:00Z",processTreeRssBytes:1,cgroupMemoryBytes:null,cgroupPeakBytes:null,
      measuredMemoryBytes:1,diskBytes:disk?diskBytes:null,
    }));
    const guard=new CoverageResourceGuard({sampleDiskPeriodically:true,probe});
    try {
      guard.start();
      await vi.advanceTimersByTimeAsync(1000);
      diskBytes=500;
      await vi.advanceTimersByTimeAsync(1000);
      diskBytes=100;
      await guard.stop();
      expect(guard.peakDiskBytes).toBe(500);
      expect(probe.mock.calls.every(([,disk])=>disk)).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it("reports a sampled peak and stops at the next bounded checkpoint", async () => {
    let bytes = 40;
    const probe = async (_paths: readonly string[], disk: boolean): Promise<CoverageResourceSample> => ({
      at: "2026-09-24T00:00:00Z", processTreeRssBytes: bytes, cgroupMemoryBytes: null, cgroupPeakBytes: null,
      measuredMemoryBytes: bytes, diskBytes: disk ? 100 : null,
    });
    const guard = new CoverageResourceGuard({ memoryLimitBytes: 50, diskPaths: ["/tmp/stage"], probe });
    guard.start();
    expect((await guard.checkpoint()).measuredMemoryBytes).toBe(40);
    bytes = 60;
    expect((await guard.sample("prepared")).diskBytes).toBe(100);
    await expect(guard.checkpoint()).rejects.toThrow("resource target exceeded");
    await guard.stop();
    expect(guard.peakMemoryBytes).toBe(60);
  });
});
