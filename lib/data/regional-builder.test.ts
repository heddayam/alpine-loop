import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SourceSnapshot } from "./adapters";
import type { NormalizedTopology } from "./types";
import type { RegionalPackBuildProgress, RegionalPackDefinition } from "./regional-build-types";

// Substitute source acquisition and external tools; run the real preparation,
// compiler, SQLite writer, persisted audit, and publication path.
vi.mock("./osm", async (importOriginal) => ({
  ...await importOriginal<typeof import("./osm")>(),
  validateOsmPrerequisites: async () => undefined,
  readOsmSourceConfig: async () => ({}),
  readPinnedOsmSnapshot: async () => source("osm"),
  refreshPinnedOsmSnapshot: async () => ({ snapshot: source("osm") }),
  prepareOsmTopology: async () => topology(),
  prepareOsmBuildings: async () => [],
  OsmPbfNamedAreaAdapter: class {
    adapterVersion = "fixture-names-v1";
    async validate() {}
    async normalize() { return []; }
  },
}));
vi.mock("./elevation", () => ({
  validateUvRasterioPrerequisites: async () => undefined,
  readElevationSourceConfig: async () => ({}),
  readPinnedThreeDepCollection: async () => ({ snapshot: source("dem"), collectionPath: "/fixture/dem" }),
  refreshPinnedThreeDepCollection: async () => ({ snapshot: source("dem"), collectionPath: "/fixture/dem" }),
  UvRasterioThreeDepElevationSampler: class {
    algorithmVersion = "fixture-elevation-v1";
    async sample(coordinates: ReadonlyArray<readonly [number, number]>) {
      return coordinates.map(([, lat]) => 100 + (lat - 37) * 1_000);
    }
  },
}));

import { createRegionalPackBuilder, parseRegionalBoundary, regionalDataVersion, REGIONAL_PACK_BUILD_PHASES } from "./regional-builder";

function source(id: string): SourceSnapshot {
  return { id, authority: "Fixture", dataset: id, version: "v1", license: "CC0-1.0",
    retrievedAt: "2026-01-01T00:00:00Z", url: `https://example.invalid/${id}`,
    contentHash: `sha256:${"a".repeat(64)}`, localPath: `/fixture/${id}` };
}
function topology(): NormalizedTopology {
  const nodes = [[-122.099, 37.002], [-122.095, 37.002], [-122.095, 37.006], [-122.099, 37.001]]
    .map(([lon, lat], index) => ({ id: String(index), externalId: `node/${index}`, lon: lon!, lat: lat!,
      elevationM: null, flags: [], sourceRefs: ["osm"] }));
  const way = (externalId: string, indexes: number[], edgeClass: "trail" | "street") => ({
    id: externalId, externalId, nodeIds: indexes.map(String), name: "Fixture trail", edgeClass,
    coordinates: indexes.map((index) => [nodes[index]!.lon, nodes[index]!.lat] as const),
    bidirectional: true, accessState: "unknown" as const, sourceRefs: ["osm"], flags: [],
  });
  return { nodes, ways: [way("way/1", [0, 1, 2, 0], "trail"), way("way/2", [3, 0], "street")],
    accessPoints: [], portalEvidence: [], rejectedWayCount: 0 };
}

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "alpine-regional-builder-"));
  roots.push(root);
  const config: RegionalPackDefinition = { id: "test-region", name: "Test Region", dataVersionPrefix: "test",
    compilerVersion: "test-v1", boundaryVersion: "v1", regionRoot: root, display: { center: [-122.095, 37.005], zoom: 12 } };
  await writeFile(path.join(root, "boundary.geojson"), JSON.stringify({ type: "Feature",
    properties: { id: config.id, boundaryVersion: "v1" },
    geometry: { type: "Polygon", coordinates: [[[-122.1, 37], [-122.09, 37], [-122.09, 37.01], [-122.1, 37.01], [-122.1, 37]]] },
  }));
  await writeFile(path.join(root, "search-regions.json"), JSON.stringify({ version: 1,
    regions: [{ namedAreaId: "pack:test-region", expectedName: config.name }] }));
  return { config, options: { outputRoot: path.join(root, "packs"), sourceCacheRoot: root, preparationRoot: root, refresh: false } };
}

