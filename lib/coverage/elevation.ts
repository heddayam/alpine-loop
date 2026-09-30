import { densifyGeometry } from "@/lib/data/metrics";
import type { Coordinate } from "@/lib/data/types";
import { createHash } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
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

type Product = ThreeDepCollection["products"][number];
// Replace product arrays when inventory changes so every sampler sharing the
// inventory can invalidate its derived fingerprints without scanning each call.
type Inventory = { products: readonly Product[]; template?: ThreeDepCollection };
const BACKUP_POLICY = "usgs-3dep-10m-primary-30m-nodata-v1";
const BACKUP_LIMITATION = "Elevation uses USGS 10 m data, with USGS 30 m data only where the 10 m raster has NoData. These lower-resolution samples can affect elevation gain and grade estimates.";
export type ElevationCache = {
  pinned: Map<string, Promise<Awaited<ReturnType<typeof readPinnedThreeDepCollection>>>>;
  verifiedProducts: Set<string>;
  canonical?: Inventory;
  backup?: Inventory;
};
export const elevationCache = (): ElevationCache => ({ pinned: new Map(), verifiedProducts: new Set() });

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

/** Keep a shared verified product inventory, but resolve pins for each area's extent.
 * Action fingerprints describe only products used by that area (Bazel's input-cache pattern).
 */
