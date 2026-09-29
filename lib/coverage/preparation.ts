import { mkdir } from "node:fs/promises";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { readCuratedAccessFile } from "@/lib/data/curated-access";
import { readPinnedOsmSnapshot, refreshPinnedOsmSnapshot } from "@/lib/data/osm/source";
import { intersectCoverage } from "./geometry";
import type { SourceRecipe } from "./recipe";
import { CoverageSourceStore, sourceStoreFileName } from "./source-store";
import { CoverageResourceGuard } from "./resources";
import type { AreaGeometry } from "@/lib/data/area-geometry";
import type { CoverageProgressUpdate, CoverageRunnerContext, CoverageUnit } from "./types";

function preparationPaths() {
  const root = path.resolve(process.env.ALPINE_COVERAGE_ROOT ?? ".cache/build");
  return {
    root,
    scratchRoot: path.resolve(process.env.ALPINE_BUILD_SCRATCH ?? root),
    outputRoot: path.resolve(process.env.ALPINE_RELEASE_ROOT ?? ".local-data/releases/prepared"),
    cacheRoot: path.resolve(process.env.ALPINE_SOURCE_CACHE ?? ".cache/sources"),
  };
}
export async function preparationSession(recipe: SourceRecipe, context: CoverageRunnerContext) {
  const paths = preparationPaths();
  await mkdir(paths.root, {recursive:true});
  await mkdir(paths.scratchRoot, {recursive:true});
  const diskPaths = [...new Set([paths.root,paths.outputRoot,paths.scratchRoot])];
  // Count a configured scratch directory once even when it is under a cache root.
  const resources = new CoverageResourceGuard({memoryLimitBytes:recipe.memoryLimitMiB * 1024 ** 2,
    diskPaths:diskPaths.filter(directory => !diskPaths.some(parent => parent!==directory && directory.startsWith(path.join(parent,path.sep))))});
  const raws: CoverageSourceStore[] = [], units: CoverageUnit[] = [];
  resources.start();
  const measurements = (): CoverageProgressUpdate => ({peakMeasuredMemoryBytes:resources.peakMemoryBytes,peakCgroupMemoryBytes:resources.cgroupPeakBytes,peakDiskBytes:resources.peakDiskBytes});
  return {
    ...paths, raws, units,
    check: async () => {
      await setImmediate();
      await resources.checkpoint();
      if (context.signal.aborted || await context.checkpoint() !== "continue") throw new Error("Coverage build interrupted at a checkpoint");
    },
    report: async (stage: string, counts?: Record<string, number>) => {
      await resources.sample(stage);
      await context.report({stage, units, counts, completedUnits:units.filter(unit => unit.status === "prepared" || unit.status === "installed").length, ...measurements()});
    },
    close: async () => { raws.forEach(raw => raw.close()); await resources.stop(); await context.report(measurements()); },
  };
}
type Session = Awaited<ReturnType<typeof preparationSession>>;

/** Verify pinned source bytes and current restrictions before trusting local preparation. */
export async function preparationInputs(recipe: SourceRecipe, session: Session, geometry: AreaGeometry) {
  const restrictions: Awaited<ReturnType<typeof readCuratedAccessFile>>[] = [];
  for (const region of [...recipe.reviewedRegionIds].sort()) {
    try { restrictions.push(await readCuratedAccessFile(path.resolve(`data/regions/${region}/access-restrictions.json`))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  const snapshots = [];
  for (const source of recipe.sources) {
    if (!intersectCoverage(source.geometry, geometry)) continue;
    await session.check();
    await session.report(`Verifying ${source.config.dataset}`);
    const snapshot = await readPinnedOsmSnapshot(session.cacheRoot, source.config).catch(async (error: unknown) => {
      if (recipe.offline || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return (await refreshPinnedOsmSnapshot(session.cacheRoot, source.config)).snapshot;
    });
    if (snapshot.contentHash !== source.sha256) throw new Error(`Pinned source hash differs for ${source.config.id}`);
    snapshots.push(snapshot);
  }
  return {restrictions, snapshots};
}
export async function importLocalSources(session: Session, inputs: Awaited<ReturnType<typeof preparationInputs>>, geometry: AreaGeometry) {
  for (const snapshot of inputs.snapshots) {
    const raw = new CoverageSourceStore(path.join(session.root, sourceStoreFileName(snapshot, geometry)), snapshot, geometry);
    session.raws.push(raw);
    await session.report(`Preparing local walking links: ${snapshot.dataset}`);
    await raw.import(session.check, {onStage: async stage => session.report(`${stage}: ${snapshot.dataset}`)});
  }
}