describe("shared regional builder", () => {
  it("rejects mismatched regional identity, boundary versions, and invalid geometry", async () => {
    const { config } = await fixture();
    const boundary = JSON.parse(await readFile(path.join(config.regionRoot, "boundary.geojson"), "utf8"));
    for (const properties of [{ id: "other", boundaryVersion: "v1" }, { id: config.id, boundaryVersion: "v2" }]) {
      expect(() => parseRegionalBoundary(config, JSON.stringify({ ...boundary, properties }))).toThrow("identity or version");
    }
    expect(() => parseRegionalBoundary(config, JSON.stringify({ ...boundary, geometry: { type: "Polygon", coordinates: [] } })))
      .toThrow();
  });

  it("publishes an audited real artifact, retains progress, and reuses the same pinned identity", async () => {
    const { config, options } = await fixture();
    const progress: RegionalPackBuildProgress[] = [];
    const first = await createRegionalPackBuilder(config)({ ...options, onProgress: (value) => progress.push(value) });
    expect(first.regionalAudit.errors).toEqual([]);
    expect(first.portalAudit).toMatchObject({ schemaVersion: "2", portals: { total: 1 },
      buildContext: { inputWayCount: 2, publishedWayCount: 1, strippedWayCount: 1 } });
    const phases = progress.filter(({ detail }) => !detail);
    expect(phases.map(({ label }) => label)).toEqual([...REGIONAL_PACK_BUILD_PHASES]);
    expect(phases.every(({ phase, phaseCount }, index) => phase === index + 1 && phaseCount === phases.length)).toBe(true);
    expect(progress.some(({ phase, detail }) => phase === 8 && detail)).toBe(true);
    const database = new DatabaseSync(first.pack.databasePath, { readOnly: true });
    try {
      expect(database.prepare("SELECT DISTINCT edge_class FROM edges").all()).toEqual([{ edge_class: "trail" }]);
      expect(database.prepare("SELECT COUNT(*) AS count FROM access_points").get()).toEqual({ count: 1 });
    } finally { database.close(); }
    expect(JSON.parse(await readFile(path.join(first.pack.packDirectory, "portal-audit.json"), "utf8"))).toEqual(first.portalAudit);
    const secondProgress: RegionalPackBuildProgress[] = [];
    const second = await createRegionalPackBuilder(config)({ ...options, refresh: true, onProgress: (value) => secondProgress.push(value) });
    expect(second.pack.reusedExisting).toBe(true);
    expect(second.pack.packDirectory).toBe(first.pack.packDirectory);
    expect(secondProgress[1]!.label).toBe("Refresh pinned source snapshots");
  });

  it("rejects regional acceptance before publication and retains the prior artifact", async () => {
    const { config, options } = await fixture();
    const first = await createRegionalPackBuilder(config)(options);
    const pointerPath = path.join(options.outputRoot, config.id, "current.json");
    const pointer = await readFile(pointerPath, "utf8");
    const rejected = createRegionalPackBuilder({ ...config, compilerVersion: "rejected-v2",
      checkPortals: () => { throw new Error("Required corridor has no trailheads"); } });
    await expect(rejected(options)).rejects.toThrow("Required corridor has no trailheads");
    expect(await readFile(pointerPath, "utf8")).toBe(pointer);
    await expect(readFile(first.pack.manifestPath, "utf8")).resolves.toContain(config.id);
  });

  it("pins restrictions and applies them before entrance labels", async () => {
    const { config, options } = await fixture();
    const metadata = Object.fromEntries(Object.entries(source("reviewed-restrictions"))
      .filter(([key]) => key !== "contentHash" && key !== "localPath"));
    const contents = JSON.stringify({ schemaVersion: 1, source: metadata, restrictions: [{ externalId: "way/1",
      accessState: "closed", reason: "Fixture closure", review: { reviewedAt: metadata.retrievedAt, reviewer: "Fixture" } }] });
    await writeFile(path.join(config.regionRoot, "access-restrictions.json"), contents);
    const contentHash = `sha256:${createHash("sha256").update(contents).digest("hex")}` as const;
    const checkPortals = vi.fn((prepared: NormalizedTopology) => {
      expect(prepared.accessPoints[0]).toMatchObject({ name: "Reviewed name", accessState: "closed" });
      throw new Error("Closed fixture intentionally stops before compile");
    });
    const build = createRegionalPackBuilder({ ...config, restrictions: { contentHash }, checkPortals,
      entrances: async () => ({ snapshot: source("entrances"), adapterVersion: "entrances-v1", evidence: [{
        sourceId: "entrances", externalId: "entrance/1", name: "Reviewed name", lon: -122.099, lat: 37.002,
        accessState: "public", confidence: "high",
      }] }),
    });
    await expect(build(options)).rejects.toThrow("Closed fixture intentionally stops before compile");
    expect(checkPortals).toHaveBeenCalledOnce();
    await writeFile(path.join(config.regionRoot, "access-restrictions.json"), `${contents}\n`);
    await expect(build(options)).rejects.toThrow("Content hash mismatch");
    expect(checkPortals).toHaveBeenCalledOnce();
  });

  it("hashes each input dimension and ignores source/adapter ordering in the current format", async () => {
    const { config } = await fixture();
    const version = (snapshots = [source("a"), source("b")], adapters = ["b", "a"], metrics = ["y", "x"], boundary = "boundary", regions = "regions", definition = config) =>
      regionalDataVersion(definition, boundary, regions, snapshots, adapters, metrics);
    const original = version();
    expect(version([source("b"), source("a")], ["a", "b"], ["x", "y"])).toBe(original);
    for (const changed of [version([source("a")]), version(undefined, ["different"]), version(undefined, undefined, ["different"]),
      version(undefined, undefined, undefined, "changed"), version(undefined, undefined, undefined, undefined, "changed"),
      version(undefined, undefined, undefined, undefined, undefined, { ...config, compilerVersion: "v2" })]) {
      expect(changed).not.toBe(original);
    }
  });
});
