import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { downloadToSourceCache, withAtomicDirectory, type SourceReceipt } from "../source-cache";
import { extractSingleZipEntry } from "../zip";
import {
  assertTileBoundsMatch,
  ghslProductDirectoryUrl,
  ghslTileBounds,
  ghslTileFileName,
  ghslTileKey,
  ghslTilesForBbox,
  ghslTileUrl,
  parseGhslTileKey,
  parsePublishedTileKeys,
  type Bbox,
  type GhslProduct,
  type GhslTile,
} from "./tiles";

const boundsSchema = z.tuple([z.number(), z.number(), z.number(), z.number()]);

const receiptSchema = z.object({
  schemaVersion: z.literal(1), sourceId: z.string(), originalUrl: z.string().url(), resolvedUrl: z.string().url(),
  retrievedAt: z.string().datetime(), byteLength: z.number().int().positive(),
  sha256: z.string().regex(/^sha256:[a-f0-9]{64}$/), fileName: z.string(),
  etag: z.string().optional(), lastModified: z.string().optional(),
}).strict();

export const populationCollectionSchema = z.object({
  schemaVersion: z.literal(1),
  sourceId: z.string().min(1),
  authority: z.string().min(1),
  dataset: z.string().min(1),
  release: z.string().min(1),
  epoch: z.number().int(),
  productVersion: z.string().min(1),
  resolution: z.literal("3 arc-second (nominal 90 m)"),
  crs: z.literal("EPSG:4326"),
  retrievedAt: z.string().datetime(),
  directoryUrl: z.string().url(),
  license: z.string().min(1),
  /** Tiles that exist and were downloaded. */
  products: z.array(z.object({
    tileKey: z.string().min(1),
    bounds: boundsSchema,
    filePath: z.string().min(1),
    receipt: receiptSchema,
  }).strict()),
  /**
   * Tiles the index predicted that GHSL does not publish. GHSL omits tiles with
   * no population, so these are zero rather than unknown, and the sampler needs
   * their bounds to tell those two cases apart.
   */
  emptyTiles: z.array(z.object({
    tileKey: z.string().min(1),
    bounds: boundsSchema,
  }).strict()),
}).strict().refine(
  (value) => value.products.length + value.emptyTiles.length > 0,
  { message: "population collection covers no tiles" },
);

export type PopulationCollection = z.infer<typeof populationCollectionSchema>;

export type RefreshPopulationOptions = {
  cacheRoot: string;
  collectionRoot: string;
  product: GhslProduct;
  bbox: Bbox;
  /** Expanded around the pack bbox so radius sums near the edge are not clipped. */
  paddingDegrees: number;
  sourceId: string;
  authority: string;
  dataset: string;
  license: string;
  retrievedAt?: string;
  fetchImpl?: typeof fetch;
};

async function fetchPublishedTileKeys(product: GhslProduct, fetchImpl: typeof fetch): Promise<Set<string>> {
  const directoryUrl = ghslProductDirectoryUrl(product);
  const response = await fetchImpl(directoryUrl);
  if (!response.ok) throw new Error(`GHSL tile directory listing failed: HTTP ${response.status} for ${directoryUrl}`);
  return parsePublishedTileKeys(await response.text());
}

function tifName(tile: GhslTile): string {
  return `ghs-pop-${ghslTileKey(tile).toLowerCase()}.tif`;
}

