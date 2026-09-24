import { constants } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { coverageRequestSchema } from "../../lib/contracts/coverage";
import { searchRequestSchema } from "../../lib/contracts/search";
import { CoverageResourceGuard, type CoverageResourceSample } from "../../lib/coverage/resources";
import { SQLiteRouteJobStore } from "../../lib/route-jobs/store";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

const requestPath = option("--request");
if (!requestPath) throw new Error("Usage: node --import tsx scripts/research/coverage-feasibility.ts --request request.json [--work-root directory] [--output result.json] [--source-cache directory] [--stop-after-units N] [--skip-search]");
const workRoot = option("--work-root")
  ? path.resolve(option("--work-root")!) : await mkdtemp(path.join(os.tmpdir(), "alpine-coverage-feasibility-"));
await mkdir(workRoot, { recursive: true });
const coverageRoot = path.join(workRoot, "coverage");
const packRoot = path.join(workRoot, "packs");
const outputPath = path.resolve(option("--output") ?? path.join(workRoot, "result.json"));
const stopAfter = option("--stop-after-units") === undefined ? null : Number(option("--stop-after-units"));
if (stopAfter !== null && (!Number.isSafeInteger(stopAfter) || stopAfter < 1)) throw new Error("--stop-after-units must be a positive integer");
process.env.ALPINE_COVERAGE_ROOT = coverageRoot;
process.env.ALPINE_PACK_ROOT = packRoot;
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
new SQLiteRouteJobStore(process.env.ALPINE_ROUTE_JOBS_DB).close();
const guard = new CoverageResourceGuard({ diskPaths: [coverageRoot, packRoot, sourceRoot], sampleDiskPeriodically: true });
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
let search: Record<string, unknown> | undefined;
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
    stageTimings, samples, search };
  await mkdir(path.dirname(outputPath), { recursive: true });
  const temporary = `${outputPath}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`);
  await rename(temporary, outputPath);
}
const signal = new AbortController();
process.once("SIGINT", () => signal.abort(new Error("Interrupted")));
process.once("SIGTERM", () => signal.abort(new Error("Terminated")));
async function measureSearch(): Promise<void> {
  const searchStarted = Date.now();
  const { loadInstalledPack } = await import("../../lib/packs/installed-pack");
  const { SQLiteGraphRepository } = await import("../../lib/graph/sqlite-repository");
  const { accessPointIsEligible } = await import("../../lib/graph/policy");
  const { accessPointIsWildEnough, MAXIMUM_NEARBY_BUILDINGS } = await import("../../lib/data/wilderness");
  const { accessPointCanStartClosedRoute } = await import("../../lib/solver/eligible-access-points");
  const { generateSearch } = await import("../../lib/server/search");
  const installed = await loadInstalledPack("local-coverage", packRoot);
  if (!installed) {
    search = { status: "unavailable", reason: "no-installed-local-coverage", elapsedMs: Date.now() - searchStarted };
    return;
  }
  const db = new DatabaseSync(installed.databasePath, { readOnly: true });
  let anchor: { id: string; lon: number; lat: number } | undefined;
  try {
    anchor = db.prepare(`SELECT a.id, n.lon, n.lat FROM access_points a
      JOIN nodes n ON n.id = a.node_id
      JOIN access_topology t ON t.access_point_id = a.id AND t.profile = 'inclusive'
      WHERE a.access_state IN ('public','unknown') AND a.nearby_building_count < ? AND t.can_reach_cycle = 1
      ORDER BY a.id LIMIT 1`).get(MAXIMUM_NEARBY_BUILDINGS) as typeof anchor;
  } finally { db.close(); }
  if (!anchor) {
    search = { status: "unavailable", reason: "no-eligible-start", elapsedMs: Date.now() - searchStarted };
    return;
  }
  const radius = 0.0002;
  const bbox = [Math.max(-180, anchor.lon - radius), Math.max(-90, anchor.lat - radius),
    Math.min(180, anchor.lon + radius), Math.min(90, anchor.lat + radius)] as const;
  const repository = new SQLiteGraphRepository(installed.databasePath, installed.manifest.id);
  let selectedAccessPointCount: number;
  try {
    const candidates = await repository.getAccessPointCandidates({ bbox, includeUncertainAccess: true, signal: signal.signal });
    selectedAccessPointCount = candidates.filter((candidate) =>
      accessPointIsEligible(candidate, true) && accessPointIsWildEnough(candidate) && accessPointCanStartClosedRoute(candidate)).length;
  } finally { await repository.close(); }
  if (!selectedAccessPointCount) {
    search = { status: "unavailable", reason: "no-eligible-start-in-bbox", selectedStartId: anchor.id, bbox, elapsedMs: Date.now() - searchStarted };
    return;
  }
  const request = searchRequestSchema.parse({
    area: { mode: "drawn-area", bbox },
    criteria: { closedRoute: { maximumRepeatedTrailPct: 35, allowMultiCycle: true },
      distanceMiles: { min: 0.1, max: 20 }, includeUncertainAccess: true },
    limit: 10,
  });
  const result = await generateSearch(request, signal.signal);
  const route = (item: (typeof result.exact)[number]) => ({ id: item.id, startAccessPointId: item.startAccessPoint.id,
    distanceMeters: item.distanceMeters, topology: item.topology.kind });
  search = { status: "completed", elapsedMs: Date.now() - searchStarted, selectedStartId: anchor.id,
    selectedAccessPointCount, bbox, exactCount: result.exact.length, nearMissCount: result.nearMisses.length,
    exactRoutes: result.exact.map(route), nearMissRoutes: result.nearMisses.map(route),
    diagnostics: { incomplete: result.incomplete,
      computationLimitReported: result.messages.some((message) => message.startsWith("The computation limit stopped")),
      messages: result.messages } };
}
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
    publishOnly: false,
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
  if (status === "completed" && !process.argv.includes("--skip-search")) {
    enterStage("search");
    await writeProgress();
    try { await measureSearch(); }
    catch (cause) {
      search = { status: signal.signal.aborted ? "interrupted" : "failed",
        reason: cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause) };
    }
    samples.push(await guard.sample("search"));
    await writeProgress();
  }
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
