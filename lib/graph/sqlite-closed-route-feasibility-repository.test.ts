import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { topologySha256 } from "@/lib/data/topology-compiler";
import { SQLiteClosedRouteFeasibilityRepository } from "./sqlite-closed-route-feasibility-repository";

const manifest = {
  schemaVersion: "3",
  id: "feasibility-fixture",
  name: "Feasibility Fixture",
  dataVersion: "fixture-v3",
  builtAt: "2026-08-05T00:00:00Z",
  compilerVersion: "fixture-compiler",
  metricAlgorithmVersion: "fixture-metrics",
  coverage: {
    bbox: [0, 0, 1, 1],
    boundary: { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] },
  },
  display: { center: [0.5, 0.5], zoom: 12 },
  capabilities: { elevation: true, officialAccess: true, namedAreas: true, closedRouteTopology: true },
  fieldConfidence: { elevation: "high" },
  sources: [{
    id: "fixture", authority: "Fixture", dataset: "Fixture", version: "1",
    retrievedAt: "2026-08-05T00:00:00Z", url: "https://example.invalid/fixture",
    license: "CC0-1.0", contentHash: `sha256:${"0".repeat(64)}`,
  }],
  closedRouteTopology: {
    runtimeMode: "reachable-graph-fallback",
    algorithmVersion: "closed-topology-v1",
    policyVersion: "closed-primitives-v1",
    profiles: ["known", "inclusive"],
  },
} as const;

const directories: string[] = [];

