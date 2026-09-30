import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { inspectPinnedOsmSnapshot, readPinnedOsmSnapshot, refreshPinnedOsmSnapshot, type OsmSourceConfig } from "../osm/source";
import { readPinnedOfficialTrailSnapshot, refreshPinnedOfficialTrailSnapshot, type OfficialTrailSourceConfig } from "../official-trails/source";
import { readPinnedThreeDepCollection, type ElevationSourceConfig } from "../elevation/source";
import { refreshThreeDepCollection } from "../elevation/collection";
import { readOrAcquireSource, resolveSourcePath } from "./cache";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function root() { const value = await mkdtemp(path.join(tmpdir(), "alpine-portable-")); roots.push(value); return value; }
const bytes = Buffer.from("committed-fixture-source");
const hash = `sha256:${createHash("sha256").update(bytes).digest("hex")}` as const;
const fetchFile = async () => new Response(bytes);

it("reuses OSM and official trail receipts after moving a cache, including legacy absolute pointers", async () => {
  const directory = await root();
  const cacheRoot = path.join(directory, "before");
  const osm: OsmSourceConfig = { schemaVersion: 1, id: "osm-fixture", authority: "Fixture", dataset: "OSM",
    version: "v1", upstreamTimestamp: "2026-01-01T00:00:00Z", url: "https://fixtures.invalid/osm.pbf",
    expectedByteLength: bytes.length, license: "CC0", attribution: "Fixture" };
  const official: OfficialTrailSourceConfig = { ...osm, kind: "usgs-national-digital-trails", id: "official-fixture",
    expectedSha256: hash, url: "https://fixtures.invalid/trails.geojson" };
  const original = await refreshPinnedOsmSnapshot(cacheRoot, osm, fetchFile);
  await refreshPinnedOfficialTrailSnapshot(cacheRoot, official, fetchFile);
  // Old pointers also embedded the absolute locations. The receipt is sufficient.
  await writeFile(path.join(cacheRoot, osm.id, "pinned.json"), JSON.stringify({ configVersion: osm.version, cached: original.cached }));
  const moved = path.join(directory, "after");
  await rename(cacheRoot, moved);
  for (const source of [await readPinnedOsmSnapshot(moved, osm), await readPinnedOfficialTrailSnapshot(moved, official)]) {
    expect(source.localPath.startsWith(moved)).toBe(true);
    expect(await readFile(source.localPath)).toEqual(bytes);
  }
  const source = await readPinnedOsmSnapshot(moved, osm);
  const revised = { ...osm, version: "v2", url: "https://fixtures.invalid/new-osm.pbf" };
  const refreshed = await refreshPinnedOsmSnapshot(moved, revised, fetchFile);
  expect(refreshed.cached.reused).toBe(true);
  expect(refreshed.snapshot.contentHash).toBe(source.contentHash);
  expect((await readPinnedOsmSnapshot(moved, revised)).url).toBe(revised.url);
  await writeFile(source.localPath, "corrupt");
  await expect(readPinnedOsmSnapshot(moved, revised)).rejects.toThrow("integrity");
});

it("keeps DEM build identity stable across roots and retrieval dates while validating actual tiles", async () => {
  const directory = await root();
  const config: ElevationSourceConfig = { schemaVersion: 1, id: "usgs-3dep-13-arc-second", cacheNamespace: "fixture-elevation",
    authority: "U.S. Geological Survey", dataset: "DEM", catalogId: "fixture", version: "v1",
    endpoint: "https://fixtures.invalid/products", bbox: [0, 0, 1, 1], productExtent: "1 x 1 degree",
    expectedProductIds: ["tile"], resolution: "1/3 arc-second (nominal 10 m)", horizontalDatum: "NAD83", verticalDatum: "NAVD88", license: "CC0" };
  const catalog = { items: [{ sourceId: "tile", title: "Tile", downloadURL: "https://fixtures.invalid/tile.tif", sizeInBytes: 9999 }] };
  const snapshots = [];
  for (const [index, retrievedAt] of ["2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z"].entries()) {
    const cacheRoot = path.join(directory, String(index));
    const built = await refreshThreeDepCollection({ cacheRoot, collectionRoot: path.join(cacheRoot, config.cacheNamespace!, "collections"),
      query: { ...config }, catalogId: config.catalogId, retrievedAt,
      fetchImpl: async (url) => String(url).includes("/products") ? Response.json(catalog) : new Response(bytes) });
    // One old absolute pointer and one new relative pointer; both survive relocation.
    await writeFile(path.join(cacheRoot, config.cacheNamespace!, "pinned.json"), JSON.stringify({ configVersion: "v1",
      collectionPath: index === 0 ? built.collectionPath : path.relative(cacheRoot, built.collectionPath) }));
    const moved = path.join(directory, `moved-${index}`);
    await rename(cacheRoot, moved);
    const result = await readPinnedThreeDepCollection(moved, config);
    expect(result.collection.products[0]!.receipt.byteLength).toBe(bytes.length);
    expect(result.collectionPath.startsWith(moved)).toBe(true);
    snapshots.push(result);
  }
  expect(snapshots[0]!.snapshot.contentHash).not.toBe(snapshots[1]!.snapshot.contentHash);
  expect(snapshots[0]!.buildFingerprint).toBe(snapshots[1]!.buildFingerprint);
  const last = snapshots[1]!;
  const tile = last.collection.products[0]!;
  const tilePath = path.resolve(path.dirname(last.collectionPath), tile.filePath);
  const revisedBytes = Buffer.from("revised-valid-tile");
  await writeFile(tilePath, revisedBytes);
  tile.receipt.byteLength = revisedBytes.length;
  tile.receipt.sha256 = `sha256:${createHash("sha256").update(revisedBytes).digest("hex")}`;
  await writeFile(last.collectionPath, JSON.stringify(last.collection));
  const revised = await readPinnedThreeDepCollection(path.join(directory, "moved-1"), config);
  expect(revised.buildFingerprint).not.toBe(last.buildFingerprint);
  // Overlapping tiles use collection order, so reordering must invalidate reuse.
  last.collection.products.push({ ...tile, productId: "overlapping-tile" });
  const overlapping = { ...config, expectedProductIds: ["tile", "overlapping-tile"] };
  await writeFile(last.collectionPath, JSON.stringify(last.collection));
  const ordered = await readPinnedThreeDepCollection(path.join(directory, "moved-1"), overlapping);
  last.collection.products.reverse();
  await writeFile(last.collectionPath, JSON.stringify(last.collection));
  expect((await readPinnedThreeDepCollection(path.join(directory, "moved-1"), overlapping)).buildFingerprint)
    .not.toBe(ordered.buildFingerprint);
  await writeFile(tilePath, "corrupt");
  await expect(readPinnedThreeDepCollection(path.join(directory, "moved-1"), overlapping)).rejects.toThrow("integrity");
});

