import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";
import { readElevationSourceConfig, readPinnedThreeDepCollection } from "@/lib/data/elevation/source";
import { refreshThreeDepCollection, readThreeDepCollection, type ThreeDepCollection } from "@/lib/data/elevation/collection";
import { UvRasterioThreeDepElevationSampler } from "@/lib/data/elevation/uv-rasterio-sampler";
import { sha256File } from "@/lib/data/file-source";
import { writeJsonAtomically } from "@/lib/data/source-cache";
import { areaBounds } from "@/lib/graph/geometry";
import type { CoverageUnit } from "./types";
import type { AreaGeometry } from "@/lib/data/area-geometry";
import type { ElevationSampler, SourceSnapshot } from "@/lib/data/adapters";
import { intersectCoverage, rectangle } from "./geometry";
import { legacyRegionIds } from "./collections";

type Product = ThreeDepCollection["products"][number];
export type ElevationCache = {
  pinned: Map<string, Promise<Awaited<ReturnType<typeof readPinnedThreeDepCollection>>>>;
  verifiedProducts: Set<string>;
  canonical?: { products: Product[]; template?: ThreeDepCollection };
  pinCoverage?: AreaGeometry;
};
export const elevationCache = (): ElevationCache => ({ pinned: new Map(), verifiedProducts: new Set() });

/** Changes to configured DEM pins require a fresh graph generation. */
export async function elevationPinsFingerprint(cacheRoot: string, coverage: AreaGeometry, cache = elevationCache()): Promise<string> {
  cache.pinCoverage = coverage;
  const pins: unknown[] = [];
  for (const region of legacyRegionIds) {
    try {
      const config = await readElevationSourceConfig(path.resolve(`data/regions/${region}/elevation-source.json`));
      if (!intersectCoverage(coverage, rectangle(config.bbox))) continue;
      const key = JSON.stringify(config);
      if (!cache.pinned.has(key)) cache.pinned.set(key, readPinnedThreeDepCollection(cacheRoot, config));
      const found = await cache.pinned.get(key)!;
      for (const product of absoluteProducts(found.collection, found.collectionPath))
        cache.verifiedProducts.add(`${product.filePath}:${product.receipt.sha256}`);
      pins.push([region, config.version, found.buildFingerprint]);
    } catch (error) {
      // An absent pin can be completed online, but its absence is itself part
      // of the source generation and cannot silently reuse older metrics.
      pins.push([region, (error as Error).message]);
    }
  }
  return createHash("sha256").update(JSON.stringify(pins)).digest("hex");
}

/** USGS one-degree product titles name the north-west tile corner (for example n48w122). */
function tile(product: Product): string | null {
  const match = /\b([ns])(\d{1,2})([ew])(\d{1,3})\b/i.exec(product.title);
  if (!match) return null;
  const north = Number(match[2]) * (match[1]!.toLowerCase() === "n" ? 1 : -1);
  const west = Number(match[4]) * (match[3]!.toLowerCase() === "e" ? 1 : -1);
  return `${west},${north - 1}`;
}

/** A partial cache never stands in for a whole selected installation unit. */
export function missingDemTiles(unit: CoverageUnit, products: readonly Product[]): string[] {
  const present = new Set(products.map(tile).filter((value): value is string => value !== null));
  const [west, south, east, north] = areaBounds(unit.geometry);
  const missing: string[] = [];
  for (let y = Math.floor(south); y < Math.ceil(north); y++) {
    for (let x = Math.floor(west); x < Math.ceil(east); x++) {
      if (!present.has(`${x},${y}`)
        && intersectCoverage(unit.geometry, rectangle([x, y, x + 1, y + 1]))) missing.push(`${x},${y}`);
    }
  }
  return missing;
}

/** Validate bytes on every resume, including the merged per-unit collection. */
export async function validateDemProducts(collection: ThreeDepCollection, collectionPath: string, verified = new Set<string>()): Promise<void> {
  for (const product of collection.products) {
    const file = path.resolve(path.dirname(collectionPath), product.filePath);
    const key = `${file}:${product.receipt.sha256}`;
    if (verified.has(key)) continue;
    if ((await stat(file)).size !== product.receipt.byteLength || await sha256File(file) !== product.receipt.sha256) {
      throw new Error(`Cached 3DEP product ${product.productId} failed integrity validation`);
    }
    verified.add(key);
  }
}

