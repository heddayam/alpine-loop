import path from "node:path";
import { pathToFileURL } from "node:url";
import { showBuildStatus, formatBuildStatus } from "./data-status";
import { listCoverageRegions, readCoverageRegion } from "@/lib/coverage/regions";
import { buildCoverageRegion } from "@/lib/coverage/runtime";
import { planCoverageRegion } from "@/lib/coverage/plan";
import type { CoverageRunnerContext, CoverageRunResult } from "@/lib/coverage/types";
import { writeJsonAtomically } from "@/lib/data/source-cache";
import { inspectPreparedRelease } from "@/lib/data/prepared-release";

const usage = "Usage: data regions | plan REGION [REGION...] | build REGION [REGION...] | inspect release.json | status [report.json] [--watch]";

async function withProgress(statusFile: string, action: (context: CoverageRunnerContext) => Promise<CoverageRunResult>) {
  const controller = new AbortController(), started = Date.now();
  const progress: Parameters<typeof formatBuildStatus>[0] = {status:"running",currentStage:"Starting",elapsedMs:0,completedUnits:0,currentStageStartedMs:0,stageTimings:[]};
  let saved = 0;
  const save = async () => { saved = Date.now(); progress.elapsedMs = saved - started; await writeJsonAtomically(statusFile, progress); };
  const stop = () => controller.abort();
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  try {
    await save();
    const result = await action({
      signal: controller.signal,
      checkpoint: async () => { if (Date.now() - saved >= 5000) await save(); return "continue"; },
      report: async update => {
        if (update.stage && update.stage !== progress.currentStage) {
          const at = Date.now() - started;
          progress.stageTimings!.push({stage:progress.currentStage,elapsedMs:progress.currentStageStartedMs!,durationMs:at-progress.currentStageStartedMs!});
          progress.currentStageStartedMs = at; progress.currentStage = update.stage;
        }
        progress.completedUnits = update.completedUnits ?? progress.completedUnits;
        if (update.units) progress.totalUnits = update.units.filter(unit => unit.status !== "unavailable").length;
        if (update.counts) progress.counts = {...progress.counts, ...update.counts};
        for (const key of ["peakMeasuredMemoryBytes", "peakCgroupMemoryBytes", "peakDiskBytes"] as const) {
          const value = update[key];
          if (typeof value === "number") progress[key] = Math.max(progress[key] ?? 0, value);
        }
        process.stderr.write(`${progress.currentStage}\n`);
        await save();
      },
    });
    progress.status = result.status;
    progress.completedUnits = result.completedUnits;
    return {result, progress};
  } catch (error) {
    progress.status = controller.signal.aborted ? "paused" : "failed";
    progress.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop);
    const at = Date.now() - started;
    progress.stageTimings!.push({stage:progress.currentStage,elapsedMs:progress.currentStageStartedMs!,durationMs:at-progress.currentStageStartedMs!});
    await save();
  }
}

export async function runDataCommand(argv: readonly string[]): Promise<void> {
  const [command, ...args] = argv;
  process.env.ALPINE_COVERAGE_ROOT ??= ".cache/build";
  const statusFile = path.join(process.env.ALPINE_COVERAGE_ROOT, "status.json");
  if (command === "status") {
    const files = args.filter(arg => !arg.startsWith("--"));
    if (files.length > 1 || args.filter(arg => arg === "--watch").length > 1 || args.some(arg => arg.startsWith("--") && arg !== "--watch")) throw new Error(usage);
    await showBuildStatus(files[0] ?? statusFile, args.includes("--watch"));
    return;
  }
  if (command === "regions" && !args.length) {
    for (const region of await listCoverageRegions()) process.stdout.write(`${region.id}\t${region.name}\n`);
    return;
  }
  const [file, ...options] = args;
  if (!file || file.startsWith("--")) throw new Error(usage);
  if (command === "plan" || command === "build") {
    if (args.some(id => !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id))) throw new Error(usage);
    if (new Set(args).size !== args.length) throw new Error("Choose each region only once.");
    // Reject every invalid selection before preparation or status writes begin.
    const selections = [];
    for (const id of args) {
      const region = await readCoverageRegion(id);
      selections.push({region, plan:planCoverageRegion(region)});
    }
    for (const {region, plan} of selections) {
      if (command === "plan") {
        process.stdout.write(`${JSON.stringify({ ...plan, downloadBytes: null,
          note: "Download size and first-build duration are unknown until preparation. No source data was processed.", limitations: region.recipe.limitations }, null, 2)}\n`);
      } else {
        // One active build at a time; stream results rather than retaining packs.
        const {result, progress} = await withProgress(statusFile, context => buildCoverageRegion(region, context));
        const releasePath = path.resolve(process.env.ALPINE_RELEASE_ROOT ?? ".local-data/releases/prepared", "release.json");
        process.stderr.write(`${result.status === "completed" ? "Completed" : "Paused"} ${region.name} in ${Math.floor(progress.elapsedMs / 60000)}m ${Math.floor(progress.elapsedMs / 1000) % 60}s.\n`);
        process.stdout.write(`${JSON.stringify({...result, region:{id:region.id,name:region.name}, summary:progress,
          ...(result.status === "completed" && result.snapshot ? {releasePath, next:"Open Coverage in the app and download this region."} : {})}, null, 2)}\n`);
        if (result.status !== "completed") break;
      }
    }
  } else if (command === "inspect" && !options.length) {
    process.stdout.write(`${JSON.stringify(await inspectPreparedRelease(file), null, 2)}\n`);
  } else throw new Error(usage);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await runDataCommand(process.argv.slice(2)).catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
