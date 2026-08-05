import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  computePersistedTopologyHashes,
  SQLiteClosedRouteTopologyRepository,
} from "./sqlite-closed-route-topology-repository";

const manifest = {
  schemaVersion: "3",
  id: "topology-fixture",
  name: "Topology Fixture",
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
    algorithmVersion: "closed-topology-v1",
    policyVersion: "closed-primitives-v1",
    profiles: ["known", "inclusive"],
  },
} as const;

const directories: string[] = [];

function createFixtureDatabase(mutate?: (database: DatabaseSync) => void): string {
  const directory = mkdtempSync(join(tmpdir(), "alpine-topology-repository-"));
  directories.push(directory);
  const databasePath = join(directory, "pack.sqlite");
  const database = new DatabaseSync(databasePath);
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
    CREATE TABLE nodes(
      id TEXT PRIMARY KEY, node_key INTEGER NOT NULL UNIQUE, lon REAL NOT NULL, lat REAL NOT NULL,
      elevation_m REAL, flags TEXT NOT NULL
    ) STRICT;
    CREATE TABLE physical_edges(
      physical_edge_key INTEGER PRIMARY KEY, stable_physical_id TEXT NOT NULL UNIQUE,
      from_node_key INTEGER NOT NULL, to_node_key INTEGER NOT NULL, geometry_hash TEXT NOT NULL
    ) STRICT;
    CREATE TABLE edges(
      id TEXT PRIMARY KEY, edge_key INTEGER NOT NULL UNIQUE, physical_edge_key INTEGER NOT NULL,
      from_node TEXT NOT NULL, to_node TEXT NOT NULL, geometry TEXT NOT NULL,
      length_m REAL NOT NULL, gain_m REAL, loss_m REAL, max_elevation_m REAL,
      max_sustained_grade_pct REAL, access_state TEXT NOT NULL, source_refs TEXT NOT NULL,
      flags TEXT NOT NULL
    ) STRICT;
    CREATE TABLE access_points(id TEXT PRIMARY KEY, node_id TEXT NOT NULL) STRICT;
    CREATE TABLE topology_profiles(
      profile TEXT PRIMARY KEY, format_version INTEGER NOT NULL, node_count INTEGER NOT NULL,
      physical_edge_count INTEGER NOT NULL, decision_node_count INTEGER NOT NULL,
      decision_edge_count INTEGER NOT NULL, built_at TEXT NOT NULL, content_hash TEXT NOT NULL
    ) STRICT;
    CREATE TABLE topology_networks(
      profile TEXT NOT NULL, network_id INTEGER NOT NULL, decision_node_count INTEGER NOT NULL,
      decision_edge_count INTEGER NOT NULL, cycle_block_count INTEGER NOT NULL,
      minimum_cycle_length_m REAL, maximum_cycle_length_m REAL, minimum_elevation_m REAL,
      maximum_elevation_m REAL, content_hash TEXT NOT NULL, PRIMARY KEY(profile, network_id)
    ) STRICT;
    CREATE TABLE topology_nodes(
      profile TEXT NOT NULL, dense_id INTEGER NOT NULL, source_node_id TEXT NOT NULL,
      decision_node_id INTEGER, connected_component_id INTEGER NOT NULL, directed_scc_id INTEGER NOT NULL,
      two_edge_component_id INTEGER NOT NULL, is_articulation INTEGER NOT NULL,
      nearest_cycle_network_id INTEGER, cycle_portal_decision_node_id INTEGER,
      minimum_stem_distance_m REAL, PRIMARY KEY(profile, dense_id), UNIQUE(profile, source_node_id)
    ) STRICT;
    CREATE TABLE topology_decision_edges(
      profile TEXT NOT NULL, decision_edge_key INTEGER NOT NULL, network_id INTEGER NOT NULL,
      from_decision_node_id INTEGER NOT NULL, to_decision_node_id INTEGER NOT NULL,
      length_m REAL NOT NULL, gain_m REAL NOT NULL, loss_m REAL NOT NULL, is_bridge INTEGER NOT NULL,
      two_edge_component_id INTEGER NOT NULL, vertex_block_id INTEGER, metrics_and_flags TEXT NOT NULL,
      PRIMARY KEY(profile, decision_edge_key)
    ) STRICT;
    CREATE UNIQUE INDEX topology_decision_edge_global_key ON topology_decision_edges(decision_edge_key);
    CREATE TABLE topology_decision_edge_members(
      profile TEXT NOT NULL, decision_edge_key INTEGER NOT NULL, sequence_index INTEGER NOT NULL,
      edge_key INTEGER NOT NULL, physical_edge_key INTEGER NOT NULL,
      PRIMARY KEY(profile, decision_edge_key, sequence_index)
    ) STRICT;
    CREATE TABLE topology_blocks(
      profile TEXT NOT NULL, block_id INTEGER NOT NULL, network_id INTEGER NOT NULL,
      block_kind TEXT NOT NULL, node_count INTEGER NOT NULL, edge_count INTEGER NOT NULL,
      cycle_rank INTEGER NOT NULL, total_physical_length_m REAL NOT NULL,
      minimum_cycle_length_m REAL, elevation_summary TEXT NOT NULL, trail_summary TEXT NOT NULL,
      PRIMARY KEY(profile, block_id)
    ) STRICT;
    CREATE TABLE topology_block_nodes(
      profile TEXT NOT NULL, block_id INTEGER NOT NULL, decision_node_id INTEGER NOT NULL,
      PRIMARY KEY(profile, block_id, decision_node_id)
    ) STRICT;
    CREATE TABLE topology_block_edges(
      profile TEXT NOT NULL, block_id INTEGER NOT NULL, decision_edge_key INTEGER NOT NULL,
      PRIMARY KEY(profile, block_id, decision_edge_key)
    ) STRICT;
    CREATE TABLE topology_block_links(
      profile TEXT NOT NULL, network_id INTEGER NOT NULL, from_block_id INTEGER NOT NULL,
      to_block_id INTEGER NOT NULL, articulation_decision_node_id INTEGER NOT NULL,
      connector_distance_m REAL NOT NULL,
      PRIMARY KEY(profile, from_block_id, to_block_id, articulation_decision_node_id)
    ) STRICT;
    CREATE TABLE access_topology(
      profile TEXT NOT NULL, access_point_id TEXT NOT NULL, attachment_decision_node_id INTEGER NOT NULL,
      cycle_network_id INTEGER, connector_key TEXT, connector_decision_edge_ids TEXT NOT NULL,
      portal_decision_node_id INTEGER, minimum_stem_distance_m REAL, can_reach_cycle INTEGER NOT NULL,
      PRIMARY KEY(profile, access_point_id)
    ) STRICT;

    INSERT INTO metadata VALUES
      ('schemaVersion', '3'), ('packId', 'topology-fixture'), ('dataVersion', 'fixture-v3'),
      ('builtAt', '2026-08-05T00:00:00Z'), ('compilerVersion', 'fixture-compiler'),
      ('metricAlgorithmVersion', 'fixture-metrics'),
      ('topologyContentHash', 'sha256:fixture-combined');
    INSERT INTO nodes VALUES
      ('node-a', 1, 0, 0, 10, '[]'), ('node-b', 2, 0.1, 0, 20, '[]'),
      ('node-c', 3, 0.2, 0, 30, '[]'), ('node-d', 4, 0.3, 0, 40, '[]');
    INSERT INTO physical_edges VALUES
      (1, 'physical-alpha', 1, 2, 'sha256:a'),
      (2, 'physical-beta', 2, 1, 'sha256:b'),
      (3, 'physical-gamma', 3, 4, 'sha256:c');
    INSERT INTO edges VALUES
      ('misleading:reverse', 100, 1, 'node-a', 'node-b', '[[0,0],[0.1,0]]', 100, 10, 0, 20, 10, 'public', '["source"]', '["trail-name:Alpha"]'),
      ('not-a-direction-suffix', 101, 2, 'node-b', 'node-a', '[[0.1,0],[0,0]]', 110, 0, 10, 20, 10, 'unknown', '["source"]', '[]'),
      ('another:forward', 102, 3, 'node-c', 'node-d', '[[0.2,0],[0.3,0]]', 120, 5, 1, 40, 8, 'public', '["source"]', '[]');
    INSERT INTO access_points VALUES
      ('known-start', 'node-a'), ('no-cycle', 'node-d'), ('unknown-start', 'node-b');

    INSERT INTO topology_profiles VALUES
      ('known', 1, 4, 2, 4, 2, '2026-08-05T00:00:00Z', 'sha256:known'),
      ('inclusive', 1, 4, 2, 3, 2, '2026-08-05T00:00:00Z', 'sha256:inclusive');
    INSERT INTO topology_networks VALUES
      ('known', 1, 2, 1, 1, 200, 200, 10, 20, 'sha256:known-1'),
      ('known', 2, 2, 1, 1, 240, 240, 30, 40, 'sha256:known-2'),
      ('inclusive', 1, 2, 2, 1, 210, 210, 10, 20, 'sha256:inclusive-1');
    INSERT INTO topology_nodes VALUES
      ('known', 1, 'node-a', 1, 1, 1, 1, 0, 1, 1, 0),
      ('known', 2, 'node-b', 2, 1, 1, 1, 0, 1, 2, 0),
      ('known', 3, 'node-c', 3, 2, 2, 2, 0, 2, 3, 0),
      ('known', 4, 'node-d', 4, 2, 2, 2, 0, 2, 4, 0),
      ('inclusive', 1, 'node-a', 1, 1, 1, 1, 0, 1, 1, 0),
      ('inclusive', 2, 'node-b', 2, 1, 1, 1, 0, 1, 2, 0),
      ('inclusive', 3, 'node-c', NULL, 2, 2, 2, 0, NULL, NULL, NULL),
      ('inclusive', 4, 'node-d', 4, 2, 2, 2, 0, NULL, NULL, NULL);
    INSERT INTO topology_decision_edges VALUES
      ('known', 10, 1, 1, 2, 100, 10, 0, 0, 1, 10, '{"maximumElevationMeters":20,"maximumSustainedGradePct":10,"accessState":"public","trailNames":["Alpha"],"sourceIds":["source"],"flags":[]}'),
      ('known', 11, 2, 3, 4, 120, 5, 1, 0, 2, 11, '{"maximumElevationMeters":40,"maximumSustainedGradePct":8,"accessState":"public","trailNames":[],"sourceIds":["source"],"flags":[]}'),
      ('inclusive', 20, 1, 1, 2, 100, 10, 0, 0, 1, 20, '{"maximumElevationMeters":20,"maximumSustainedGradePct":10,"accessState":"public","trailNames":["Alpha"],"sourceIds":["source"],"flags":[]}'),
      ('inclusive', 21, 1, 2, 1, 110, 0, 10, 0, 1, 20, '{"maximumElevationMeters":20,"maximumSustainedGradePct":10,"accessState":"unknown","trailNames":[],"sourceIds":["source"],"flags":[]}');
    INSERT INTO topology_decision_edge_members VALUES
      ('known', 10, 0, 100, 1), ('known', 11, 0, 102, 3),
      ('inclusive', 20, 0, 100, 1), ('inclusive', 21, 0, 101, 2);
    INSERT INTO topology_blocks VALUES
      ('known', 10, 1, 'vertex-cycle', 2, 1, 1, 100, 200, '{"minimumElevationMeters":10,"maximumElevationMeters":20}', '["Alpha"]'),
      ('known', 11, 2, 'vertex-cycle', 2, 1, 1, 120, 240, '{"minimumElevationMeters":30,"maximumElevationMeters":40}', '[]'),
      ('inclusive', 20, 1, 'vertex-cycle', 2, 2, 1, 210, 210, '{"minimumElevationMeters":10,"maximumElevationMeters":20}', '["Alpha"]');
    INSERT INTO topology_block_nodes VALUES
      ('known', 10, 1), ('known', 10, 2), ('known', 11, 3), ('known', 11, 4),
      ('inclusive', 20, 1), ('inclusive', 20, 2);
    INSERT INTO topology_block_edges VALUES
      ('known', 10, 10), ('known', 11, 11), ('inclusive', 20, 20), ('inclusive', 20, 21);
    INSERT INTO access_topology VALUES
      ('known', 'known-start', 1, 1, 'known-connector', '[]', 1, 0, 1),
      ('known', 'no-cycle', 4, NULL, NULL, '[]', NULL, NULL, 0),
      ('known', 'unknown-start', 2, 1, 'known-unknown-access', '[]', 1, 0, 1),
      ('inclusive', 'known-start', 1, 1, 'inclusive-public', '[]', 1, 0, 1),
      ('inclusive', 'no-cycle', 4, NULL, NULL, '[]', NULL, NULL, 0),
      ('inclusive', 'unknown-start', 2, 1, 'inclusive-unknown', '[21]', 1, 110, 1);
  `);
  const hashes = computePersistedTopologyHashes(database, "closed-topology-v1", "closed-primitives-v1");
  const profileHash = database.prepare("UPDATE topology_profiles SET content_hash = ? WHERE profile = ?");
  hashes.profiles.forEach(({ profile, contentHash }) => profileHash.run(contentHash, profile));
  const networkHash = database.prepare(
    "UPDATE topology_networks SET content_hash = ? WHERE profile = ? AND network_id = ?",
  );
  hashes.networks.forEach(({ profile, networkId, contentHash }) => networkHash.run(contentHash, profile, networkId));
  database.prepare("UPDATE metadata SET value = ? WHERE key = 'topologyContentHash'").run(hashes.contentHash);
  mutate?.(database);
  database.close();
  return databasePath;
}

function open(databasePath: string, maximumCacheBytes = 64 * 1024 * 1024) {
  return new SQLiteClosedRouteTopologyRepository({ databasePath, manifest, maximumCacheBytes });
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("SQLiteClosedRouteTopologyRepository", () => {
  it("loads validated immutable networks and keeps known/inclusive profiles isolated", async () => {
    const repository = open(createFixtureDatabase());
    expect(await repository.getAccessTopology("known", ["known-start", "missing"]))
      .toEqual([expect.objectContaining({ accessPointId: "known-start", connectorKey: "known-connector" })]);
    expect(await repository.getAccessTopology("inclusive", ["unknown-start"]))
      .toEqual([expect.objectContaining({ connectorDecisionEdgeIds: [21], canReachCycle: true })]);
    const known = await repository.loadDecisionNetwork("known", 1);
    const inclusive = await repository.loadDecisionNetwork("inclusive", 1);
    expect(known.edges.map(({ id }) => id)).toEqual([10]);
    expect(inclusive.edges.map(({ id }) => id)).toEqual([20, 21]);
    expect(known.nodes.get(1)?.vertexBlockIds).toEqual([10]);
    expect(Object.isFrozen(known)).toBe(true);
    expect(Object.isFrozen(known.edges)).toBe(true);
    expect(Object.isFrozen(known.edges[0].members)).toBe(true);
    expect(await repository.getNetworkSummary("known", 1)).toEqual(expect.objectContaining({ cycleBlockCount: 1 }));
    await repository.close();
  });

  it("rejects non-schema-3 manifests before loading topology", () => {
    expect(() => new SQLiteClosedRouteTopologyRepository({
      databasePath: createFixtureDatabase(),
      manifest: { ...manifest, schemaVersion: "2" },
    })).toThrow();
  });

  it("reconstructs exact directed edges using compiler keys, never string suffixes", async () => {
    const repository = open(createFixtureDatabase());
    const reconstructed = await repository.reconstructDirectedEdges([10, 21]);
    expect(reconstructed.map(({ id, fromNodeId, toNodeId }) => [id, fromNodeId, toNodeId])).toEqual([
      ["misleading:reverse", "node-a", "node-b"],
      ["not-a-direction-suffix", "node-b", "node-a"],
    ]);
    expect(reconstructed.map(({ physicalEdgeKey, stablePhysicalEdgeId }) =>
      [physicalEdgeKey, stablePhysicalEdgeId])).toEqual([
      [1, "physical-alpha"], [2, "physical-beta"],
    ]);
    await repository.close();
  });

  it("rejects stale pack metadata, count mismatches, corrupt members, and sequence gaps", () => {
    expect(() => open(createFixtureDatabase((database) => {
      database.prepare("UPDATE metadata SET value = 'old-v3' WHERE key = 'dataVersion'").run();
    }))).toThrow(/stale data version/);
    expect(() => open(createFixtureDatabase((database) => {
      database.prepare("UPDATE topology_profiles SET decision_edge_count = 99 WHERE profile = 'known'").run();
    }))).toThrow(/decision_edge_count mismatch/);
    expect(() => open(createFixtureDatabase((database) => {
      database.prepare("UPDATE topology_decision_edge_members SET physical_edge_key = 2 WHERE decision_edge_key = 10").run();
    }))).toThrow(/dangling reconstruction members/);
    expect(() => open(createFixtureDatabase((database) => {
      database.prepare("UPDATE topology_decision_edge_members SET sequence_index = 3 WHERE decision_edge_key = 10").run();
    }))).toThrow(/sequence is not contiguous/);
    expect(() => open(createFixtureDatabase((database) => {
      database.prepare("UPDATE edges SET length_m = 101 WHERE edge_key = 100").run();
    }))).toThrow(/aggregate length or elevation mismatch/);
    expect(() => open(createFixtureDatabase((database) => {
      database.prepare("UPDATE topology_blocks SET trail_summary = '[\"Tampered\"]' WHERE profile = 'known' AND block_id = 10").run();
    }))).toThrow(/content hash mismatch/);
  });

  it("joins concurrent loads and returns the same immutable network instance", async () => {
    const repository = open(createFixtureDatabase());
    const [first, second, third] = await Promise.all([
      repository.loadDecisionNetwork("known", 1),
      repository.loadDecisionNetwork("known", 1),
      repository.loadDecisionNetwork("known", 1),
    ]);
    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(repository.getCacheDiagnostics()).toEqual(expect.objectContaining({
      misses: 1, concurrentLoadJoins: 2, loads: 1,
    }));
    await repository.loadDecisionNetwork("known", 1);
    expect(repository.getCacheDiagnostics().hits).toBe(1);
    await repository.close();
  });

  it("uses measured bytes for LRU eviction and invalidates the complete pack-version cache", async () => {
    const databasePath = createFixtureDatabase();
    const measuring = open(databasePath);
    const firstSize = (await measuring.loadDecisionNetwork("known", 1)).estimatedByteSize;
    const secondSize = (await measuring.loadDecisionNetwork("known", 2)).estimatedByteSize;
    await measuring.close();

    const repository = open(databasePath, Math.max(firstSize, secondSize));
    await repository.loadDecisionNetwork("known", 1);
    await repository.loadDecisionNetwork("known", 2);
    expect(repository.getCacheDiagnostics().residentBytes).toBeLessThanOrEqual(Math.max(firstSize, secondSize));
    expect(repository.getCacheDiagnostics().evictions).toBe(1);
    await repository.loadDecisionNetwork("known", 1);
    expect(repository.getCacheDiagnostics().misses).toBe(3);
    repository.invalidate();
    expect(repository.getCacheDiagnostics().residentBytes).toBe(0);
    await repository.loadDecisionNetwork("known", 1);
    expect(repository.getCacheDiagnostics().loads).toBe(4);
    await repository.close();
  });

  it("does not join or retain a load started before pack-version invalidation", async () => {
    const repository = open(createFixtureDatabase());
    const beforeInvalidation = repository.loadDecisionNetwork("known", 1);
    repository.invalidate();
    const afterInvalidation = repository.loadDecisionNetwork("known", 1);
    const [before, after] = await Promise.all([beforeInvalidation, afterInvalidation]);
    expect(after).not.toBe(before);
    expect(repository.getCacheDiagnostics()).toEqual(expect.objectContaining({
      misses: 2,
      concurrentLoadJoins: 0,
      loads: 2,
      residentBytes: after.estimatedByteSize,
    }));
    await repository.close();
  });
});