export async function refreshPopulationCollection(options: RefreshPopulationOptions): Promise<{
  collection: PopulationCollection;
  collectionPath: string;
}> {
  const retrievedAt = options.retrievedAt ?? new Date().toISOString();
  const fetchImpl = options.fetchImpl ?? fetch;
  const required = ghslTilesForBbox(options.bbox, options.paddingDegrees);
  const published = await fetchPublishedTileKeys(options.product, fetchImpl);

  const downloaded: Array<{ tileKey: string; bounds: Bbox; filePath: string; receipt: SourceReceipt }> = [];
  const emptyTiles: Array<{ tileKey: string; bounds: Bbox }> = [];
  for (const tile of required) {
    const key = ghslTileKey(tile);
    if (!published.has(key)) {
      // Absent means GHSL found no population in this 10-degree cell.
      emptyTiles.push({ tileKey: key, bounds: ghslTileBounds(tile) });
      continue;
    }
    const archive = await downloadToSourceCache({
      cacheRoot: options.cacheRoot,
      sourceId: `${options.sourceId}-${key.toLowerCase()}`,
      url: ghslTileUrl(options.product, tile),
      fileName: ghslTileFileName(options.product, tile),
      retrievedAt,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });
    const extractedPath = path.join(archive.directory, tifName(tile));
    try {
      await readFile(extractedPath);
    } catch {
      const buffer = await readFile(archive.filePath);
      const entry = extractSingleZipEntry(buffer, (name) => /\.tiff?$/i.test(name) && !name.startsWith("__MACOSX/"), `GeoTIFF for tile ${key}`);
      await writeFile(extractedPath, entry.contents);
    }
    downloaded.push({
      tileKey: key,
      bounds: ghslTileBounds(tile),
      filePath: extractedPath,
      receipt: archive.receipt,
    });
  }

  const identity = createHash("sha256")
    .update([
      ...downloaded.map(({ tileKey, receipt }) => `${tileKey}:${receipt.sha256}`),
      ...emptyTiles.map(({ tileKey }) => `${tileKey}:empty`),
    ].join("\n"))
    .digest("hex").slice(0, 24);
  const destination = path.join(options.collectionRoot, identity);
  const collectionPath = path.join(destination, "collection.json");
  const collection = populationCollectionSchema.parse({
    schemaVersion: 1,
    sourceId: options.sourceId,
    authority: options.authority,
    dataset: options.dataset,
    release: options.product.release,
    epoch: options.product.epoch,
    productVersion: options.product.version,
    resolution: "3 arc-second (nominal 90 m)",
    crs: "EPSG:4326",
    retrievedAt,
    directoryUrl: ghslProductDirectoryUrl(options.product),
    license: options.license,
    products: downloaded.map((product) => ({
      ...product,
      filePath: path.relative(destination, product.filePath),
    })),
    emptyTiles,
  });
  try {
    return { collection: await readPopulationCollection(collectionPath), collectionPath };
  } catch {
    await withAtomicDirectory(destination, async (staging) => {
      await writeFile(path.join(staging, "collection.json"), `${JSON.stringify(collection, null, 2)}\n`, { flag: "wx" });
    });
    return { collection, collectionPath };
  }
}

export async function readPopulationCollection(collectionPath: string): Promise<PopulationCollection> {
  return populationCollectionSchema.parse(JSON.parse(await readFile(collectionPath, "utf8")));
}

export type RasterDescription = {
  fileName: string;
  epsg: number | null;
  bounds: Bbox;
  width: number;
  height: number;
};

/**
 * Cross-checks every downloaded raster against the tile index. GHSL's grid
 * origin is offset from (-180, 90) and a few antimeridian tiles break the affine
 * row numbering, so a future region that lands on an irregularity must fail the
 * build rather than quietly sample population from the wrong place.
 */
export function assertCollectionMatchesTileIndex(
  collection: PopulationCollection,
  descriptions: readonly RasterDescription[],
): void {
  const byFileName = new Map(descriptions.map((description) => [description.fileName, description]));
  if (byFileName.size !== collection.products.length) {
    throw new Error(`Population collection has ${collection.products.length} rasters but ${byFileName.size} were described`);
  }
  for (const product of collection.products) {
    const description = byFileName.get(path.basename(product.filePath));
    if (!description) throw new Error(`Population raster ${product.filePath} was not described`);
    if (description.epsg !== 4326) {
      throw new Error(`Population raster ${product.filePath} is EPSG:${description.epsg ?? "unknown"}, expected 4326`);
    }
    assertTileBoundsMatch(parseGhslTileKey(product.tileKey), description.bounds);
  }
}
