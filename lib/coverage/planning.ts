import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { coverageRequestSchema, coverageSnapshotSchema, type CoverageCatalog, type CoveragePlan, type CoverageRequest, type CoverageSnapshot } from "@/lib/contracts";
import { loadInstalledPack } from "@/lib/packs/installed-pack";
import { inspectPinnedOsmSnapshot } from "@/lib/data/osm/source";
import { collections, coverageExclusions, coverageSources, planCoverageGeometry } from "./collections";
import { contentId, intersectCoverage, unionCoverage } from "./geometry";
import { NORMALIZATION_VERSION, sourceStoreFileName } from "./source-store";

export const COVERAGE_PACK_ID = "local-coverage";
export const COVERAGE_BUILD_VERSION = `progressive-v1:${NORMALIZATION_VERSION}`;
const exec = promisify(execFile);

export async function installedSnapshot(): Promise<CoverageSnapshot | null> {
  const pack = await loadInstalledPack(COVERAGE_PACK_ID);
  return pack ? coverageSnapshotSchema.parse(JSON.parse(await readFile(path.join(pack.directory, "coverage-snapshot.json"), "utf8"))) : null;
}
export async function catalog(): Promise<CoverageCatalog> {
  const prerequisites = await Promise.all(["osmium", "uv"].map(async (id) => {
    try { await exec(id, ["--version"], { timeout: 3000 }); return { id, available: true, instructions: `${id} is installed` }; }
    catch { return { id, available: false, instructions: `Install ${id} locally before building coverage` }; }
  }));
  return { collections: await collections(), installed: await installedSnapshot(), jobs: [], prerequisites };
}
export async function plan(input: CoverageRequest): Promise<CoveragePlan> {
  const request = coverageRequestSchema.parse(input);
  const available = await collections();
  const selected = request.collectionIds.map((id) => {
    const collection = available.find((item) => item.id === id);
    if (!collection) throw new Error(`Unknown collection: ${id}`);
    return collection;
  });
  const geometry = unionCoverage([...selected.map((item) => item.geometry), ...(request.geometry ? [request.geometry] : [])]);
  const sources = (await coverageSources()).filter((source) => intersectCoverage(source.geometry, geometry));
  if (!sources.length) throw new Error("No configured source covers this installation area");
  const units = planCoverageGeometry(geometry, sources, await coverageExclusions()).units;
  const sourceIds = [...new Set(sources.map((source) => source.config.id))].sort();
  const cache = path.resolve(/* turbopackIgnore: true */ process.env.ALPINE_SOURCE_CACHE ?? ".cache/sources");
  const preparationRoot = path.resolve(/* turbopackIgnore: true */ process.env.ALPINE_COVERAGE_ROOT ?? ".local-data/coverage");
  const cached = await Promise.all(sources.map(async ({config}) => {
    try {
      const snapshot = await inspectPinnedOsmSnapshot(cache,config);
      const file = path.join(preparationRoot, sourceStoreFileName(snapshot));
      const preparationBytes = (await Promise.all(["", "-wal", "-shm"].map(async (suffix) => {
        try { return (await stat(`${file}${suffix}`)).size; } catch { return 0; }
      }))).reduce((sum, size) => sum + size, 0);
      return { sourceBytes: config.expectedByteLength, preparationBytes };
    } catch { return { sourceBytes: 0, preparationBytes: 0 }; }
  }));
  const cachedSourceBytes = cached.reduce((sum, item) => sum + item.sourceBytes, 0);
  const cachedPreparationBytes = cached.reduce((sum, item) => sum + item.preparationBytes, 0);
  const reusableBytes = cachedSourceBytes + cachedPreparationBytes;
  const upstreamBytes = sources.reduce((sum,{config})=>sum+config.expectedByteLength,0);
  return { id: contentId({ request, sources: sources.map(({ config }) => config), version: COVERAGE_BUILD_VERSION }), request, geometry, units, sourceIds,
    estimates: { downloadBytes: null, temporaryBytes: null, reusableBytes },
    warnings: [...new Set(selected.flatMap((item) => item.limitations)),
      `${Math.ceil((upstreamBytes-cachedSourceBytes)/1024**2)} MiB of configured OSM downloads remain; ${Math.ceil(cachedSourceBytes/1024**2)} MiB is present in the source cache.`,
      `${Math.ceil(cachedPreparationBytes/1024**2)} MiB of cached source preparation found. Cached data and checkpoints are verified when installation starts; reuse is not guaranteed by this preview.`,
      "A small area may require the full upstream source download. Additional elevation downloads and disk estimates remain unknown until acquisition."] };
}
