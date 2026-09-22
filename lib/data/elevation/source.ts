import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { SourceSnapshot } from "../adapters";
import { sha256File } from "../file-source";
import { resolveSourcePath, writeJsonAtomically, type CacheDownloadOptions } from "../source-cache";
import { readThreeDepCollection, refreshThreeDepCollection, type ThreeDepCollection } from "./collection";

export const elevationSourceConfigSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.literal("usgs-3dep-13-arc-second"),
  authority: z.literal("U.S. Geological Survey"),
  dataset: z.string().min(1),
  catalogId: z.string().min(1),
  version: z.string().min(1),
  endpoint: z.string().url(),
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  productExtent: z.string().min(1),
  expectedProductIds: z.array(z.string().min(1)).min(1),
  resolution: z.literal("1/3 arc-second (nominal 10 m)"),
  horizontalDatum: z.literal("NAD83"),
  verticalDatum: z.literal("NAVD88"),
  license: z.string().min(1),
  cacheNamespace: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).optional(),
}).strict();

export type ElevationSourceConfig = z.infer<typeof elevationSourceConfigSchema>;
type ElevationPointer = { configVersion: string; collectionPath: string };

export async function readElevationSourceConfig(configPath: string): Promise<ElevationSourceConfig> {
  return elevationSourceConfigSchema.parse(JSON.parse(await readFile(configPath, "utf8")));
}

export function elevationPointerPath(cacheRoot: string, config: ElevationSourceConfig): string {
  return path.join(cacheRoot, config.cacheNamespace ?? config.id, "pinned.json");
}

export async function readPinnedThreeDepCollection(
  cacheRoot: string,
  config: ElevationSourceConfig,
): Promise<{ collection: ThreeDepCollection; collectionPath: string; snapshot: SourceSnapshot; buildFingerprint: `sha256:${string}` }> {
  const pointer = JSON.parse(await readFile(elevationPointerPath(cacheRoot, config), "utf8")) as ElevationPointer;
  if (pointer.configVersion !== config.version) throw new Error("Cached 3DEP collection does not match configured version");
  const collectionPath = resolveSourcePath(cacheRoot, pointer.collectionPath, config.cacheNamespace ?? config.id);
  const collection = await readThreeDepCollection(collectionPath);
  if (collection.products.map(({ productId }) => productId).sort().join("\n") !== [...config.expectedProductIds].sort().join("\n")) {
    throw new Error("Cached 3DEP collection does not match configured products");
  }
  for (const product of collection.products) {
    const file = path.resolve(path.dirname(collectionPath), product.filePath);
    if ((await stat(file)).size !== product.receipt.byteLength || await sha256File(file) !== product.receipt.sha256) {
      throw new Error(`Cached 3DEP product ${product.productId} failed integrity validation`);
    }
  }
  // Preserve product order: it determines precedence where DEM tiles overlap.
  const buildFingerprint = `sha256:${createHash("sha256").update(JSON.stringify({
    version: "dem-content-v1", resolution: collection.resolution,
    horizontalDatum: collection.horizontalDatum, verticalDatum: collection.verticalDatum,
    products: collection.products.map(({ productId, receipt }) => [productId, receipt.sha256]),
  })).digest("hex")}` as const;
  return {
    collection,
    collectionPath,
    buildFingerprint,
    snapshot: {
      id: config.id,
      authority: config.authority,
      dataset: config.dataset,
      version: config.version,
      retrievedAt: collection.retrievedAt,
      url: config.endpoint,
      license: config.license,
      contentHash: await sha256File(collectionPath),
      localPath: collectionPath,
    },
  };
}

export async function refreshPinnedThreeDepCollection(
  cacheRoot: string,
  config: ElevationSourceConfig,
  fetchImpl?: typeof fetch,
  onProgress?: CacheDownloadOptions["onProgress"],
): Promise<Awaited<ReturnType<typeof readPinnedThreeDepCollection>>> {
  const result = await refreshThreeDepCollection({
    cacheRoot,
    collectionRoot: path.join(cacheRoot, config.cacheNamespace ?? config.id, "collections"),
    query: {
      endpoint: config.endpoint,
      dataset: config.dataset,
      bbox: config.bbox,
      productExtent: config.productExtent,
      expectedProductIds: config.expectedProductIds,
    },
    catalogId: config.catalogId,
    onProgress,
    ...(fetchImpl ? { fetchImpl } : {}),
  });
  await writeJsonAtomically(elevationPointerPath(cacheRoot, config), {
    configVersion: config.version,
    collectionPath: path.relative(cacheRoot, result.collectionPath),
  });
  return readPinnedThreeDepCollection(cacheRoot, config);
}
