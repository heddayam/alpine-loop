import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { SourceSnapshot } from "../adapters";
import { downloadToSourceCache, writeJsonAtomically, type CachedSource, type CacheDownloadOptions } from "../source-cache";

export const osmSourceConfigSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  authority: z.string().min(1),
  dataset: z.string().min(1),
  version: z.string().min(1),
  upstreamTimestamp: z.string().datetime(),
  url: z.string().url(),
  expectedByteLength: z.number().int().positive(),
  license: z.string().min(1),
  attribution: z.string().min(1),
}).strict();

export type OsmSourceConfig = z.infer<typeof osmSourceConfigSchema>;

type OsmPointer = { configVersion: string; cached: CachedSource };

export async function readOsmSourceConfig(configPath: string): Promise<OsmSourceConfig> {
  return osmSourceConfigSchema.parse(JSON.parse(await readFile(configPath, "utf8")));
}
export function osmPointerPath(cacheRoot: string, sourceId: string): string {
  return path.join(cacheRoot, sourceId, "pinned.json");
}

export async function readPinnedOsmSnapshot(cacheRoot: string, config: OsmSourceConfig): Promise<SourceSnapshot> {
  const pointer = JSON.parse(await readFile(osmPointerPath(cacheRoot, config.id), "utf8")) as OsmPointer;
  if (pointer.configVersion !== config.version) throw new Error("Cached OSM snapshot does not match configured version");
  return {
    id: config.id,
    authority: config.authority,
    dataset: config.dataset,
    version: config.version,
    retrievedAt: pointer.cached.receipt.retrievedAt,
    url: config.url,
    license: config.license,
    contentHash: pointer.cached.receipt.sha256,
    localPath: pointer.cached.filePath,
  };
}

export async function refreshPinnedOsmSnapshot(
  cacheRoot: string,
  config: OsmSourceConfig,
  fetchImpl?: typeof fetch,
  onProgress?: CacheDownloadOptions["onProgress"],
): Promise<{ snapshot: SourceSnapshot; cached: CachedSource }> {
  let expectedSha256: `sha256:${string}` | undefined;
  try {
    expectedSha256 = (await readPinnedOsmSnapshot(cacheRoot, config)).contentHash;
  } catch {
    // An empty cache is the expected first-build state.
  }
  const cached = await downloadToSourceCache({
    cacheRoot,
    sourceId: config.id,
    url: config.url,
    fileName: `${config.id}-${config.version}.osm.pbf`,
    expectedByteLength: config.expectedByteLength,
    onProgress,
    ...(expectedSha256 ? { expectedSha256 } : {}),
    ...(fetchImpl ? { fetchImpl } : {}),
  });
  await writeJsonAtomically(osmPointerPath(cacheRoot, config.id), { configVersion: config.version, cached });
  return { snapshot: await readPinnedOsmSnapshot(cacheRoot, config), cached };
}
