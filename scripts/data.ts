import path from "node:path";
import { pathToFileURL } from "node:url";
import { showBuildStatus, formatBuildStatus } from "./data-status";
import { writeNetworkPreview } from "./network-preview";
import { readSourceRecipe } from "@/lib/coverage/recipe";
import { readNetworkCatalog, type NetworkCatalog } from "@/lib/coverage/discovery-catalog";
import { discoverNetworks, buildNetworks } from "@/lib/coverage/runtime";
import type { CoverageRunnerContext } from "@/lib/coverage/types";
import { writeJsonAtomically } from "@/lib/data/source-cache";
import { inspectPreparedRelease } from "@/lib/data/prepared-release";

const usage = "Usage: data discover source-recipe.json | networks catalog.json | build catalog.json --network ID [--network ID ...] | inspect release.json | status [report.json] [--watch]";

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

async function describeNetworks(catalog: NetworkCatalog, catalogPath: string): Promise<void> {
  const previewPath = await writeNetworkPreview(catalog, catalogPath);
  process.stdout.write(`${catalog.networks.length} connected networks; ${catalog.networks.filter(network => network.cycleRank > 0).length} contain undirected cycles.\n`);
  process.stdout.write(`Catalog: ${path.relative(process.cwd(), catalogPath)}\nOpen: ${path.relative(process.cwd(), previewPath)}\n`);
  process.stdout.write("Choose a network in the preview, then build its ID. Download size is unknown until preparation.\n");
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
  if (command === "build") {
    const ids: string[] = [];
    for (let i = 0; i < options.length; i += 2) {
      if (options[i] !== "--network" || !/^network-[a-f0-9]{32}$/.test(options[i + 1] ?? "")) throw new Error(usage);
      ids.push(options[i + 1]!);
    }
    if (!ids.length) throw new Error("Build requires explicit --network IDs from a discovery catalog. Run data discover source-recipe.json first.");
    if (new Set(ids).size !== ids.length) throw new Error("Select each network ID only once");
    const result = await withProgress(statusFile, context => buildNetworks(file, ids, context));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    if (options.length) throw new Error(usage);
    if (command === "discover") {
      const recipe = await readSourceRecipe(file);
      const {catalog, catalogPath} = await withProgress(statusFile, context => discoverNetworks(recipe, context));
      await describeNetworks(catalog, catalogPath);
    } else if (command === "networks") {
      await describeNetworks(await readNetworkCatalog(file), file);
    } else if (command === "inspect") {
      process.stdout.write(`${JSON.stringify(await inspectPreparedRelease(file), null, 2)}\n`);
    } else throw new Error(usage);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await runDataCommand(process.argv.slice(2)).catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