function absoluteProducts(collection: ThreeDepCollection, collectionPath: string): Product[] {
  return collection.products.map((product) => ({
    ...product, filePath: path.resolve(path.dirname(collectionPath), product.filePath),
  }));
}

function tileIntersectsCoverage(key: string | null, coverage: AreaGeometry): boolean {
  if (!key) return false;
  const [west, south] = key.split(",").map(Number);
  return Boolean(intersectCoverage(coverage, rectangle([west!, south!, west! + 1, south! + 1])));
}

/** All units in a preparation use the same ordered raster mosaic, including on resume. */
async function canonicalFor(unit: CoverageUnit, cacheRoot: string, preparationRoot: string, cache: ElevationCache): Promise<{
  state: NonNullable<ElevationCache["canonical"]>; cachedPath: string;
}> {
  const directory = path.join(preparationRoot, "dem", "canonical");
  const cachedPath = path.join(directory, "collection.json");
  if (!cache.canonical) {
    let cached: ThreeDepCollection | undefined;
    try {
      cached = await readThreeDepCollection(cachedPath);
      await validateDemProducts(cached, cachedPath, cache.verifiedProducts);
    } catch {
      cached = undefined; // A malformed or tampered cache cannot be used as a resume receipt.
    }
    const relevantCoverage = cache.pinCoverage ?? unit.geometry;
    const products = cached ? absoluteProducts(cached, cachedPath).filter((product) => tileIntersectsCoverage(tile(product), relevantCoverage)) : [];
    let template: ThreeDepCollection | undefined;
    // Load every configured pin before selecting any tile. Request order cannot
    // determine which overlapping pinned raster wins.
    const pinned = new Map<string, Product>();
    for (const region of legacyRegionIds) {
      try {
        const config = await readElevationSourceConfig(path.resolve(`data/regions/${region}/elevation-source.json`));
        if (!intersectCoverage(cache.pinCoverage ?? unit.geometry, rectangle(config.bbox))) continue;
        const key = JSON.stringify(config);
        if (!cache.pinned.has(key)) cache.pinned.set(key, readPinnedThreeDepCollection(cacheRoot, config));
        const found = await cache.pinned.get(key)!;
        for (const product of absoluteProducts(found.collection, found.collectionPath)) cache.verifiedProducts.add(`${product.filePath}:${product.receipt.sha256}`);
        template ??= found.collection;
        for (const product of absoluteProducts(found.collection, found.collectionPath)) {
          const key = tile(product);
          if (!key) continue;
          const prior = pinned.get(key);
          if (!prior || product.productId.localeCompare(prior.productId) < 0) pinned.set(key, product);
        }
      } catch { /* Missing or invalid pins cannot establish DEM coverage. */ }
    }
    template ??= cached;
    const seen = new Set<string>();
    const canonical = products.map((product) => {
      const key = tile(product);
      if (!key) return product;
      seen.add(key);
      return pinned.get(key) ?? product;
    });
    for (const [key, product] of [...pinned].sort(([a], [b]) => a.localeCompare(b))) {
      if (!seen.has(key)) canonical.push(product);
    }
    cache.canonical = { products: canonical, template };
  }
  return { state: cache.canonical, cachedPath };
}

