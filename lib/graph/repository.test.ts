import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import policy from "@/data/fixtures/graph/policy.json";
import { packManifestSchema } from "@/lib/contracts";
import { compilePack } from "@/lib/data/compiler";
import { fixtureCompileOptions } from "@/lib/data/fixture-pack";
import { lineLengthMeters } from "./geometry";
import { writeGraphFixture } from "./test-helpers";
import type { GraphEdge, InducedGraph } from "./types";
import { SQLiteGraphRepository } from "./sqlite-repository";

const temporaryDirectories: string[] = [];
const repositories: SQLiteGraphRepository[] = [];
afterEach(async () => {
  for (const repository of repositories.splice(0)) await repository.close();
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function directory() {
  const path = mkdtempSync(join(tmpdir(), "sqlite-graph-"));
  temporaryDirectories.push(path);
  return path;
}

function policyGraph(): InducedGraph {
  const nodes = new Map(policy.nodes.map((node) => [node.id, node]));
  return {
    nodes,
    edges: policy.directedEdges.map((edge): GraphEdge => {
      const from = nodes.get(edge.fromNodeId)!;
      const to = nodes.get(edge.toNodeId)!;
      const coordinates = (edge.coordinates ?? [[from.lon, from.lat], [to.lon, to.lat]]) as [number, number][];
      return { ...edge, coordinates, lengthMeters: lineLengthMeters(coordinates),
        gainMeters: Math.max(0, to.elevationMeters - from.elevationMeters),
        lossMeters: Math.max(0, from.elevationMeters - to.elevationMeters),
        maximumElevationMeters: Math.max(from.elevationMeters, to.elevationMeters), maximumSustainedGradePct: 4,
        accessState: edge.accessState as GraphEdge["accessState"], sourceIds: ["fixture"], flags: edge.flags ?? [] };
    }),
    accessPoints: policy.accessPoints.map((point) => ({ ...point, nearbyBuildingCount: 0,
      kind: point.kind as "trailhead", accessState: point.accessState as "public" | "unknown" | "private",
      confidence: point.confidence as "high" | "medium" | "low" })),
  };
}

function open(graph = policyGraph(), mutate?: (database: DatabaseSync) => void) {
  const databasePath = join(directory(), "pack.sqlite");
  const manifest = writeGraphFixture(databasePath, graph);
  if (mutate) {
    const database = new DatabaseSync(databasePath);
    try { mutate(database); } finally { database.close(); }
  }
  const repository = new SQLiteGraphRepository(databasePath, manifest.id);
  repositories.push(repository);
  return repository;
}

const bbox = [-0.1, -0.1, 0.1, 0.1] as const;
const coverage = { type: "Polygon" as const, coordinates: [[[-0.1, -0.1], [0.1, -0.1], [0.1, 0.1], [-0.1, 0.1], [-0.1, -0.1]]] };

describe("SQLiteGraphRepository", () => {
  it("streams the same physical display edges as the graph path, including policy and complete containment", async () => {
    const graph = policyGraph();
    const edge = graph.edges[0];
    graph.edges.push({ ...edge, id: "00-reverse", fromNodeId: edge.toNodeId, toNodeId: edge.fromNodeId,
      coordinates: [...edge.coordinates].reverse(), physicalEdgeKey: 1 });
    graph.edges[0] = { ...edge, physicalEdgeKey: 1 };
    graph.edges.push({ ...edge, id: "road", edgeClass: "service-road" });
    // Geometry is inside, but its referenced endpoint node is outside the viewport.
    graph.nodes.set("outside", { id: "outside", lon: 1, lat: 1, elevationMeters: 10, flags: [] });
    graph.edges.push({ ...edge, id: "outside-node", toNodeId: "outside" });
    const repository = open(graph);
    for (const includeUncertainAccess of [false, true]) {
      const query = { bbox, includeUncertainAccess };
      const full = await repository.getInducedGraph(query);
      const seen = new Set<number | undefined>();
      const expected = full.edges.filter(({ physicalEdgeKey }) => {
        if (seen.has(physicalEdgeKey)) return false;
        seen.add(physicalEdgeKey);
        return true;
      }).map(({ id, physicalEdgeKey, coordinates, lengthMeters, trailName, accessState, sourceIds, edgeClass, flags }) =>
        ({ id, physicalEdgeKey, coordinates, lengthMeters, trailName, accessState, sourceIds, edgeClass, flags }));
      const actual = [];
      for await (const trail of repository.iterateMapTrails(query)) actual.push(trail);
      expect(actual).toEqual(expected);
      expect(actual.map(({ id }) => id)).toEqual(includeUncertainAccess ? ["00-reverse", "unknown"] : ["00-reverse"]);
      expect(actual[0]).not.toHaveProperty("elevationProfile");
    }
    const restrictedReverse = open(graph, (database) => database.exec("UPDATE edges SET access_state = 'private' WHERE id = '00-reverse'"));
    const ids = [];
    for await (const edge of restrictedReverse.iterateMapTrails({ bbox, includeUncertainAccess: true })) ids.push(edge.id);
    expect(ids).toEqual(["one-way", "unknown"]);
  });

  it("yields for cancellation and releases its SQLite iterator before the repository closes", async () => {
    const graph = policyGraph();
    graph.edges = Array.from({ length: 600 }, (_, index) => ({ ...graph.edges[0], id: `edge-${index}` }));
    const repository = open(graph);
    const controller = new AbortController();
    let visited = 0;
    const timer = setImmediate(() => controller.abort(new Error("stop streamed map")));
    try {
      await expect((async () => {
        for await (const edge of repository.iterateMapTrails({ bbox, includeUncertainAccess: true, signal: controller.signal })) {
          expect(edge.id).toBeTruthy();
          visited += 1;
        }
      })()).rejects.toThrow("stop streamed map");
      expect(visited).toBeGreaterThan(0);
      expect(visited).toBeLessThan(600);
      await expect(repository.close()).resolves.toBeUndefined();
    } finally { clearImmediate(timer); }
    const early = open();
    for await (const edge of early.iterateMapTrails({ bbox, includeUncertainAccess: true })) {
      expect(edge.id).toBe("one-way");
      break;
    }
    await expect(early.close()).resolves.toBeUndefined();
  });

  it("does not load solver metrics while displaying trails", async () => {
    const repository = open(undefined, (database) => database.exec("UPDATE edges SET elevation_profile = 'not-json'"));
    const ids = [];
    for await (const edge of repository.iterateMapTrails({ bbox, includeUncertainAccess: true })) ids.push(edge.id);
    expect(ids).toEqual(["one-way", "unknown"]);
  });

  it("enforces pedestrian policy, uncertain access, and complete geometry containment", async () => {
    const repository = open();
    const known = await repository.getInducedGraph({ bbox, includeUncertainAccess: false });
    expect(known.edges.map(({ id }) => id)).toEqual(["one-way"]);
    expect(known.edges[0].trailName).toBe("One Way");
    expect(known.accessPoints.map(({ id }) => id)).toEqual(["public-start"]);
    const inclusive = await repository.getInducedGraph({ bbox, includeUncertainAccess: true });
    expect(inclusive.edges.map(({ id }) => id)).toEqual(["one-way", "unknown"]);
    expect(inclusive.accessPoints.map(({ id }) => id)).toEqual(["public-start", "unknown-start"]);
    expect(inclusive.edges.every(({ edgeKey, physicalEdgeKey }) => Number.isInteger(edgeKey) && Number.isInteger(physicalEdgeKey))).toBe(true);
  });

  it("loads beyond the access-point area, preserves one-way edges, and reports graph limits", async () => {
    const repository = open();
    const candidates = await repository.getAccessPointCandidates({ bbox: [-0.001, -0.001, 0.001, 0.001], includeUncertainAccess: true });
    expect(candidates.map(({ id }) => id)).toEqual(["public-start"]);
    const query = { startNodeId: "s", maximumDistanceMeters: 10_000, maximumDirectedEdges: 10, includeUncertainAccess: true, coverage };
    const reachable = await repository.getReachableGraph(query);
    expect(reachable.graph.edges.map(({ id }) => id)).toEqual(["one-way", "unknown"]);
    expect(reachable.graph.edges.some(({ toNodeId }) => toNodeId === "s")).toBe(false);
    expect(reachable.truncated).toBe(false);
    expect((await repository.getReachableGraph({ ...query, maximumDirectedEdges: 1 })).truncated).toBe(true);
    expect((await repository.getReachableGraph({ ...query, maximumDistanceMeters: 1_200 })).graph.edges.map(({ id }) => id)).toEqual(["one-way"]);
    const controller = new AbortController();
    controller.abort(new Error("stop"));
    await expect(repository.getReachableGraph({ ...query, signal: controller.signal })).rejects.toThrow("stop");
    await expect(repository.getInducedGraph({ bbox, includeUncertainAccess: true, signal: controller.signal })).rejects.toThrow("stop");
    await expect(repository.getAccessPointCandidates({ bbox, includeUncertainAccess: true, signal: controller.signal })).rejects.toThrow("stop");
  });

  it("reads a current compiled fixture with direction-aware profiles and nullable parking", async () => {
    const artifact = await compilePack(await fixtureCompileOptions(directory()));
    const manifest = packManifestSchema.parse(JSON.parse(readFileSync(artifact.manifestPath, "utf8")));
    const repository = new SQLiteGraphRepository(artifact.databasePath, manifest.id);
    repositories.push(repository);
    const graph = await repository.getInducedGraph({ bbox: manifest.coverage.bbox, includeUncertainAccess: true });
    expect(graph.edges.length).toBeGreaterThan(0);
    const forward = graph.edges.find((edge) => graph.edges.some((other) => other.id !== edge.id && other.physicalEdgeKey === edge.physicalEdgeKey))!;
    const reverse = graph.edges.find((edge) => edge.id !== forward.id && edge.physicalEdgeKey === forward.physicalEdgeKey)!;
    expect(reverse.coordinates).toEqual([...forward.coordinates].reverse());
    expect(reverse.gainMeters).toBe(forward.lossMeters);
    expect(reverse.lossMeters).toBe(forward.gainMeters);
    expect(forward.elevationProfile!.length).toBeGreaterThan(1);
    expect(reverse.elevationProfile!.map(({ elevationMeters }) => elevationMeters)).toEqual([...forward.elevationProfile!].reverse().map(({ elevationMeters }) => elevationMeters));
    const candidates = await repository.getAccessPointCandidates({ bbox: manifest.coverage.bbox, includeUncertainAccess: true });
    expect(candidates.every(({ canReachCycle }) => typeof canReachCycle === "boolean")).toBe(true);
    expect(candidates.some(({ parkingDistanceM }) => parkingDistanceM === null)).toBe(true);
  });

  it("rejects incomplete current layouts instead of fabricating rankings or identities", () => {
    expect(() => open(undefined, (database) => database.exec("ALTER TABLE access_points DROP COLUMN known_connectivity"))).toThrow(/corruption.*known_connectivity.*Rebuild/);
    expect(() => open(undefined, (database) => database.exec("DROP TABLE edge_spatial"))).toThrow(/corruption.*edge_spatial.*Rebuild/);
    expect(() => open(undefined, (database) => database.exec("UPDATE metadata SET value = '5' WHERE key = 'schemaVersion'"))).toThrow(/expected schema version 6/);
  });

  it("rejects missing per-start topology and preserves legitimate nullable road metrics", async () => {
    const repository = open(undefined, (database) => {
      database.exec("DELETE FROM access_topology WHERE access_point_id = 'public-start' AND profile = 'inclusive'");
    });
    await expect(repository.getAccessPointCandidates({ bbox, includeUncertainAccess: true })).rejects.toThrow(/can_reach_cycle/);
    const roads = open(undefined, (database) => database.exec("UPDATE edges SET edge_class = 'service-road', elevation_profile = NULL, gain_m = NULL, loss_m = NULL, max_elevation_m = NULL"));
    expect((await roads.getReachableGraph({ startNodeId: "s", maximumDistanceMeters: 10_000, maximumDirectedEdges: 10, includeUncertainAccess: true, coverage })).graph.edges).toEqual([]);
    await roads.close();
    await roads.close();
  });
});
