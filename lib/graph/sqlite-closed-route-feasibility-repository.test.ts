import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { packManifestSchema, type PackManifest } from "@/lib/contracts";
import type { GraphEdge, GraphNode, InducedGraph } from "./types";
import { GRAPH_FIXTURE_IDENTITY, writeGraphFixture } from "./test-helpers";
import legacy from "./fixtures/legacy-feasibility.json";
import { SQLiteClosedRouteFeasibilityRepository } from "./sqlite-closed-route-feasibility-repository";

const directories: string[] = [];
const repositories: SQLiteClosedRouteFeasibilityRepository[] = [];
afterEach(async () => {
  for (const repository of repositories.splice(0)) await repository.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixtureGraph(): InducedGraph {
  const nodes = new Map<string, GraphNode>([
    ["node-a", { id: "node-a", lon: 0, lat: 0, elevationMeters: 100, flags: [] }],
    ["node-b", { id: "node-b", lon: -0.001, lat: 0, elevationMeters: 100, flags: [] }],
    ["c", { id: "c", lon: 0.001, lat: 0, elevationMeters: 100, flags: [] }],
    ["d", { id: "d", lon: 0.001, lat: 0.001, elevationMeters: 100, flags: [] }],
  ]);
  const edges: GraphEdge[] = [];
  function connect(fromId: string, toId: string, lengthMeters: number, accessState: "public" | "unknown") {
    const physicalEdgeKey = edges.length + 1;
    for (const [fromNodeId, toNodeId] of [[fromId, toId], [toId, fromId]]) {
      const from = nodes.get(fromNodeId)!;
      const to = nodes.get(toNodeId)!;
      edges.push({ id: `${fromNodeId}->${toNodeId}`, fromNodeId, toNodeId, physicalEdgeKey,
        coordinates: [[from.lon, from.lat], [to.lon, to.lat]], lengthMeters, gainMeters: 0, lossMeters: 0,
        maximumElevationMeters: 100, maximumSustainedGradePct: 0, accessState, trailName: null,
        sourceIds: ["fixture"], flags: [] });
    }
  }
  connect("node-a", "c", 100, "public");
  connect("c", "d", 100, "public");
  connect("d", "node-a", 100, "public");
  connect("node-b", "node-a", 25, "unknown");
  return { nodes, edges, accessPoints: ["a", "b"].map((suffix) => ({
    id: `start-${suffix}`, nodeId: `node-${suffix}`, name: `Start ${suffix}`, kind: "trailhead", accessState: "public",
    confidence: "high", parkingEvidence: null, sourceIds: ["fixture"], nearbyBuildingCount: 0,
  })) };
}

function createFixture(mutate?: (database: DatabaseSync) => void) {
  const directory = mkdtempSync(join(tmpdir(), "feasibility-reader-"));
  directories.push(directory);
  const databasePath = join(directory, "pack.sqlite");
  const manifest = writeGraphFixture(databasePath, fixtureGraph());
  if (mutate) {
    const database = new DatabaseSync(databasePath);
    try { mutate(database); } finally { database.close(); }
  }
  return { databasePath, manifest };
}

function open(fixture: { databasePath: string; manifest: PackManifest }) {
  const repository = new SQLiteClosedRouteFeasibilityRepository(fixture);
  repositories.push(repository);
  return repository;
}

// These rows and hashes were frozen from the format-1 compiler before replacement.
// Loading them must not depend on the current producer reproducing old identities.
function createLegacyFixture(tamper = false) {
  const fixture = createFixture((database) => {
    database.exec("DELETE FROM access_topology; DELETE FROM topology_profiles");
    for (const [table, rows] of [["topology_profiles", legacy.profiles], ["access_topology", legacy.accessTopology]] as const) {
      const columns = Object.keys(rows[0]!);
      const insert = database.prepare(`INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`);
      for (const row of rows) insert.run(...Object.values(row));
    }
    database.prepare("UPDATE metadata SET value = ? WHERE key = 'dataVersion'").run(legacy.manifest.dataVersion);
    database.prepare("UPDATE metadata SET value = ? WHERE key = 'topologyContentHash'").run(legacy.topologyContentHash);
    if (tamper) database.exec("UPDATE access_topology SET minimum_stem_distance_m = 26 WHERE profile = 'inclusive' AND access_point_id = 'start-b'");
  });
  return { ...fixture, manifest: packManifestSchema.parse(legacy.manifest) };
}

describe("SQLiteClosedRouteFeasibilityRepository", () => {
  it("reads both production topology profiles, preserves lookup order, and retains minimum stems", async () => {
    const repository = open(createFixture());
    await expect(repository.getAccessTopology("known", ["start-b", "missing", "start-a", "start-b"]))
      .resolves.toEqual([
        expect.objectContaining({ accessPointId: "start-b", canReachCycle: false, connectorKey: null }),
        expect.objectContaining({ accessPointId: "start-a", canReachCycle: true, minimumStemDistanceMeters: 0 }),
        expect.objectContaining({ accessPointId: "start-b", canReachCycle: false, connectorKey: null }),
      ]);
    await expect(repository.getAccessTopology("inclusive", ["start-b"]))
      .resolves.toEqual([expect.objectContaining({ accessPointId: "start-b", connectorDecisionEdgeIds: [], minimumStemDistanceMeters: 25 })]);
    expect(repository.packId).toBe("fixture-pack");
    expect(repository.dataVersion).toBe(GRAPH_FIXTURE_IDENTITY.dataVersion);
    await repository.close();
    await expect(repository.getAccessTopology("known", ["start-a"])).rejects.toThrow(/closed/);
  });

  it("reads authentic format-1 rows and still checks their independent content hashes", async () => {
    const repository = open(createLegacyFixture());
    expect(repository.dataVersion).toBe("fixture-v6");
    await expect(repository.getAccessTopology("known", ["start-b"]))
      .resolves.toEqual([expect.objectContaining({ canReachCycle: false, minimumStemDistanceMeters: null })]);
    await expect(repository.getAccessTopology("inclusive", ["start-b"]))
      .resolves.toEqual([expect.objectContaining({ canReachCycle: true, minimumStemDistanceMeters: 25,
        connectorKey: legacy.accessTopology[3]!.connector_key })]);
    expect(() => open(createLegacyFixture(true))).toThrow(/profile content hash mismatch/);
  });

  it("rejects packs without the complete current migration chain", () => {
    expect(() => open(createFixture((database) => database.exec("DELETE FROM schema_migrations WHERE version = 6"))))
      .toThrow(/schema migrations 1, 2, 3, 4, 5, 6/);
  });

  it("rejects stale identity and missing topology metadata", () => {
    expect(() => open(createFixture((database) => database.exec("UPDATE metadata SET value = 'old-version' WHERE key = 'dataVersion'"))))
      .toThrow(/stale data version/);
    expect(() => open(createFixture((database) => database.exec("DELETE FROM metadata WHERE key = 'topologyContentHash'"))))
      .toThrow(/topologyContentHash/);
  });

  it("rejects missing, orphaned, and inconsistent access topology", () => {
    expect(() => open(createFixture((database) => database.exec("DELETE FROM access_topology WHERE profile = 'known' AND access_point_id = 'start-b'"))))
      .toThrow(/missing known access topology for start-b/);
    expect(() => open(createFixture((database) => database.exec("PRAGMA foreign_keys = OFF; UPDATE access_topology SET access_point_id = 'orphan' WHERE profile = 'known' AND access_point_id = 'start-a'"))))
      .toThrow(/unknown access point orphan/);
    expect(() => open(createFixture((database) => database.exec("UPDATE access_topology SET can_reach_cycle = 0 WHERE profile = 'known' AND access_point_id = 'start-a'"))))
      .toThrow(/inconsistent cycle reachability/);
    expect(() => open(createFixture((database) => database.exec("UPDATE access_topology SET connector_decision_edge_ids = 'not-json' WHERE profile = 'inclusive' AND access_point_id = 'start-a'"))))
      .toThrow(/invalid JSON/);
  });

  it("rejects missing profiles, obsolete topology formats, and altered content hashes", () => {
    expect(() => open(createFixture((database) => database.exec("PRAGMA foreign_keys = OFF; DELETE FROM topology_profiles WHERE profile = 'inclusive'"))))
      .toThrow(/topology profile count mismatch/);
    expect(() => open(createFixture((database) => database.exec("UPDATE topology_profiles SET format_version = 99 WHERE profile = 'known'"))))
      .toThrow(/unsupported known topology format version/);
    expect(() => open(createFixture((database) => database.exec("UPDATE topology_profiles SET content_hash = 'tampered' WHERE profile = 'known'"))))
      .toThrow(/invalid known topology content hash/);
    expect(() => open(createFixture((database) => database.exec("UPDATE access_topology SET minimum_stem_distance_m = 26 WHERE profile = 'inclusive' AND access_point_id = 'start-b'"))))
      .toThrow(/profile content hash mismatch/);
  });
});