export async function elevationFor(unit: CoverageUnit, cacheRoot: string, preparationRoot: string, offline: boolean, cache = elevationCache()): Promise<{ sampler: ElevationSampler; source: SourceSnapshot; productFingerprint: string }> {
  const { state, cachedPath } = await canonicalFor(unit, cacheRoot, preparationRoot, cache);
  const missingBeforeAcquisition = missingDemTiles(unit, state.products);
  if (missingBeforeAcquisition.length) {
    if (offline) throw new Error("No verified cached elevation covers this entire area. Build online once to acquire the missing DEM tiles.");
    const config = await readElevationSourceConfig(path.resolve("data/regions/central-cascades/elevation-source.json"));
    for (const key of missingBeforeAcquisition) {
      if (state.products.some((product) => tile(product) === key)) continue;
      const [west, south] = key.split(",").map(Number);
      const downloaded = await refreshThreeDepCollection({
        cacheRoot, collectionRoot: path.join(preparationRoot, "dem", "acquired"),
        query: { endpoint: config.endpoint, dataset: config.dataset, bbox: [west!, south!, west! + 1, south! + 1], productExtent: config.productExtent,
          nominalTile: `${south! + 1 >= 0 ? "n" : "s"}${Math.abs(south! + 1)}${west! >= 0 ? "e" : "w"}${Math.abs(west!)}` },
        catalogId: config.catalogId,
      });
      await validateDemProducts(downloaded.collection, downloaded.collectionPath, cache.verifiedProducts);
      state.template ??= downloaded.collection;
      const product = absoluteProducts(downloaded.collection, downloaded.collectionPath)
        .filter((item) => tile(item) === key).sort((a, b) => a.productId.localeCompare(b.productId))[0];
      if (product) state.products.push(product);
    }
  }
  // Tile ownership makes sampling independent of array order. Keep the saved
  // collection and content identity canonical as well, across request orders.
  const selected = state.products.sort((a, b) => (tile(a) ?? "").localeCompare(tile(b) ?? "") || a.productId.localeCompare(b.productId));
  const missing = missingDemTiles(unit, selected);
  if (!state.template || missing.length) throw new Error(`3DEP products do not cover required one-degree tiles: ${missing.join(", ")}`);
  const collection: ThreeDepCollection = { ...state.template, products: selected };
  await writeJsonAtomically(cachedPath, collection);
  const described = describeInitialized(unit.geometry, cachedPath, state);
  if (!described) throw new Error("No canonical DEM product covers this installation unit");
  return { sampler: new UvRasterioThreeDepElevationSampler(cachedPath, { tileOwnership: true }), ...described };
}

function describeInitialized(geometry: AreaGeometry, cachedPath: string, state: NonNullable<ElevationCache["canonical"]>): {source:SourceSnapshot;productFingerprint:string}|null {
  const selected = state.products;
  if (!selected.length || !state.template) return null;
  const identity = (products: readonly Product[]) => `sha256:${createHash("sha256").update(JSON.stringify(products.map((p) => [tile(p), p.productId, p.receipt.sha256]))).digest("hex")}` as const;
  const hash = identity(selected);
  const relevant = new Set<string>();
  const [west, south, east, north] = areaBounds(geometry);
  for (let y = Math.floor(south); y < Math.ceil(north); y++) for (let x = Math.floor(west); x < Math.ceil(east); x++) {
    if (intersectCoverage(geometry, rectangle([x, y, x + 1, y + 1]))) relevant.add(`${x},${y}`);
  }
  const relevantProducts = selected.filter((product) => relevant.has(tile(product) ?? ""));
  if (!relevantProducts.length) return null;
  const productFingerprint = identity(relevantProducts);
  const collection = state.template;
  const retrievedAt = selected.map((product) => product.receipt.retrievedAt).sort().at(-1)!;
  const endpoint = new URL(collection.queryUrl);
  endpoint.search = "";
  endpoint.hash = "";
  const source: SourceSnapshot = {
    id: `usgs-dem-${hash.slice(7, 23)}`, authority: collection.authority, dataset: collection.dataset,
    version: hash, retrievedAt, url: endpoint.toString(),
    license: collection.license, contentHash: hash, localPath: cachedPath,
  };
  return { source, productFingerprint };
}

/** Describe already verified products without downloading DEM for water or empty graph areas. */
export async function describeCanonicalElevation(geometry: AreaGeometry, cacheRoot: string, preparationRoot: string, cache = elevationCache()): Promise<{source:SourceSnapshot;productFingerprint:string}|null> {
  const { state, cachedPath } = await canonicalFor({ id: "description", geometry, status: "pending" }, cacheRoot, preparationRoot, cache);
  state.products.sort((a, b) => (tile(a) ?? "").localeCompare(tile(b) ?? "") || a.productId.localeCompare(b.productId));
  const described = describeInitialized(geometry, cachedPath, state);
  if (described) await writeJsonAtomically(cachedPath, { ...state.template!, products: state.products });
  return described;
}
