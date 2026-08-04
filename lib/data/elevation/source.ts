import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { SourceSnapshot } from "../adapters";
import { sha256File } from "../file-source";
import { writeJsonAtomically } from "../source-cache";
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
}).strict();

export type ElevationSourceConfig = z.infer<typeof elevationSourceConfigSchema>;
type ElevationPointer = { configVersion: string; collectionPath: string };

export async function readElevationSourceConfig(configPath: string): Promise<ElevationSourceConfig> {
  return elevationSourceConfigSchema.parse(JSON.parse(await readFile(configPath, "utf8")));
}

function pointerPath(cacheRoot: string, sourceId: string): string {
  return path.join(cacheRoot, sourceId, "pinned.json");
}

export async function readPinnedThreeDepCollection(
  cacheRoot: string,
  config: ElevationSourceConfig,
): Promise<{ collection: ThreeDepCollection; collectionPath: string; snapshot: SourceSnapshot }> {
  const pointer = JSON.parse(await readFile(pointerPath(cacheRoot, config.id), "utf8")) as ElevationPointer;
  if (pointer.configVersion !== config.version) throw new Error("Cached 3DEP collection does not match configured version");
  const collection = await readThreeDepCollection(pointer.collectionPath);
  return {
    collection,
    collectionPath: pointer.collectionPath,
    snapshot: {
      id: config.id,
      authority: config.authority,
      dataset: config.dataset,
      version: config.version,
      retrievedAt: collection.retrievedAt,
      url: config.endpoint,
      license: config.license,
      contentHash: await sha256File(pointer.collectionPath),
      localPath: pointer.collectionPath,
    },
  };
}

export async function refreshPinnedThreeDepCollection(
  cacheRoot: string,
  config: ElevationSourceConfig,
  fetchImpl?: typeof fetch,
): Promise<Awaited<ReturnType<typeof readPinnedThreeDepCollection>>> {
  const result = await refreshThreeDepCollection({
    cacheRoot,
    collectionRoot: path.join(cacheRoot, config.id, "collections"),
    query: {
      endpoint: config.endpoint,
      dataset: config.dataset,
      bbox: config.bbox,
      productExtent: config.productExtent,
      expectedProductIds: config.expectedProductIds,
    },
    catalogId: config.catalogId,
    ...(fetchImpl ? { fetchImpl } : {}),
  });
  await writeJsonAtomically(pointerPath(cacheRoot, config.id), {
    configVersion: config.version,
    collectionPath: result.collectionPath,
  });
  return readPinnedThreeDepCollection(cacheRoot, config);
}
