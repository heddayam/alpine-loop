import { constants } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { coverageRequestSchema } from "../../lib/coverage/types";
import { CoverageResourceGuard, type CoverageResourceSample } from "../../lib/coverage/resources";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

const requestPath = option("--request");
if (!requestPath) throw new Error("Usage: node --import tsx scripts/research/coverage-feasibility.ts --request request.json [--work-root directory] [--output result.json] [--source-cache directory] [--stop-after-units N]");
const workRoot = option("--work-root")
  ? path.resolve(option("--work-root")!) : await mkdtemp(path.join(os.tmpdir(), "alpine-coverage-feasibility-"));
await mkdir(workRoot, { recursive: true });
const coverageRoot = path.join(workRoot, "coverage");
const releaseRoot = path.join(workRoot, "release");
const outputPath = path.resolve(option("--output") ?? path.join(workRoot, "result.json"));
const stopAfter = option("--stop-after-units") === undefined ? null : Number(option("--stop-after-units"));
if (stopAfter !== null && (!Number.isSafeInteger(stopAfter) || stopAfter < 1)) throw new Error("--stop-after-units must be a positive integer");
process.env.ALPINE_COVERAGE_ROOT = coverageRoot;
process.env.ALPINE_RELEASE_ROOT = releaseRoot;
const sourceRoot = path.join(workRoot, "sources");
async function seedSourceCache(source: string, target: string): Promise<void> {
  const original = await realpath(source);
  await mkdir(target, { recursive: true });
  const destination = await realpath(target);
  if (original === destination) return;
  const relative = path.relative(original, destination);
  if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) throw new Error("Source cache cannot contain its writable view");
  const walk = async (from: string, to: string): Promise<void> => {
    await mkdir(to, { recursive: true });
    if (!(await lstat(to)).isDirectory()) throw new Error(`Writable source cache directory is not a directory: ${to}`);
    for (const entry of await readdir(from, { withFileTypes: true })) {
      const input = path.join(from, entry.name), output = path.join(to, entry.name);
      if (entry.isDirectory()) await walk(input, output);
      else if (entry.isFile()) {
        try {
          if (/\.(?:pbf|tiff?|zip)$/i.test(entry.name)) await symlink(input, output);
          else await copyFile(input, output, constants.COPYFILE_EXCL);
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      }
    }
  };
  await walk(original, target);
}
if (option("--source-cache")) await seedSourceCache(option("--source-cache")!, sourceRoot);
process.env.ALPINE_SOURCE_CACHE = sourceRoot;
process.env.ALPINE_ROUTE_JOBS_DB = path.join(workRoot, "route-jobs.sqlite");
const guard = new CoverageResourceGuard({ diskPaths: [coverageRoot, releaseRoot, sourceRoot], sampleDiskPeriodically: true });
const samples: CoverageResourceSample[] = [];
const started = Date.now();
const stageTimings: { stage: string; elapsedMs: number; durationMs: number }[] = [];
let currentStage = "starting";
let stageStarted = started;
let planId: string | undefined;
let status = "running";
let error: string | undefined;
let completedUnits = 0;
let newlyCompletedUnits = 0;
class PlannedPause extends Error {}
function enterStage(stage: string): void {
  const now = Date.now();
  stageTimings.push({ stage: currentStage, elapsedMs: stageStarted - started, durationMs: now - stageStarted });
  currentStage = stage;
  stageStarted = now;
}
async function writeProgress(): Promise<void> {
  const report = { schemaVersion: 1, status, error, planId, workRoot, currentStage,
    elapsedMs: Date.now() - started, completedUnits, newlyCompletedUnits,
    peakMeasuredMemoryBytes: guard.peakMemoryBytes,
    peakDiskBytes: guard.peakDiskBytes,
    cgroupPeakBytes: guard.cgroupPeakBytes,
    cgroupAvailable: samples.some((sample) => sample.cgroupMemoryBytes !== null),
    stageTimings, samples, releaseRoot };
  await mkdir(path.dirname(outputPath), { recursive: true });
  const temporary = `${outputPath}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`);
  await rename(temporary, outputPath);
}
const signal = new AbortController();
process.once("SIGINT", () => signal.abort(new Error("Interrupted")));
process.once("SIGTERM", () => signal.abort(new Error("Terminated")));
guard.start();
try {
  const { plan, run } = await import("../../lib/coverage/runtime");
  const request = coverageRequestSchema.parse(JSON.parse(await readFile(requestPath, "utf8")));
  samples.push(await guard.sample("planning"));
  enterStage("planning");
  await writeProgress();
  const prepared = await plan(request);
  planId = prepared.id;
  const initiallyInstalled = new Set(prepared.units.filter((unit) => unit.status === "installed").map((unit) => unit.id));
  samples.push(await guard.sample("planned"));
  enterStage("planned");
  await writeProgress();
  const result = await run(prepared, {
    signal: signal.signal,
    checkpoint: async () => { signal.signal.throwIfAborted(); await guard.checkpoint(); return "continue"; },
    report: async ({ stage, units, completedUnits: completed }) => {
      completedUnits = completed ?? completedUnits;
      if (units) newlyCompletedUnits = units.filter((unit) =>
        !initiallyInstalled.has(unit.id) && (unit.status === "prepared" || unit.status === "installed")).length;
      if (stage) { samples.push(await guard.sample(stage)); enterStage(stage); }
      await writeProgress();
      if (stopAfter !== null && newlyCompletedUnits >= stopAfter) throw new PlannedPause(`Stopped after ${stopAfter} prepared units`);
    },
  });
  status = result.status;
  completedUnits = result.completedUnits;

} catch (cause) {
  if (cause instanceof PlannedPause || signal.signal.aborted) status = "paused";
  else { status = "failed"; error = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause); }
} finally {
  try { samples.push(await guard.stop()); }
  catch (cause) { error ??= cause instanceof Error ? cause.message : String(cause); }
  enterStage(status);
  await writeProgress();
  process.stdout.write(`${outputPath}\n`);
}
if (error) process.exitCode = 1;