it("resolves relocated legacy authority paths and rejects escape paths", async () => {
  const directory = await root();
  await mkdir(path.join(directory, "source"), { recursive: true });
  expect(resolveSourcePath(directory, "/app/.cache/sources/source/hash/file.json", "source"))
    .toBe(path.join(directory, "source/hash/file.json"));
  expect(() => resolveSourcePath(directory, "../secret", "source")).toThrow("escapes");
});

it("uses pins without acquisition by default, acquires missing pins, and honors explicit offline/refresh modes", async () => {
  const read = vi.fn(async () => "cached");
  const acquire = vi.fn(async () => "acquired");
  expect(await readOrAcquireSource(undefined, read, acquire)).toBe("cached");
  expect(acquire).not.toHaveBeenCalled();
  expect(await readOrAcquireSource(true, read, acquire)).toBe("acquired");
  expect(read).toHaveBeenCalledTimes(1);
  read.mockRejectedValue(new Error("Missing pin"));
  expect(await readOrAcquireSource(undefined, read, acquire)).toBe("acquired");
  await expect(readOrAcquireSource(false, read, acquire)).rejects.toThrow("Missing pin");
  expect(acquire).toHaveBeenCalledTimes(2);
});


it("inspects OSM availability without treating matching metadata as verified content", async () => {
  const cacheRoot = await root();
  const config: OsmSourceConfig = { schemaVersion: 1, id: "osm-fixture", authority: "Fixture", dataset: "OSM",
    version: "v1", upstreamTimestamp: "2026-01-01T00:00:00Z", url: "https://fixtures.invalid/osm.pbf",
    expectedByteLength: bytes.length, license: "CC0", attribution: "Fixture" };
  const {snapshot} = await refreshPinnedOsmSnapshot(cacheRoot, config, fetchFile);
  expect(await inspectPinnedOsmSnapshot(cacheRoot, config)).toEqual(snapshot);
  for (const changed of [{version:"v2"},{url:"https://fixtures.invalid/other.pbf"},{expectedByteLength:bytes.length+1}]) {
    await expect(inspectPinnedOsmSnapshot(cacheRoot, {...config,...changed})).rejects.toThrow(/configured/);
  }
  const pointerPath = path.join(cacheRoot,config.id,"pinned.json");
  const pointerText = await readFile(pointerPath,"utf8");
  const pointer = JSON.parse(pointerText);
  pointer.cached.receipt.sourceId = "different-source";
  await writeFile(pointerPath,JSON.stringify(pointer));
  await expect(inspectPinnedOsmSnapshot(cacheRoot,config)).rejects.toThrow("configured source");
  await writeFile(pointerPath,pointerText);
  await writeFile(snapshot.localPath,Buffer.alloc(bytes.length,120));
  expect(await inspectPinnedOsmSnapshot(cacheRoot,config)).toEqual(snapshot);
  await expect(readPinnedOsmSnapshot(cacheRoot,config)).rejects.toThrow("integrity");
  await writeFile(snapshot.localPath,"short");
  await expect(inspectPinnedOsmSnapshot(cacheRoot,config)).rejects.toThrow("file size");
});
