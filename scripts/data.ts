import path from "node:path";
import { pathToFileURL } from "node:url";
import { showBuildStatus, formatBuildStatus } from "./data-status";
import { readSourceRecipe } from "@/lib/coverage/recipe";
import { buildLocalCoverage } from "@/lib/coverage/runtime";
import { planLocalCoverage } from "@/lib/coverage/plan";
import { rectangle } from "@/lib/coverage/geometry";
import type { CoverageRunnerContext } from "@/lib/coverage/types";
import { writeJsonAtomically } from "@/lib/data/source-cache";
import { inspectPreparedRelease } from "@/lib/data/prepared-release";

const usage = "Usage: data plan|build source-recipe.json --bbox west,south,east,north | inspect release.json | status [report.json] [--watch]";

async function withProgress<T>(statusFile: string, action: (context: CoverageRunnerContext) => Promise<T>): Promise<T> {
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
        process.stderr.write(`${progress.currentStage}\n`);
        await save();
      },
    });
    progress.status = "completed";
    return result;
  } catch (error) {
    progress.status = controller.signal.aborted ? "paused" : "failed";
    progress.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop);
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
  const [file, ...options] = args;
  if (!file || file.startsWith("--")) throw new Error(usage);
  if (command === "plan" || command === "build") {
    if (options.length !== 2 || options[0] !== "--bbox") throw new Error(usage);
    const coordinates = options[1]!.split(",");
    const bbox = coordinates.map(Number);
    if (coordinates.length !== 4 || coordinates.some(value => !value.trim()) || bbox.some(value => !Number.isFinite(value)) ||
      bbox[0]! >= bbox[2]! || bbox[1]! >= bbox[3]! || bbox[0]! < -180 || bbox[2]! > 180 || bbox[1]! < -90 || bbox[3]! > 90) {
      throw new Error("Bbox must be west,south,east,north with increasing longitude/latitude inside geographic bounds");
    }
    const recipe = await readSourceRecipe(file), startGeometry = rectangle(bbox);
    const plan = planLocalCoverage(recipe, startGeometry);
    const result = command === "plan"
      ? { ...plan, downloadBytes: null, note: "Start area plus surrounding trails; download size is known after preparation. No source data was processed." }
      : await withProgress(statusFile, context => buildLocalCoverage(recipe, startGeometry, context));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
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
