import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { refreshThreeDepCollection, threeDepCollectionSchema } from "./collection";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

it("pins only the newest requested backup tile with its actual bytes and explicit 30 m metadata", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dem-collection-")); directories.push(root);
  const items = [
    { sourceId: "old", title: "USGS 1 Arc Second n50w122 20160101", publicationDate: "2016-01-01", downloadURL: "https://fixtures.invalid/old.tif" },
    { sourceId: "current", title: "USGS 1 Arc Second n50w122 20180202", publicationDate: "2018-02-02", downloadURL: "https://fixtures.invalid/current.tif", sizeInBytes: 54596 },
    { sourceId: "neighbor", title: "USGS 1 Arc Second n49w122 20250813", publicationDate: "2025-08-13", downloadURL: "https://fixtures.invalid/neighbor.tif" },
  ];
  const fetchImpl = vi.fn(async (url: string | URL | Request) => new Response(String(url).includes("/products?") ? JSON.stringify({ items }) : "small raster fixture"));
  const result = await refreshThreeDepCollection({
    cacheRoot: path.join(root, "cache"), collectionRoot: path.join(root, "collections"),
    query: { endpoint: "https://fixtures.invalid/products", dataset: "National Elevation Dataset (NED) 1 arc-second", bbox: [-122, 49, -121, 50], nominalTile: "n50w122" },
    catalogId: "USGS:35f9c4d4-b113-4c8d-8691-47c428c29a5b", resolution: "1 arc-second (nominal 30 m)", latestOnly: true, fetchImpl,
  });
  expect(fetchImpl.mock.calls.map(([url]) => String(url)).filter(url => url.endsWith(".tif"))).toEqual(["https://fixtures.invalid/current.tif"]);
  expect(result.collection).toMatchObject({ sourceId: "usgs-3dep-1-arc-second", resolution: "1 arc-second (nominal 30 m)", horizontalDatum: "NAD83", verticalDatum: "NAVD88" });
  expect(result.collection.products).toHaveLength(1);
  expect(result.collection.products[0]!.receipt.byteLength).toBe(Buffer.byteLength("small raster fixture"));
  expect(result.collection.products[0]!.receipt.sha256).toMatch(/^sha256:/);
  expect(JSON.parse(await readFile(result.collectionPath, "utf8"))).toEqual(result.collection);
  expect(() => threeDepCollectionSchema.parse({ ...result.collection, resolution: "1/3 arc-second (nominal 10 m)" })).toThrow("identifier and resolution disagree");
});
