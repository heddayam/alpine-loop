import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { CoverageUnit } from "./types";
import type { ThreeDepCollection } from "@/lib/data/elevation/collection";
import { rectangle } from "./geometry";
import { describeCanonicalElevation, elevationCache, elevationFor, missingDemTiles, validateDemProducts } from "./elevation";

const refresh = vi.hoisted(() => vi.fn());
vi.mock("@/lib/data/elevation/collection", async (original) => ({
  ...await original<typeof import("@/lib/data/elevation/collection")>(),
  refreshThreeDepCollection: refresh,
}));
const dirs: string[] = [];
afterEach(async () => { refresh.mockReset(); await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

const unit: CoverageUnit = {
  id: "cross-tile", geometry: rectangle([-121.8, 47.8, -121.2, 48.2]), status: "pending",
};
function product(id: string, title: string, filePath: string, bytes: Buffer): ThreeDepCollection["products"][number] {
  const hash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  return {
    productId: id, title, publicationDate: "2026-01-01", filePath,
    receipt: {
      schemaVersion: 1, sourceId: `usgs-3dep-${id}`, originalUrl: `https://example.invalid/${id}.tif`,
      resolvedUrl: `https://example.invalid/${id}.tif`, retrievedAt: "2026-09-24T00:00:00.000Z",
      byteLength: bytes.length, sha256: hash, fileName: `${id}.tif`,
    },
  };
}
function collection(products: ThreeDepCollection["products"]): ThreeDepCollection {
  return {
    schemaVersion: 1, sourceId: "usgs-3dep-13-arc-second", authority: "U.S. Geological Survey",
    dataset: "National Elevation Dataset (NED) 1/3 arc-second", catalogId: "fixture",
    resolution: "1/3 arc-second (nominal 10 m)", horizontalDatum: "NAD83", verticalDatum: "NAVD88",
    retrievedAt: "2026-09-24T00:00:00.000Z", queryUrl: "https://example.invalid/query",
    license: "U.S. public domain", products,
  };
}
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "coverage-dem-")); dirs.push(root);
  const cacheRoot = path.join(root, "cache"), preparationRoot = path.join(root, "prep");
  const directory = path.join(preparationRoot, "dem", "canonical");
  await mkdir(directory, { recursive: true });
  const one = Buffer.from("one"), two = Buffer.from("two");
  const firstPath = path.join(directory, "one.tif"), secondPath = path.join(directory, "two.tif");
  await writeFile(firstPath, one); await writeFile(secondPath, two);
  const first = product("one", "USGS 1/3 Arc Second n48w122 20260101", "one.tif", one);
  const second = product("two", "USGS 1/3 Arc Second n49w122 20260101", "two.tif", two);
  const cachedPath = path.join(directory, "collection.json");
  await writeFile(cachedPath, JSON.stringify(collection([first])));
  return { cacheRoot, preparationRoot, cachedPath, first, second, firstPath, secondPath };
}

it("tests the entire unit geometry against one-degree DEM tiles", () => {
  const bytes = Buffer.from("tile");
  const first = product("one", "USGS 1/3 Arc Second n48w122 20260101", "one.tif", bytes);
  const second = product("two", "USGS 1/3 Arc Second n49w122 20260101", "two.tif", bytes);
  expect(missingDemTiles(unit, [first])).toEqual(["-122,48"]);
  expect(missingDemTiles(unit, [first, second])).toEqual([]);
});

it("rejects a cached raster whose bytes no longer match its receipt", async () => {
  const value = await fixture();
  await writeFile(value.firstPath, "tampered");
  await expect(validateDemProducts(collection([value.first]), value.cachedPath)).rejects.toThrow(/integrity validation/);
  await expect(elevationFor(unit, value.cacheRoot, value.preparationRoot, true)).rejects.toThrow(/verified cached elevation/);
});

it("acquires missing tiles when a verified saved collection overlaps only part of the unit", async () => {
  const value = await fixture();
  await expect(elevationFor(unit, value.cacheRoot, value.preparationRoot, true)).rejects.toThrow(/entire area/);
  refresh.mockResolvedValue({ collection: collection([{ ...value.second, filePath: "two.tif" }]), collectionPath: value.cachedPath });
  const result = await elevationFor(unit, value.cacheRoot, value.preparationRoot, false);
  expect(refresh).toHaveBeenCalledOnce();
  expect(refresh.mock.calls[0]?.[0]?.query.bbox).toEqual([-122, 48, -121, 49]);
  const saved = JSON.parse(await readFile(value.cachedPath, "utf8")) as ThreeDepCollection;
  expect(saved.products.map(({ productId }) => productId)).toEqual(["one", "two"]);
  expect(result.source.contentHash).toBe(result.source.version);
  expect(result.productFingerprint).toMatch(/^sha256:/);
});

