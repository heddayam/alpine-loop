import { DatabaseSync } from "node:sqlite";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { packManifestV1Schema, packManifestV2Schema, packManifestV3Schema, packManifestV4Schema } from "@/lib/contracts";
import { compilePack } from "./compiler";
import type { AreaGeometry } from "./area-geometry";
import { getNamedArea, listSearchRegions, searchNamedAreas } from "./named-area-catalog";
import {
  fixtureCompileOptions,
  fixtureCompileOptionsV2,
  fixtureCompileOptionsV3,
  fixtureCompileOptionsV4,
  fixturePackSeed,
  fixturePackSeedV2,
} from "./fixture-pack";

const temporaryDirectories: string[] = [];

async function temporaryOutput(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "alpine-pack-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("fixture pack compiler", () => {
  it("accepts a prepared topology with attributed additional sources and no live official adapter", async () => {
    const outputRoot = await temporaryOutput();
    const options = await fixtureCompileOptions(outputRoot);
    const { officialAccess, ...withoutOfficialAdapter } = options;
    const result = await compilePack({
      ...withoutOfficialAdapter,
      additionalSources: officialAccess ? [officialAccess.snapshot] : [],
    });
    expect(result.audit.sourceCount).toBe(3);
    const manifest = packManifestV1Schema.parse(JSON.parse(await readFile(result.manifestPath, "utf8")));
    expect(manifest.sources.map(({ id }) => id)).toContain("fixture-official-access");
  });

  it("writes a validated manifest, audit, runtime tables, indexes, and records", async () => {
    const outputRoot = await temporaryOutput();
    const result = await compilePack(await fixtureCompileOptions(outputRoot));
    const manifest = packManifestV1Schema.parse(JSON.parse(await readFile(result.manifestPath, "utf8")));
    const current = JSON.parse(await readFile(path.join(outputRoot, "fixture-pack", "current.json"), "utf8")) as {
      dataVersion: string;
    };

    expect(result.reusedExisting).toBe(false);
    expect(manifest).toMatchObject({
      id: "fixture-pack",
      dataVersion: "fixture-v1",
      metricAlgorithmVersion: "nearest-fixture-v1+metrics-v3",
      capabilities: { elevation: true, officialAccess: true },
    });
    expect(manifest.sources).toHaveLength(3);
    expect(current.dataVersion).toBe("fixture-v1");
    expect(result.audit).toMatchObject({
      nodeCount: 7,
      directedEdgeCount: 17,
      accessPointCount: 2,
      sourceCount: 3,
      rejectedWayCount: 1,
      conflictCount: 0,
      missingElevationNodeCount: 0,
      missingElevationEdgeCount: 0,
      accessStateCounts: { public: 15, unknown: 2, private: 0, closed: 0, prohibited: 0 },
    });

    const database = new DatabaseSync(result.databasePath, { readOnly: true });
    try {
      const tables = database.prepare(
        "SELECT name FROM sqlite_master WHERE type IN ('table', 'view') ORDER BY name",
      ).all().map((row) => (row as { name: string }).name);
      expect(tables).toEqual(expect.arrayContaining([
        "nodes", "node_spatial", "edges", "edge_spatial", "access_points",
        "sources", "metadata", "schema_migrations",
      ]));
      expect(database.prepare("SELECT count(*) AS count FROM nodes").get()).toEqual({ count: 7 });
      expect(database.prepare("SELECT count(*) AS count FROM edges").get()).toEqual({ count: 17 });
      expect(database.prepare("SELECT count(*) AS count FROM node_spatial").get()).toEqual({ count: 7 });
      expect(database.prepare("SELECT count(*) AS count FROM edge_spatial").get()).toEqual({ count: 17 });
      expect(database.prepare("SELECT access_state FROM edges WHERE id = 'w-ridge:0:forward'").get())
        .toEqual({ access_state: "public" });
      const forward = database.prepare(
        "SELECT gain_m, loss_m FROM edges WHERE id = 'w-ridge:0:forward'",
      ).get() as { gain_m: number; loss_m: number };
      const reverse = database.prepare(
        "SELECT gain_m, loss_m FROM edges WHERE id = 'w-ridge:0:reverse'",
      ).get() as { gain_m: number; loss_m: number };
      expect(forward.gain_m).toBe(reverse.loss_m);
      expect(forward.loss_m).toBe(reverse.gain_m);
    } finally {
      database.close();
    }

    const resumed = await compilePack(await fixtureCompileOptions(outputRoot));
    expect(resumed.reusedExisting).toBe(true);
    expect(resumed.packDirectory).toBe(result.packDirectory);
  });

  it("does not replace the current valid pack when a later build fails", async () => {
    const outputRoot = await temporaryOutput();
    await compilePack(await fixtureCompileOptions(outputRoot));
    const pointerPath = path.join(outputRoot, "fixture-pack", "current.json");
    const originalPointer = await readFile(pointerPath, "utf8");
    const failingOptions = await fixtureCompileOptions(outputRoot, undefined, {
      seed: { ...fixturePackSeed, dataVersion: "fixture-v2" },
      builtAt: "2026-08-04T01:00:00Z",
      beforePublish: () => { throw new Error("injected failure"); },
    });

    await expect(compilePack(failingOptions)).rejects.toThrow("injected failure");
    expect(await readFile(pointerPath, "utf8")).toBe(originalPointer);
    await expect(readFile(path.join(outputRoot, "fixture-pack", "fixture-v2", "manifest.json"), "utf8"))
      .rejects.toThrow();
  });

  it("prunes the previous validated version only after publishing its replacement", async () => {
    const outputRoot = await temporaryOutput();
    const first = await compilePack(await fixtureCompileOptions(outputRoot));
    const second = await compilePack(await fixtureCompileOptions(outputRoot, undefined, {
      seed: { ...fixturePackSeed, dataVersion: "fixture-v2" },
      builtAt: "2026-08-04T01:00:00Z",
    }));

    expect(second.reusedExisting).toBe(false);
    await expect(readFile(path.join(first.packDirectory, "manifest.json"), "utf8")).rejects.toThrow();
    expect(JSON.parse(await readFile(path.join(outputRoot, "fixture-pack", "current.json"), "utf8"))).toMatchObject({
      dataVersion: "fixture-v2",
    });
  });

  it("writes deterministic schema 2 named areas, aliases, spatial rows, and access ranking fields", async () => {
    const firstRoot = await temporaryOutput();
    const secondRoot = await temporaryOutput();
    const first = await compilePack(await fixtureCompileOptionsV2(firstRoot));
    const second = await compilePack(await fixtureCompileOptionsV2(secondRoot));
    const manifest = packManifestV2Schema.parse(JSON.parse(await readFile(first.manifestPath, "utf8")));

    expect(manifest.capabilities.namedAreas).toBe(true);
    expect(first.audit).toMatchObject({
      schemaVersion: "2",
      namedAreaCount: 3,
      rejectedCoverageEdgeCount: 0,
      sourceCount: 4,
    });

    const database = new DatabaseSync(first.databasePath, { readOnly: true });
    const secondDatabase = new DatabaseSync(second.databasePath, { readOnly: true });
    try {
      const areas = database.prepare(`
        SELECT id, name, kind, geometry, source_refs FROM named_areas ORDER BY id
      `).all();
      expect(areas).toEqual(secondDatabase.prepare(`
        SELECT id, name, kind, geometry, source_refs FROM named_areas ORDER BY id
      `).all());
      expect(areas).toHaveLength(3);
      expect(database.prepare("SELECT count(*) AS count FROM named_area_spatial").get()).toEqual({ count: 3 });
      expect(database.prepare(`
        SELECT alias, normalized_alias FROM named_area_aliases
        WHERE area_id = 'osm:relation/1001' ORDER BY normalized_alias
      `).all()).toEqual([
        { alias: "Redwood Open Space", normalized_alias: "redwood open space" },
        { alias: "Redwood Preserve", normalized_alias: "redwood preserve" },
        { alias: "Redwoods", normalized_alias: "redwoods" },
      ]);
      const preserve = JSON.parse((areas.find((row) => (row as { id: string }).id === "osm:relation/1001") as { geometry: string }).geometry);
      const islands = JSON.parse((areas.find((row) => (row as { id: string }).id === "osm:relation/1002") as { geometry: string }).geometry);
      expect(preserve.coordinates).toHaveLength(2);
      expect(islands.type).toBe("MultiPolygon");
      expect(islands.coordinates).toHaveLength(2);
      expect(database.prepare(`
        SELECT known_connectivity, inclusive_connectivity, known_out_degree, inclusive_out_degree
        FROM access_points WHERE id = 'access-n-a'
      `).get()).toEqual({
        known_connectivity: 7,
        inclusive_connectivity: 7,
        known_out_degree: 2,
        inclusive_out_degree: 2,
      });
      expect(database.prepare("SELECT version FROM schema_migrations ORDER BY version").all())
        .toEqual([{ version: 1 }, { version: 2 }]);
    } finally {
      database.close();
      secondDatabase.close();
    }
    expect(searchNamedAreas(first.databasePath, "redwood open")).toEqual([
      expect.objectContaining({ id: "osm:relation/1001", name: "Redwood Preserve" }),
    ]);
    expect(searchNamedAreas(first.databasePath, "twin hills city")[0]).toMatchObject({
      id: "osm:relation/1002",
      kind: "city",
    });
    expect(searchNamedAreas(first.databasePath, "unknown region")).toEqual([]);
    expect(getNamedArea(first.databasePath, "osm:relation/1001")?.geometry).toMatchObject({ type: "Polygon" });
    expect(getNamedArea(first.databasePath, "missing")).toBeNull();
  });

  it("rejects out-of-coverage directed edges and records the exact audit count", async () => {
    const outputRoot = await temporaryOutput();
    const boundary: AreaGeometry = {
      type: "Polygon",
      coordinates: [[
        [-122.1605, 37.1595], [-122.1575, 37.1595], [-122.1575, 37.1615],
        [-122.1605, 37.1615], [-122.1605, 37.1595],
      ]],
    };
    const options = await fixtureCompileOptionsV2(outputRoot, undefined, undefined, {
      seed: {
        ...fixturePackSeedV2,
        dataVersion: "fixture-v2-clipped",
        coverage: { bbox: [-122.1605, 37.1595, -122.1575, 37.1615], boundary },
      },
    });
    const result = await compilePack(options);
    expect(result.audit.rejectedCoverageEdgeCount).toBe(5);
    expect(result.audit.directedEdgeCount).toBe(12);
    const database = new DatabaseSync(result.databasePath, { readOnly: true });
    try {
      expect(database.prepare("SELECT count(*) AS count FROM edges").get()).toEqual({ count: 12 });
      expect(database.prepare("SELECT count(*) AS count FROM edges WHERE id LIKE 'w-ridge:%'").get()).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });

  it("writes deterministic schema 3 topology profiles, dense keys, mappings, and hashes", async () => {
    const firstRoot = await temporaryOutput();
    const secondRoot = await temporaryOutput();
    const first = await compilePack(await fixtureCompileOptionsV3(firstRoot));
    const second = await compilePack(await fixtureCompileOptionsV3(secondRoot));
    const manifest = packManifestV3Schema.parse(JSON.parse(await readFile(first.manifestPath, "utf8")));
    expect(manifest.closedRouteTopology.runtimeMode).toBe("reachable-graph-fallback");
    expect(manifest.closedRouteTopology.profiles).toEqual(["known", "inclusive"]);
    expect(first.audit.topologyProfiles).toHaveLength(2);
    const database = new DatabaseSync(first.databasePath, { readOnly: true });
    const replay = new DatabaseSync(second.databasePath, { readOnly: true });
    try {
      const profiles = database.prepare("SELECT * FROM topology_profiles ORDER BY profile").all();
      expect(profiles).toEqual(replay.prepare("SELECT * FROM topology_profiles ORDER BY profile").all());
      const denseNodes = database.prepare("SELECT node_key, id FROM nodes ORDER BY node_key").all();
      expect(denseNodes).toEqual(replay.prepare("SELECT node_key, id FROM nodes ORDER BY node_key").all());
      expect(denseNodes[0]).toEqual({ node_key: 1, id: "n-a" });
      expect(database.prepare("SELECT edge_key, id, physical_edge_key FROM edges ORDER BY edge_key").all()).toEqual(
        replay.prepare("SELECT edge_key, id, physical_edge_key FROM edges ORDER BY edge_key").all(),
      );
      expect(database.prepare("SELECT count(*) AS count FROM topology_decision_edge_members").get()).toEqual({ count: 0 });
      expect(database.prepare("SELECT count(*) AS count FROM physical_edges").get()).toEqual({ count: 9 });
      expect(database.prepare("SELECT connector_decision_edge_ids FROM access_topology WHERE profile='known' AND access_point_id='access-n-a'").get())
        .toEqual({ connector_decision_edge_ids: "[]" });
      const keys = database.prepare("SELECT decision_edge_key FROM topology_decision_edges ORDER BY decision_edge_key").all()
        .map((row) => (row as { decision_edge_key: number }).decision_edge_key);
      expect(keys).toEqual([]);
      expect(database.prepare("SELECT version FROM schema_migrations ORDER BY version").all()).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }]);
    } finally { database.close(); replay.close(); }
    expect(first.audit.topologyContentHash).toBe(second.audit.topologyContentHash);
  });

  it("writes schema 4 reviewed search regions in deterministic display order", async () => {
    const firstRoot = await temporaryOutput();
    const secondRoot = await temporaryOutput();
    const first = await compilePack(await fixtureCompileOptionsV4(firstRoot));
    const second = await compilePack(await fixtureCompileOptionsV4(secondRoot));
    const manifest = packManifestV4Schema.parse(JSON.parse(await readFile(first.manifestPath, "utf8")));
    expect(manifest.capabilities.batchSearchRegions).toBe(true);
    expect(first.audit).toMatchObject({ schemaVersion: "4", searchRegionCount: 2 });
    expect(first.audit.topologyContentHash).toBe(second.audit.topologyContentHash);
    expect(listSearchRegions(first.databasePath)).toEqual([
      expect.objectContaining({ id: "pack:fixture-pack", name: "Compiler Fixture Pack", displayOrder: 0 }),
      expect.objectContaining({ id: "osm:relation/1001", name: "Redwood Preserve", displayOrder: 1 }),
    ]);
    const database = new DatabaseSync(first.databasePath, { readOnly: true });
    const replay = new DatabaseSync(second.databasePath, { readOnly: true });
    try {
      expect(database.prepare("SELECT * FROM search_regions ORDER BY display_order").all())
        .toEqual(replay.prepare("SELECT * FROM search_regions ORDER BY display_order").all());
      expect(database.prepare("SELECT version FROM schema_migrations ORDER BY version").all())
        .toEqual([{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }]);
      expect(database.prepare("SELECT count(*) AS count FROM topology_profiles").get()).toEqual({ count: 2 });
    } finally { database.close(); replay.close(); }
  });

  it("requires reviewed search regions only for schema 4", async () => {
    const outputRoot = await temporaryOutput();
    const options = await fixtureCompileOptionsV4(outputRoot);
    await expect(compilePack({ ...options, searchRegions: undefined }))
      .rejects.toThrow("Schema 4 pack requires reviewed search regions");
    const v3 = await fixtureCompileOptionsV3(outputRoot);
    await expect(compilePack({ ...v3, searchRegions: options.searchRegions }))
      .rejects.toThrow("Schema 3 pack cannot include search regions");
  });
});
