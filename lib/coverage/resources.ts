import { execFile } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import { promisify } from "node:util";

const exec = promisify(execFile);
const MIB = 1024 * 1024;
export const COVERAGE_MEMORY_TARGET_BYTES = 4 * 1024 ** 3;

export type CoverageResourceSample = {
  at: string;
  stage?: string;
  processTreeRssBytes: number | null;
  cgroupMemoryBytes: number | null;
  cgroupPeakBytes: number | null;
  measuredMemoryBytes: number;
  diskBytes: number | null;
};

/** ps RSS is in KiB; sum only this process and its descendants. */
export function processTreeRss(ps: string, rootPid: number): number {
  const children = new Map<number, number[]>();
  const rss = new Map<number, number>();
  for (const line of ps.split("\n")) {
    const parts = line.trim().split(/\s+/).map(Number);
    if (parts.length !== 3 || parts.some((part) => !Number.isSafeInteger(part) || part < 0)) continue;
    const [pid, ppid, kib] = parts as [number, number, number];
    rss.set(pid, kib * 1024);
    children.set(ppid, [...(children.get(ppid) ?? []), pid]);
  }
  const seen = new Set<number>();
  const visit = (pid: number): number => {
    if (seen.has(pid)) return 0;
    seen.add(pid);
    return (rss.get(pid) ?? 0) + (children.get(pid) ?? []).reduce((sum, child) => sum + visit(child), 0);
  };
  return visit(rootPid);
}

async function cgroupValue(name: "memory.current" | "memory.peak"): Promise<number | null> {
  try {
    const value = Number((await readFile(`/sys/fs/cgroup/${name}`, "utf8")).trim());
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  } catch { return null; }
}

async function treeRss(): Promise<number | null> {
  try {
    if (process.platform === "linux") {
      const rows: string[] = [];
      for (const pid of await readdir("/proc")) {
        if (!/^\d+$/.test(pid)) continue;
        try {
          const status = await readFile(`/proc/${pid}/status`, "utf8");
          const parent = /^PPid:\s+(\d+)/m.exec(status)?.[1];
          const rss = /^VmRSS:\s+(\d+)/m.exec(status)?.[1];
          if (parent && rss) rows.push(`${pid} ${parent} ${rss}`);
        } catch { /* Children can exit between enumeration and sampling. */ }
      }
      return processTreeRss(rows.join("\n"), process.pid);
    }
    const { stdout } = await exec("ps", ["-axo", "pid=,ppid=,rss="], { timeout: 3000, maxBuffer: MIB * 4 });
    return processTreeRss(stdout, process.pid);
  } catch { return null; }
}

async function diskUsage(paths: readonly string[]): Promise<number | null> {
  let total = 0;
  for (const directory of paths) {
    try { await stat(directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; return null; }
    try {
      const { stdout } = await exec("du", ["-sk", directory], { timeout: 30_000, maxBuffer: MIB });
      const kib = Number(stdout.trim().split(/\s+/)[0]);
      if (!Number.isFinite(kib)) return null;
      total += kib * 1024;
    } catch { return null; }
  }
  return total;
}

async function probe(paths: readonly string[], includeDisk: boolean): Promise<CoverageResourceSample> {
  const [processTreeRssBytes, cgroupMemoryBytes, cgroupPeakBytes, diskBytes] = await Promise.all([
    treeRss(), cgroupValue("memory.current"), cgroupValue("memory.peak"), includeDisk ? diskUsage(paths) : Promise.resolve(null),
  ]);
  return { at: new Date().toISOString(), processTreeRssBytes, cgroupMemoryBytes, cgroupPeakBytes,
    measuredMemoryBytes: processTreeRssBytes ?? process.memoryUsage.rss(), diskBytes };
}

/** Samples peak usage; checkpoint failures are cooperative, not an OS memory limit. */
export class CoverageResourceGuard {
  readonly #limit: number;
  readonly #paths: readonly string[];
  readonly #probe: (paths: readonly string[], disk: boolean) => Promise<CoverageResourceSample>;
  #timer: ReturnType<typeof setInterval> | undefined;
  #pending: Promise<CoverageResourceSample> | undefined;
  #last: CoverageResourceSample | undefined;
  #lastAt = 0;
  #peak = 0;
  #cgroupPeak = 0;

  constructor(options: { memoryLimitBytes?: number; diskPaths?: readonly string[];
    probe?: (paths: readonly string[], disk: boolean) => Promise<CoverageResourceSample> } = {}) {
    this.#limit = options.memoryLimitBytes ?? COVERAGE_MEMORY_TARGET_BYTES;
    this.#paths = options.diskPaths ?? [];
    this.#probe = options.probe ?? probe;
    if (!Number.isSafeInteger(this.#limit) || this.#limit <= 0) throw new Error("Invalid coverage memory target");
  }

  get peakMemoryBytes(): number { return this.#peak; }
  get cgroupPeakBytes(): number { return this.#cgroupPeak; }
  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => { void this.#memorySample().catch(() => undefined); }, 1000);
    this.#timer.unref();
  }
  async #memorySample(): Promise<CoverageResourceSample> {
    if (this.#pending) return this.#pending;
    this.#pending = this.#probe(this.#paths, false).then((sample) => {
      this.#last = sample;
      this.#lastAt = Date.now();
      this.#peak = Math.max(this.#peak, sample.measuredMemoryBytes);
      this.#cgroupPeak = Math.max(this.#cgroupPeak, sample.cgroupPeakBytes ?? sample.cgroupMemoryBytes ?? 0);
      return sample;
    }).finally(() => { this.#pending = undefined; });
    return this.#pending;
  }
  async sample(stage?: string): Promise<CoverageResourceSample> {
    const measured = stage ? await this.#probe(this.#paths, true) : await this.#memorySample();
    this.#last = measured;
    this.#lastAt = Date.now();
    this.#peak = Math.max(this.#peak, measured.measuredMemoryBytes);
    this.#cgroupPeak = Math.max(this.#cgroupPeak, measured.cgroupPeakBytes ?? measured.cgroupMemoryBytes ?? 0);
    return stage ? { ...measured, stage } : measured;
  }
  async checkpoint(): Promise<CoverageResourceSample> {
    const measured = this.#last && Date.now() - this.#lastAt < 1000 ? this.#last : await this.#memorySample();
    if (this.#peak > this.#limit) {
      throw new Error(`Coverage resource target exceeded: observed ${this.#peak} bytes, target ${this.#limit} bytes`);
    }
    return measured;
  }
  async stop(): Promise<CoverageResourceSample> {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    await this.#pending;
    return this.sample("final");
  }
}
