import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { SourceSnapshot } from "../adapters";
import { sha256File } from "../file-source";
import { writeJsonAtomically } from "../source-cache";
import { readPopulationCollection, refreshPopulationCollection, type PopulationCollection } from "./collection";
import type { Bbox, GhslProduct } from "./tiles";

export const populationSourceConfigSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  authority: z.literal("European Commission Joint Research Centre"),
  dataset: z.string().min(1),
  version: z.string().min(1),
  baseUrl: z.string().url(),
  release: z.string().regex(/^R\d{4}[A-Z]$/),
  epoch: z.number().int().min(1975).max(2030),
  productVersion: z.string().regex(/^V\d+-\d+$/),
  productFileVersion: z.string().regex(/^V\d+_\d+$/),
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  /**
   * Degrees of padding added around the pack bbox when selecting tiles. Must
   * exceed the sampling radius so a disc summed at the pack edge is not clipped
   * at a tile seam. 0.25 deg is roughly 28 km, comfortably above any radius we
   * use.
   */
  tilePaddingDegrees: z.number().min(0).max(5),
  resolution: z.literal("3 arc-second (nominal 90 m)"),
  crs: z.literal("EPSG:4326"),
  license: z.string().min(1),
}).strict();

export type PopulationSourceConfig = z.infer<typeof populationSourceConfigSchema>;
type PopulationPointer = { configVersion: string; collectionPath: string };

export async function readPopulationSourceConfig(configPath: string): Promise<PopulationSourceConfig> {
  return populationSourceConfigSchema.parse(JSON.parse(await readFile(configPath, "utf8")));
}

export function ghslProductFor(config: PopulationSourceConfig): GhslProduct {
  return {
    release: config.release,
    epoch: config.epoch,
    version: config.productVersion,
    fileVersion: config.productFileVersion,
    baseUrl: config.baseUrl,
  };
}

function pointerPath(cacheRoot: string, sourceId: string): string {
  return path.join(cacheRoot, sourceId, "pinned.json");
}

export type PinnedPopulationCollection = {
  collection: PopulationCollection;
  collectionPath: string;
  snapshot: SourceSnapshot;
};

export async function readPinnedPopulationCollection(
  cacheRoot: string,
  config: PopulationSourceConfig,
): Promise<PinnedPopulationCollection> {
  const pointer = JSON.parse(await readFile(pointerPath(cacheRoot, config.id), "utf8")) as PopulationPointer;
  if (pointer.configVersion !== config.version) throw new Error("Cached population collection does not match configured version");
  const collection = await readPopulationCollection(pointer.collectionPath);
  return {
    collection,
    collectionPath: pointer.collectionPath,
    snapshot: {
      id: config.id,
      authority: config.authority,
      dataset: config.dataset,
      version: config.version,
      retrievedAt: collection.retrievedAt,
      url: collection.directoryUrl,
      license: config.license,
      contentHash: await sha256File(pointer.collectionPath),
      localPath: pointer.collectionPath,
    },
  };
}

export async function refreshPinnedPopulationCollection(
  cacheRoot: string,
  config: PopulationSourceConfig,
  fetchImpl?: typeof fetch,
): Promise<PinnedPopulationCollection> {
  const result = await refreshPopulationCollection({
    cacheRoot,
    collectionRoot: path.join(cacheRoot, config.id, "collections"),
    product: ghslProductFor(config),
    bbox: config.bbox as Bbox,
    paddingDegrees: config.tilePaddingDegrees,
    sourceId: config.id,
    authority: config.authority,
    dataset: config.dataset,
    license: config.license,
    ...(fetchImpl ? { fetchImpl } : {}),
  });
  await writeJsonAtomically(pointerPath(cacheRoot, config.id), {
    configVersion: config.version,
    collectionPath: result.collectionPath,
  });
  return readPinnedPopulationCollection(cacheRoot, config);
}
