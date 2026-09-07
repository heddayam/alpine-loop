import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import policy from "@/data/fixtures/graph/policy.json";
import { packManifestSchema } from "@/lib/contracts";
import { compilePack } from "@/lib/data/compiler";
import { fixtureCompileOptionsV6 } from "@/lib/data/fixture-pack";
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
    const artifact = await compilePack(await fixtureCompileOptionsV6(directory()));
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
