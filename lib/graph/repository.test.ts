import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import policyFixture from "@/data/fixtures/graph/policy.json";
import mappedFixture from "@/data/fixtures/graph/tiny.json";
import { FixtureGraphRepository, type FixtureGraphData } from "./fixture-repository";
import { SQLiteGraphRepository } from "./sqlite-repository";

const policy = policyFixture as unknown as FixtureGraphData;
const mapped = mappedFixture as unknown as FixtureGraphData;
const WORLD_FIXTURE_BBOX = [-122.19, 37.15, -122.13, 37.18] as const;

describe("FixtureGraphRepository", () => {
  it("materializes reversible fixture trails with direction-aware gain and loss", async () => {
    const repository = new FixtureGraphRepository(mapped);
    const graph = await repository.getInducedGraph({ bbox: WORLD_FIXTURE_BBOX, includeUncertainAccess: false });
    expect(graph.edges).toHaveLength(mapped.undirectedTrails!.length * 2);
    const forward = graph.edges.find((edge) => edge.fromNodeId === "a" && edge.toNodeId === "b")!;
    const reverse = graph.edges.find((edge) => edge.fromNodeId === "b" && edge.toNodeId === "a")!;
    expect(forward.coordinates.length).toBeGreaterThan(2);
    expect(reverse.coordinates).toEqual([...forward.coordinates].reverse());
    expect(forward.gainMeters).toBe(20);
    expect(reverse.lossMeters).toBe(20);
  });

  it("enforces the hard geometry boundary and pedestrian/access policy", async () => {
    const repository = new FixtureGraphRepository(policy);
    const knownOnly = await repository.getInducedGraph({ bbox: [-0.1, -0.1, 0.1, 0.1], includeUncertainAccess: false });
    expect(knownOnly.edges.map(({ id }) => id)).toEqual(["one-way"]);
    expect(knownOnly.accessPoints.map(({ id }) => id)).toEqual(["public-start"]);

    const withUnknown = await repository.getInducedGraph({ bbox: [-0.1, -0.1, 0.1, 0.1], includeUncertainAccess: true });
    expect(withUnknown.edges.map(({ id }) => id)).toEqual(["one-way", "unknown"]);
    expect(withUnknown.accessPoints.map(({ id }) => id)).toEqual(["public-start", "unknown-start"]);
    expect(withUnknown.edges.some((edge) => edge.fromNodeId === "a" && edge.toNodeId === "s")).toBe(false);
  });

  it("honors cancellation before a graph query", async () => {
    const controller = new AbortController();
    controller.abort(new Error("stop"));
    const repository = new FixtureGraphRepository(mapped);
    await expect(
      repository.getInducedGraph({ bbox: WORLD_FIXTURE_BBOX, includeUncertainAccess: false, signal: controller.signal }),
    ).rejects.toThrow("stop");
  });

  it("loads a bounded reachable graph independently of the access filter", async () => {
    const repository = new FixtureGraphRepository(mapped);
    const candidates = await repository.getAccessPointCandidates({
      bbox: [-122.182, 37.161, -122.181, 37.162],
      includeUncertainAccess: true,
    });
    expect(candidates.map(({ id }) => id)).toEqual(["trailhead-a"]);
    const result = await repository.getReachableGraph({
      startNodeId: "a",
      maximumDistanceMeters: 10_000,
      maximumDirectedEdges: 10_000,
      includeUncertainAccess: true,
      coverage: {
        type: "Polygon",
        coordinates: [[
          [-122.19, 37.15], [-122.13, 37.15], [-122.13, 37.18], [-122.19, 37.18], [-122.19, 37.15],
        ]],
      },
    });
    expect(result.truncated).toBe(false);
    expect(result.graph.edges.length).toBe(mapped.undirectedTrails!.length * 2);
  });
});