it("keeps the same DEM priority and unit fingerprint when a new tile is appended", async () => {
  const value = await fixture();
  const cache = elevationCache();
  const south = { ...unit, geometry: rectangle([-121.8,47.8,-121.2,47.9]) };
  const north = { ...unit, geometry: rectangle([-121.8,48.1,-121.2,48.2]) };
  const before = await elevationFor(south, value.cacheRoot, value.preparationRoot, true, cache);
  refresh.mockResolvedValue({ collection: collection([{ ...value.second, filePath: "two.tif" }]), collectionPath: value.cachedPath });
  const added = await elevationFor(north, value.cacheRoot, value.preparationRoot, false, cache);
  const after = await elevationFor(south, value.cacheRoot, value.preparationRoot, true, cache);
  expect(after.productFingerprint).toBe(before.productFingerprint);
  expect(added.source.contentHash).not.toBe(before.source.contentHash);
  const saved = JSON.parse(await readFile(value.cachedPath, "utf8")) as ThreeDepCollection;
  expect(saved.products.map(({ productId }) => productId)).toEqual(["one", "two"]);
});

it("describes acquired DEM without downloading tiles for an empty area", async () => {
  const value = await fixture();
  const cache = elevationCache();
  const partial = await describeCanonicalElevation(unit.geometry, value.cacheRoot, value.preparationRoot, cache);
  expect(partial?.source.localPath).toBe(value.cachedPath);
  expect(await describeCanonicalElevation(rectangle([-120.9,47.8,-120.8,47.9]), value.cacheRoot, value.preparationRoot, cache)).toBeNull();
  expect(refresh).not.toHaveBeenCalled();
});

it("uses the same raster identity when adjacent tiles arrive in reverse order", async () => {
  const forward = await fixture();
  refresh.mockResolvedValueOnce({ collection: collection([{ ...forward.second, filePath: "two.tif" }]), collectionPath: forward.cachedPath });
  const first = await elevationFor(unit, forward.cacheRoot, forward.preparationRoot, false);
  const reverse = await fixture();
  await writeFile(reverse.cachedPath, JSON.stringify(collection([reverse.second])));
  refresh.mockResolvedValueOnce({ collection: collection([{ ...reverse.first, filePath: "one.tif" }]), collectionPath: reverse.cachedPath });
  const second = await elevationFor(unit, reverse.cacheRoot, reverse.preparationRoot, false);
  expect(second.source.contentHash).toBe(first.source.contentHash);
  expect({ ...second.source, localPath: "" }).toEqual({ ...first.source, localPath: "" });
  expect(second.productFingerprint).toBe(first.productFingerprint);
  const saved = JSON.parse(await readFile(reverse.cachedPath, "utf8")) as ThreeDepCollection;
  expect(saved.products.map(({ productId }) => productId)).toEqual(["one", "two"]);
});

const rasterPython = path.resolve("tools/dem/.venv/bin/python");
it.skipIf(!existsSync(rasterPython))("samples exact seams by north-west tile ownership, regardless of product order", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "coverage-dem-overlap-")); dirs.push(root);
  const tiles=[
    {name:"south",title:"n48w122",west:-122,north:48,value:100},
    {name:"north",title:"n49w122",west:-122,north:49,value:200},
    {name:"west",title:"n48w123",west:-123,north:48,value:300},
    {name:"equator",title:"n00w122",west:-122,north:0,value:400},
    {name:"negative",title:"s01w122",west:-122,north:-1,value:500},
  ];
  execFileSync(rasterPython, ["-c", `
import sys, json
import numpy as np
import rasterio
from rasterio.transform import from_bounds
for tile in json.loads(sys.argv[2]):
    west, north = tile["west"], tile["north"]
    with rasterio.open(f"{sys.argv[1]}/{tile['name']}.tif", "w", driver="GTiff", width=40, height=40, count=1,
                       dtype="float32", crs="EPSG:4326", transform=from_bounds(west - .1, north - 1.1, west + 1.1, north + .1, 40, 40)) as output:
        output.write(np.full((40, 40), tile["value"], dtype="float32"), 1)
`, root, JSON.stringify(tiles)]);
  const products=tiles.map(tile=>({title:`USGS 1/3 Arc Second ${tile.title} 20260101`,filePath:`${tile.name}.tif`}));
  const points="-121.9 47.9\n-121.9 48.1\n-121.9 48\n-121.9 49\n-122.000001 47.9\n-122 47.9\n-121.9 0\n-121.9 -1\n-121.9 -0.999999\n-121.9 -1.000001\n";
  const file=path.join(root,"collection.json");
  const sample=(input:string)=>execFileSync(rasterPython,[path.resolve("tools/dem/sample_dem.py"),"--collection",file,"--tile-owner"],{input,encoding:"utf8"}).trim().split("\n");
  for (const ordered of [products,[...products].reverse()]) {
    await writeFile(file,JSON.stringify({products:ordered}));
    expect(sample(points).map(Number)).toEqual([100,200,100,200,300,100,400,500,400,500]);
  }
  // The n49 tile owns latitude49; its overlap at latitude48 cannot replace n48.
  await writeFile(file,JSON.stringify({products:[products[1]]}));
  expect(sample("-121.9 48\n-121.9 49\n")).toEqual(["nan","200.000000"]);
});