async function canonicalFor(unit: CoverageUnit, cacheRoot: string, preparationRoot: string, cache: ElevationCache): Promise<{
  state: NonNullable<ElevationCache["canonical"]>; cachedPath: string;
}> {
  const cachedPath = path.join(preparationRoot, "dem", "canonical", "collection.json");
  if (!cache.canonical) {
    let cached: ThreeDepCollection | undefined;
    try { cached = await readThreeDepCollection(cachedPath); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (cached && cached.resolution !== "1/3 arc-second (nominal 10 m)") throw new Error("Expected a 10 m primary elevation collection");
    cache.canonical = { products: cached ? absoluteProducts(cached, cachedPath) : [], template: cached };
  }
  const state = cache.canonical;
  const pinned = new Map<string, Product>();
  // Retained source configs are cache hints, not a second publication catalog.
  const inputs = await readdir(path.resolve("data/regions"), {withFileTypes:true});
  for (const region of inputs.filter(entry=>entry.isDirectory()).map(entry=>entry.name).sort()) {
    let config;
    try { config = await readElevationSourceConfig(path.resolve(`data/regions/${region}/elevation-source.json`)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    if (!intersectCoverage(unit.geometry, rectangle(config.bbox))) continue;
    const key = JSON.stringify(config);
    try {
      if (!cache.pinned.has(key)) cache.pinned.set(key, readPinnedThreeDepCollection(cacheRoot, config));
      const found = await cache.pinned.get(key)!;
      if (found.collection.resolution !== "1/3 arc-second (nominal 10 m)") throw new Error("Expected a 10 m primary elevation collection");
      state.template ??= found.collection;
      for (const product of absoluteProducts(found.collection, found.collectionPath)) {
        const key = tile(product);
        if (!key || !tileIntersectsCoverage(key, unit.geometry)) continue;
        cache.verifiedProducts.add(`${product.filePath}:${product.receipt.sha256}`);
        const prior = pinned.get(key);
        if (!prior || product.productId.localeCompare(prior.productId) < 0) pinned.set(key, product);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const products = new Map(state.products.map(product => [tile(product), product]));
  for (const [key, product] of pinned) products.set(key, product);
  state.products = [...products.values()].sort((a, b) => (tile(a) ?? "").localeCompare(tile(b) ?? "") || a.productId.localeCompare(b.productId));
  if (state.template) await validateDemProducts({ ...state.template, products: state.products.filter(product => tileIntersectsCoverage(tile(product), unit.geometry)) }, cachedPath, cache.verifiedProducts);
  return { state, cachedPath };
}

function owner([lon, lat]: readonly [number, number]): string { return `${Math.floor(lon)},${Math.ceil(lat) - 1}`; }

async function backupFor(geometry: AreaGeometry, preparationRoot: string, cache: ElevationCache) {
  const cachedPath = path.join(preparationRoot, "dem", "backup", "canonical", "collection.json");
  if (!cache.backup) {
    let collection: ThreeDepCollection | undefined;
    try { collection = await readThreeDepCollection(cachedPath); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (collection && collection.resolution !== "1 arc-second (nominal 30 m)") throw new Error("Expected a 30 m elevation backup collection");
    cache.backup = { products: collection ? absoluteProducts(collection, cachedPath).sort((a, b) => (tile(a) ?? "").localeCompare(tile(b) ?? "")) : [], template: collection };
  }
  const state = cache.backup;
  if (state.template) await validateDemProducts({ ...state.template, products: state.products.filter(product => tileIntersectsCoverage(tile(product), geometry)) }, cachedPath, cache.verifiedProducts);
  return { state, cachedPath };
}

export async function elevationFor(unit: CoverageUnit, cacheRoot: string, preparationRoot: string, offline: boolean, cache = elevationCache(), samplerCollectionPath?: string, onBackup?: (tile: string | null) => Promise<void>): Promise<{ sampler: ElevationSampler; source: SourceSnapshot; productFingerprint: string; fingerprintForGeometry: (coordinates: readonly Coordinate[]) => string; limitations: string[] }> {
  const { state, cachedPath } = await canonicalFor(unit, cacheRoot, preparationRoot, cache);
  const backup = await backupFor(unit.geometry, preparationRoot, cache);
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
      if (product) state.products = [...state.products, product];
    }
  }
  // Tile ownership makes sampling independent of array order. Keep the saved
  // collection and content identity canonical as well, across request orders.
  const selected = state.products = [...state.products].sort((a, b) => (tile(a) ?? "").localeCompare(tile(b) ?? "") || a.productId.localeCompare(b.productId));
  const missing = missingDemTiles(unit, selected);
  if (!state.template || missing.length) throw new Error(`3DEP products do not cover required one-degree tiles: ${missing.join(", ")}`);
  const collection: ThreeDepCollection = { ...state.template, products: selected };
  await writeJsonAtomically(cachedPath, collection);
  const described = describeInitialized(unit.geometry, cachedPath, state, backup.state);
  if (!described) throw new Error("No canonical DEM product covers this installation unit");
  const required = selected.filter(product => tileIntersectsCoverage(tile(product), unit.geometry));
  if (samplerCollectionPath) await writeJsonAtomically(samplerCollectionPath, {...collection, products:required});
  const primary = new UvRasterioThreeDepElevationSampler(samplerCollectionPath ?? cachedPath, { tileOwnership: true });
  const describe = () => describeInitialized(unit.geometry, cachedPath, state, backup.state)!;
  let fingerprintProducts: readonly Product[] | undefined, relevantProducts: Product[] = [];
  let fingerprint = geometryElevationFingerprint(required);
  const relevantBackup = () => {
    if (fingerprintProducts !== backup.state.products) {
      relevantProducts = backup.state.products.filter(product => tileIntersectsCoverage(tile(product), unit.geometry));
      fingerprint = geometryElevationFingerprint(required, relevantProducts);
      fingerprintProducts = backup.state.products;
    }
    return relevantProducts;
  };
  const backupSamplePath = samplerCollectionPath ? `${samplerCollectionPath}.backup.json` : path.join(preparationRoot, "dem", "backup", "sample-dem.json");
  const sampler: ElevationSampler = {
    algorithmVersion: primary.algorithmVersion,
    async sample(coordinates) {
      const values = await primary.sample(coordinates);
      const missing = values.flatMap((value, index) => value === null ? [index] : []);
      if (!missing.length) return values;
      const owners = [...new Set(missing.map(index => owner(coordinates[index]!)))].sort();
      for (const key of owners) {
        if (backup.state.products.some(product => tile(product) === key)) continue;
        if (offline) throw new Error(`The 10 m elevation raster has NoData in tile ${key}, and no verified cached 30 m backup is available. Build online once to acquire the backup.`);
        const [west, south] = key.split(",").map(Number);
        await onBackup?.(key);
        try {
          const downloaded = await refreshThreeDepCollection({
            cacheRoot, collectionRoot: path.join(preparationRoot, "dem", "backup", "acquired"),
            query: { endpoint: "https://tnmaccess.nationalmap.gov/api/v1/products", dataset: "National Elevation Dataset (NED) 1 arc-second",
              bbox: [west!, south!, west! + 1, south! + 1], productExtent: "1 x 1 degree",
              nominalTile: `${south! + 1 >= 0 ? "n" : "s"}${Math.abs(south! + 1)}${west! >= 0 ? "e" : "w"}${Math.abs(west!)}` },
            catalogId: "USGS:35f9c4d4-b113-4c8d-8691-47c428c29a5b", resolution: "1 arc-second (nominal 30 m)", latestOnly: true,
          });
          if (downloaded.collection.resolution !== "1 arc-second (nominal 30 m)") throw new Error("Expected a 30 m elevation backup collection");
          await validateDemProducts(downloaded.collection, downloaded.collectionPath, cache.verifiedProducts);
          const product = absoluteProducts(downloaded.collection, downloaded.collectionPath).find(product => tile(product) === key);
          if (!product) throw new Error(`No 30 m elevation backup covers tile ${key}`);
          backup.state.template ??= downloaded.collection;
          backup.state.products = [...backup.state.products, product].sort((a, b) => (tile(a) ?? "").localeCompare(tile(b) ?? ""));
          await writeJsonAtomically(backup.cachedPath, { ...backup.state.template, products: backup.state.products });
        } finally { await onBackup?.(null); }
      }
      const collection = { ...backup.state.template!, products: backup.state.products.filter(product => owners.includes(tile(product) ?? "")) };
      await writeJsonAtomically(backupSamplePath, collection);
      const samples = await new UvRasterioThreeDepElevationSampler(backupSamplePath, { tileOwnership: true })
        .sample(missing.map(index => coordinates[index]!));
      missing.forEach((index, at) => { values[index] = samples[at]!; });
      return values;
    },
  };
  return {
    sampler,
    get source() { return describe().source; },
    get productFingerprint() { return describe().productFingerprint; },
    get limitations() { return relevantBackup().length ? [BACKUP_LIMITATION] : []; },
    fingerprintForGeometry: coordinates => {
      relevantBackup();
      return fingerprint(coordinates);
    },
  };
}

function describeInitialized(geometry: AreaGeometry, cachedPath: string, state: Inventory, backup?: Inventory): {source:SourceSnapshot;productFingerprint:string}|null {
  const selected = state.products;
  if (!selected.length || !state.template) return null;
  const identity = (products: readonly Product[]) => `sha256:${createHash("sha256").update(JSON.stringify(products.map((p) => [tile(p), p.productId, p.receipt.sha256]))).digest("hex")}` as const;

  const relevant = new Set<string>();
  const [west, south, east, north] = areaBounds(geometry);
  for (let y = Math.floor(south); y < Math.ceil(north); y++) for (let x = Math.floor(west); x < Math.ceil(east); x++) {
    if (intersectCoverage(geometry, rectangle([x, y, x + 1, y + 1]))) relevant.add(`${x},${y}`);
  }
  const relevantProducts = selected.filter((product) => relevant.has(tile(product) ?? ""));
  if (!relevantProducts.length) return null;
  const backupProducts = backup?.products.filter(product => relevant.has(tile(product) ?? "")) ?? [];
  const primaryFingerprint = identity(relevantProducts);
  const productFingerprint = backupProducts.length
    ? `sha256:${createHash("sha256").update(JSON.stringify([BACKUP_POLICY, primaryFingerprint, identity(backupProducts)])).digest("hex")}` as const
    : primaryFingerprint;
  const hash = productFingerprint;
  const collection = state.template;
  const retrievedAt = [...relevantProducts, ...backupProducts].map((product) => product.receipt.retrievedAt).sort().at(-1)!;
  const endpoint = new URL(collection.queryUrl);
  endpoint.search = "";
  endpoint.hash = "";
  const source: SourceSnapshot = {
    id: `usgs-dem-${hash.slice(7, 23)}`, authority: collection.authority, dataset: backupProducts.length ? "USGS 3DEP 1/3 arc-second (10 m), with 1 arc-second (30 m) NoData backup" : collection.dataset,
    version: hash, retrievedAt, url: endpoint.toString(),
    license: collection.license, contentHash: hash, localPath: cachedPath,
  };
  return { source, productFingerprint };
}

/** Describe already verified products without downloading DEM for water or empty graph areas. */
export async function describeCanonicalElevation(geometry: AreaGeometry, cacheRoot: string, preparationRoot: string, cache = elevationCache()): Promise<{source:SourceSnapshot;productFingerprint:string}|null> {
  const { state, cachedPath } = await canonicalFor({ id: "description", geometry, status: "pending" }, cacheRoot, preparationRoot, cache);
  state.products = [...state.products].sort((a, b) => (tile(a) ?? "").localeCompare(tile(b) ?? "") || a.productId.localeCompare(b.productId));
  if (missingDemTiles({id:"description",geometry,status:"pending"}, state.products).length) return null;
  const backup = await backupFor(geometry, preparationRoot, cache);
  const described = describeInitialized(geometry, cachedPath, state, backup.state);
  if (described) await writeJsonAtomically(cachedPath, { ...state.template!, products: state.products });
  return described;
}

/** The sampler's WarpedVRT interpolates within one owned raster, never across files.
 * Use the actual metric sample coordinates and the same [west,east), (south,north]
 * ownership as tools/dem/sample_dem.py; an intermediate crossed tile also matters.
 */
export function geometryElevationFingerprint(products: readonly Product[], backup: readonly Product[] = []): (coordinates: readonly Coordinate[]) => string {
  const byTile = new Map(products.map(product => [tile(product), product]));
  const backupByTile = new Map(backup.map(product => [tile(product), product]));
  const fingerprints = new Map<string, string>();
  return coordinates => {
    const owners = [...new Set(densifyGeometry(coordinates).map(owner))].sort();
    const key = owners.join(";");
    const previous = fingerprints.get(key);
    if (previous) return previous;
    const inputs = owners.map(owner => {
      const product = byTile.get(owner);
      if (!product) throw new Error(`Missing elevation tile for a metric sample: ${owner}`);
      return [owner, product.productId, product.receipt.sha256];
    });
    const backups = owners.flatMap(owner => { const product = backupByTile.get(owner); return product ? [[owner, product.productId, product.receipt.sha256]] : []; });
    const fingerprint = `sha256:${createHash("sha256").update(JSON.stringify(backups.length ? [BACKUP_POLICY, inputs, backups] : inputs)).digest("hex")}`;
    fingerprints.set(key, fingerprint);
    return fingerprint;
  };
}