describe("SQLiteGraphRepository", () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  it("opens a runtime pack read-only and applies the same induced-graph policy", async () => {
    const directory = mkdtempSync(join(tmpdir(), "alpine-sqlite-test-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "fixture.sqlite");
    const database = new DatabaseSync(databasePath);
    database.exec(`
      CREATE TABLE nodes (id TEXT PRIMARY KEY, lon REAL, lat REAL, elevation_m REAL, flags TEXT);
      CREATE VIRTUAL TABLE node_spatial USING rtree(row_id, min_lon, max_lon, min_lat, max_lat);
      CREATE TABLE edges (
        id TEXT PRIMARY KEY, from_node TEXT, to_node TEXT, geometry TEXT, length_m REAL,
        gain_m REAL, loss_m REAL, max_elevation_m REAL, max_sustained_grade_pct REAL,
        access_state TEXT, source_refs TEXT, flags TEXT
      );
      CREATE VIRTUAL TABLE edge_spatial USING rtree(row_id, min_lon, max_lon, min_lat, max_lat);
      CREATE TABLE access_points (
        id TEXT PRIMARY KEY, node_id TEXT, name TEXT, kind TEXT, access_state TEXT,
        confidence TEXT, parking_evidence TEXT, source_refs TEXT, nearby_building_count INTEGER NOT NULL
      );
      INSERT INTO nodes VALUES ('a', 0, 0, 10, '[]'), ('b', 0.01, 0, 20, '[]'), ('c', -0.01, 0, 5, '[]');
      INSERT INTO node_spatial VALUES (1, 0, 0, 0, 0), (2, 0.01, 0.01, 0, 0), (3, -0.01, -0.01, 0, 0);
      INSERT INTO edges VALUES
        ('public', 'a', 'b', '[[0,0],[0.01,0]]', 1000, 10, 0, 20, 4, 'public', '["source"]', '["trail-name:Public"]'),
        ('unknown', 'b', 'a', '[[0.01,0],[0,0]]', 1000, NULL, NULL, NULL, NULL, 'unknown', '["source"]', '[]'),
        ('outside', 'a', 'c', '[[0,0],[-0.2,0],[-0.01,0]]', 1000, 0, 5, 10, 4, 'public', '["source"]', '[]');
      INSERT INTO edge_spatial VALUES
        (1, 0, 0.01, 0, 0), (2, 0, 0.01, 0, 0), (3, -0.2, 0, 0, 0);
      INSERT INTO access_points VALUES
        ('known', 'a', 'Known', 'trailhead', 'public', 'high', 'lot', '["source"]', 0),
        ('uncertain', 'b', 'Uncertain', 'trailhead', 'unknown', 'low', NULL, '["source"]', 0);
    `);
    database.close();

    const repository = new SQLiteGraphRepository(databasePath, "sqlite-fixture");
    const known = await repository.getInducedGraph({ bbox: [-0.1, -0.1, 0.1, 0.1], includeUncertainAccess: false });
    expect(known.edges.map(({ id }) => id)).toEqual(["public"]);
    expect(known.edges[0].trailName).toBe("Public");
    expect(known.accessPoints.map(({ id }) => id)).toEqual(["known"]);
    const uncertain = await repository.getInducedGraph({ bbox: [-0.1, -0.1, 0.1, 0.1], includeUncertainAccess: true });
    expect(uncertain.edges.map(({ id }) => id)).toEqual(["public", "unknown"]);
    expect(uncertain.edges[1].gainMeters).toBe(0);
    expect(await repository.getAccessPoints([-0.1, -0.1, 0.1, 0.1], true)).toHaveLength(2);
    const candidates = await repository.getAccessPointCandidates({
      bbox: [-0.1, -0.1, 0.1, 0.1], includeUncertainAccess: true,
    });
    expect(candidates.map(({ id }) => id)).toEqual(["known", "uncertain"]);
    const reachable = await repository.getReachableGraph({
      startNodeId: "a",
      maximumDistanceMeters: 2_000,
      maximumDirectedEdges: 10,
      includeUncertainAccess: true,
      coverage: {
        type: "Polygon",
        coordinates: [[[-0.1, -0.1], [0.1, -0.1], [0.1, 0.1], [-0.1, 0.1], [-0.1, -0.1]]],
      },
    });
    expect(reachable.graph.edges.map(({ id }) => id)).toEqual(["public", "unknown"]);
    await repository.close();
    await repository.close();
  });
});