function createFixtureDatabase(mutate?: (database: DatabaseSync) => void): string {
  const directory = mkdtempSync(join(tmpdir(), "alpine-feasibility-repository-"));
  directories.push(directory);
  const databasePath = join(directory, "pack.sqlite");
  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE metadata(key TEXT NOT NULL, value TEXT NOT NULL) STRICT;
    CREATE TABLE schema_migrations(version INTEGER NOT NULL, applied_at TEXT NOT NULL) STRICT;
    CREATE TABLE access_points(id TEXT NOT NULL, node_id TEXT NOT NULL) STRICT;
    CREATE TABLE topology_profiles(
      profile TEXT NOT NULL, format_version INTEGER NOT NULL, node_count INTEGER NOT NULL,
      physical_edge_count INTEGER NOT NULL, decision_node_count INTEGER NOT NULL,
      decision_edge_count INTEGER NOT NULL, built_at TEXT NOT NULL, content_hash TEXT NOT NULL
    ) STRICT;
    CREATE TABLE access_topology(
      profile TEXT NOT NULL, access_point_id TEXT NOT NULL, attachment_decision_node_id INTEGER NOT NULL,
      cycle_network_id INTEGER, connector_key TEXT, connector_decision_edge_ids TEXT NOT NULL,
      portal_decision_node_id INTEGER, minimum_stem_distance_m REAL, can_reach_cycle INTEGER NOT NULL
    ) STRICT;

    INSERT INTO schema_migrations VALUES
      (1, '2026-08-05T00:00:00Z'), (2, '2026-08-05T00:00:00Z'), (3, '2026-08-05T00:00:00Z');
    INSERT INTO metadata VALUES
      ('schemaVersion', '3'), ('packId', 'feasibility-fixture'), ('dataVersion', 'fixture-v3'),
      ('builtAt', '2026-08-05T00:00:00Z'), ('compilerVersion', 'fixture-compiler'),
      ('metricAlgorithmVersion', 'fixture-metrics'),
      ('topologyContentHash', 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    INSERT INTO access_points VALUES ('start-a', 'node-a'), ('start-b', 'node-b');
    INSERT INTO topology_profiles VALUES
      ('known', 1, 0, 1, 0, 0, '2026-08-05T00:00:00Z', 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'),
      ('inclusive', 1, 0, 2, 0, 0, '2026-08-05T00:00:00Z', 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc');
    INSERT INTO access_topology VALUES
      ('known', 'start-a', 1, 10, 'known-a', '[]', 1, 0, 1),
      ('known', 'start-b', 2, NULL, NULL, '[]', NULL, NULL, 0),
      ('inclusive', 'start-a', 1, 20, 'inclusive-a', '[]', 1, 12.5, 1),
      ('inclusive', 'start-b', 2, 20, 'inclusive-b', '[]', 1, 25, 1);
  `);
  const inputs = {
    known: [
      { accessPointId: "start-a", attachmentDecisionNodeId: 1, cycleNetworkId: 10, connectorKey: "known-a", connectorDecisionEdgeIds: [], portalDecisionNodeId: 1, minimumStemDistanceM: 0, canReachCycle: true },
      { accessPointId: "start-b", attachmentDecisionNodeId: 2, cycleNetworkId: null, connectorKey: null, connectorDecisionEdgeIds: [], portalDecisionNodeId: null, minimumStemDistanceM: null, canReachCycle: false },
    ],
    inclusive: [
      { accessPointId: "start-a", attachmentDecisionNodeId: 1, cycleNetworkId: 20, connectorKey: "inclusive-a", connectorDecisionEdgeIds: [], portalDecisionNodeId: 1, minimumStemDistanceM: 12.5, canReachCycle: true },
      { accessPointId: "start-b", attachmentDecisionNodeId: 2, cycleNetworkId: 20, connectorKey: "inclusive-b", connectorDecisionEdgeIds: [], portalDecisionNodeId: 1, minimumStemDistanceM: 25, canReachCycle: true },
    ],
  } as const;
  const profiles = (["known", "inclusive"] as const).map((profile) => {
    const contentHash = topologySha256({
      profile, formatVersion: 1, nodeCount: 0, physicalEdgeCount: profile === "known" ? 1 : 2,
      decisionNodeCount: 0, decisionEdgeCount: 0, nodes: [], decisionEdges: [], blocks: [], blockLinks: [], networks: [],
      accessTopology: inputs[profile],
    });
    database.prepare("UPDATE topology_profiles SET content_hash = ? WHERE profile = ?").run(contentHash, profile);
    return { profile, contentHash };
  });
  database.prepare("UPDATE metadata SET value = ? WHERE key = 'topologyContentHash'").run(topologySha256({
    runtimeMode: "reachable-graph-fallback",
    algorithmVersion: "closed-topology-v1",
    policyVersion: "closed-primitives-v1",
    profiles,
  }));
  mutate?.(database);
  database.close();
  return databasePath;
}

function open(databasePath: string) {
  return new SQLiteClosedRouteFeasibilityRepository({ databasePath, manifest });
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("SQLiteClosedRouteFeasibilityRepository", () => {
  it("batches access lookups without requiring decision-network tables", async () => {
    const repository = open(createFixtureDatabase());
    await expect(repository.getAccessTopology("known", ["start-b", "missing", "start-a", "start-b"]))
      .resolves.toEqual([
        expect.objectContaining({ accessPointId: "start-b", canReachCycle: false }),
        expect.objectContaining({ accessPointId: "start-a", cycleNetworkId: 10 }),
        expect.objectContaining({ accessPointId: "start-b", canReachCycle: false }),
      ]);
    await expect(repository.getAccessTopology("inclusive", ["start-b"]))
      .resolves.toEqual([expect.objectContaining({
        accessPointId: "start-b",
        connectorDecisionEdgeIds: [],
        minimumStemDistanceMeters: 25,
      })]);
    expect(repository.packId).toBe("feasibility-fixture");
    expect(repository.dataVersion).toBe("fixture-v3");
    await repository.close();
    await expect(repository.getAccessTopology("known", ["start-a"])).rejects.toThrow(/closed/);
  });

  it("rejects packs without the complete schema-3 migration chain", () => {
    expect(() => open(createFixtureDatabase((database) => {
      database.prepare("DELETE FROM schema_migrations WHERE version = 3").run();
    }))).toThrow(/schema migrations 1, 2, 3/);
  });

  it("rejects stale manifest identity and missing topology metadata", () => {
    expect(() => open(createFixtureDatabase((database) => {
      database.prepare("UPDATE metadata SET value = 'old-version' WHERE key = 'dataVersion'").run();
    }))).toThrow(/stale data version/);
    expect(() => open(createFixtureDatabase((database) => {
      database.prepare("DELETE FROM metadata WHERE key = 'topologyContentHash'").run();
    }))).toThrow(/topologyContentHash/);
  });

  it("rejects missing, duplicate, orphaned, and corrupt access topology", () => {
    expect(() => open(createFixtureDatabase((database) => {
      database.prepare("DELETE FROM access_topology WHERE profile = 'known' AND access_point_id = 'start-b'").run();
    }))).toThrow(/missing known access topology for start-b/);
    expect(() => open(createFixtureDatabase((database) => {
      database.prepare(`
        INSERT INTO access_topology
        SELECT * FROM access_topology WHERE profile = 'known' AND access_point_id = 'start-a'
      `).run();
    }))).toThrow(/duplicate known access topology for start-a/);
    expect(() => open(createFixtureDatabase((database) => {
      database.prepare("UPDATE access_topology SET access_point_id = 'orphan' WHERE profile = 'known' AND access_point_id = 'start-a'").run();
    }))).toThrow(/unknown access point orphan/);
    expect(() => open(createFixtureDatabase((database) => {
      database.prepare("UPDATE access_topology SET can_reach_cycle = 0 WHERE profile = 'known' AND access_point_id = 'start-a'").run();
    }))).toThrow(/inconsistent cycle reachability/);
    expect(() => open(createFixtureDatabase((database) => {
      database.prepare("UPDATE access_topology SET connector_decision_edge_ids = 'not-json' WHERE profile = 'inclusive' AND access_point_id = 'start-a'").run();
    }))).toThrow(/invalid JSON/);
  });

  it("rejects missing, duplicate, or corrupt topology profile rows", () => {
    expect(() => open(createFixtureDatabase((database) => {
      database.prepare("DELETE FROM topology_profiles WHERE profile = 'inclusive'").run();
    }))).toThrow(/topology profile count mismatch/);
    expect(() => open(createFixtureDatabase((database) => {
      database.prepare(`
        INSERT INTO topology_profiles
        SELECT * FROM topology_profiles WHERE profile = 'known'
      `).run();
    }))).toThrow(/topology profile count mismatch/);
    expect(() => open(createFixtureDatabase((database) => {
      database.prepare("UPDATE topology_profiles SET format_version = 2 WHERE profile = 'known'").run();
    }))).toThrow(/unsupported known topology format version/);
    expect(() => open(createFixtureDatabase((database) => {
      database.prepare("UPDATE topology_profiles SET content_hash = 'tampered' WHERE profile = 'known'").run();
    }))).toThrow(/invalid known topology content hash/);
  });
});
