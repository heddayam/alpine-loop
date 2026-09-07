import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { buildClosedRouteTopology, canonicalTopologyJson, topologyExtrema, topologySha256 } from "./topology-compiler";
import type { CompiledEdge, NormalizedAccessPoint, NormalizedNode } from "./types";

const builtAt = "2026-08-05T00:00:00Z";
const options = { builtAt, algorithmVersion: "test-topology-v1", policyVersion: "test-policy-v1" };

it("computes extrema for real-pack-sized blocks without argument spreading", () => {
  const values = Array.from({ length: 150_000 }, (_, index) => index - 75_000);
  expect(topologyExtrema(values)).toEqual({ minimum: -75_000, maximum: 74_999 });
});

it("indexes a long bridge forest without per-block full-edge scans", () => {
  const nodeCount = 4_000;
  const nodeIds = Array.from({ length: nodeCount }, (_, index) => `chain-${index.toString().padStart(5, "0")}`);
  const definitions = nodeIds.slice(1).map((nodeId, index) => ({
    physical: `bridge-${index.toString().padStart(5, "0")}`,
    from: nodeIds[index]!,
    to: nodeId,
  }));
  const input = graph(nodeIds, definitions, nodeIds[0]);
  const result = buildClosedRouteTopology(input.nodes, input.edges, input.accessPoints, options);
  expect(result.profiles[0]?.physicalEdgeCount).toBe(nodeCount - 1);
  expect(result.profiles[0]?.accessTopology[0]).toMatchObject({ canReachCycle: false });
});

function graph(nodeIds: string[], definitions: Array<{
  physical: string; from: string; to: string; access?: "public" | "unknown"; reverse?: boolean;
}>, accessNode?: string) {
  const nodes: NormalizedNode[] = nodeIds.map((id, index) => ({
    id, externalId: id, lon: index, lat: index % 2, elevationM: index * 10, flags: [], sourceRefs: ["fixture"],
  }));
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const edges: CompiledEdge[] = [];
  for (const definition of definitions) {
    const add = (from: string, to: string, direction: string) => {
      const a = byId.get(from)!, b = byId.get(to)!;
      edges.push({
        id: `${definition.physical}:${direction}`, stablePhysicalId: definition.physical,
        fromNode: from, toNode: to, geometry: [[a.lon, a.lat], [b.lon, b.lat]], lengthM: 100,
        gainM: 10, lossM: 0, maxElevationM: Math.max(a.elevationM!, b.elevationM!), maxSustainedGradePct: 10,
        accessState: definition.access ?? "public", sourceRefs: ["fixture"], flags: ["trail-name:fixture-trail"],
      });
    };
    add(definition.from, definition.to, "forward");
    if (definition.reverse !== false) add(definition.to, definition.from, "reverse");
  }
  const accessPoints: NormalizedAccessPoint[] = accessNode ? [{
    id: `access-${accessNode}`, externalId: `access-${accessNode}`, nodeId: accessNode, name: accessNode,
    kind: "trailhead", accessState: "public", confidence: "high", parkingEvidence: null, sourceRefs: ["fixture"],
  }] : [];
  return { nodes, edges, accessPoints };
}

describe("closed-route topology compiler", () => {
  it("streams the exact recursively key-sorted canonical JSON hash", () => {
    const value = { z: [{ b: 2, a: 1 }], a: "value" };
    expect(topologySha256(value)).toBe(`sha256:${createHash("sha256").update(canonicalTopologyJson(value)).digest("hex")}`);
  });
  it("treats parallel physical edges as cycle-bearing rather than bridges", () => {
    const input = graph(["a", "b"], [
      { physical: "lower", from: "a", to: "b" },
      { physical: "upper", from: "a", to: "b" },
    ], "a");
    const profile = buildClosedRouteTopology(input.nodes, input.edges, input.accessPoints, options).profiles[0]!;
    expect(profile.physicalEdgeCount).toBe(2);
    expect(profile.accessTopology[0]).toMatchObject({ canReachCycle: true, minimumStemDistanceM: 0 });
  });

  it("recognizes access to cycles that share an articulation", () => {
    const input = graph(["a", "b", "c", "d", "e"], [
      { physical: "ab", from: "a", to: "b" }, { physical: "bc", from: "b", to: "c" }, { physical: "ca", from: "c", to: "a" },
      { physical: "cd", from: "c", to: "d" }, { physical: "de", from: "d", to: "e" }, { physical: "ec", from: "e", to: "c" },
    ], "a");
    const profile = buildClosedRouteTopology(input.nodes, input.edges, input.accessPoints, options).profiles[0]!;
    expect(profile.physicalEdgeCount).toBe(6);
    expect(profile.accessTopology[0]).toMatchObject({ canReachCycle: true, minimumStemDistanceM: 0 });
  });

  it("does not report an undirected cycle as feasible when directed SCC legality forbids a closed traversal", () => {
    const input = graph(["a", "b", "c"], [
      { physical: "ab", from: "a", to: "b", reverse: false },
      { physical: "cb", from: "c", to: "b", reverse: false },
      { physical: "ca", from: "c", to: "a", reverse: false },
    ], "a");
    const profile = buildClosedRouteTopology(input.nodes, input.edges, input.accessPoints, options).profiles[0]!;
    expect(profile.accessTopology[0]).toMatchObject({ canReachCycle: false, cycleNetworkId: null, portalDecisionNodeId: null });
  });

  it("retains the minimum access stem and cycle portal without persisting a connector graph", () => {
    const input = graph(["access", "a", "b", "c"], [
      { physical: "stem", from: "access", to: "a" },
      { physical: "ab", from: "a", to: "b" }, { physical: "bc", from: "b", to: "c" }, { physical: "ca", from: "c", to: "a" },
    ], "access");
    const profile = buildClosedRouteTopology(input.nodes, input.edges, input.accessPoints, options).profiles[0]!;
    const access = profile.accessTopology[0]!;
    expect(access).toMatchObject({ canReachCycle: true, minimumStemDistanceM: 100 });
    expect(access.connectorDecisionEdgeIds).toEqual([]);
    expect(access.connectorKey).toMatch(/^sha256:/);
    expect(access.portalDecisionNodeId).not.toBeNull();
  });

  it("builds distinct known and inclusive feasibility profiles deterministically", () => {
    const input = graph(["a", "b"], [
      { physical: "known", from: "a", to: "b" },
      { physical: "uncertain", from: "a", to: "b", access: "unknown" },
    ], "a");
    const first = buildClosedRouteTopology(input.nodes, input.edges, input.accessPoints, options);
    const second = buildClosedRouteTopology([...input.nodes].reverse(), [...input.edges].reverse(), input.accessPoints, options);
    expect(first.contentHash).toBe(second.contentHash);
    expect(first.profiles[0]!.accessTopology[0]!.canReachCycle).toBe(false);
    expect(first.profiles[1]!.accessTopology[0]!.canReachCycle).toBe(true);
    expect(first.profiles[0]!.physicalEdgeCount).toBe(1);
    expect(first.profiles[1]!.physicalEdgeCount).toBe(2);
    expect(first.edgeKeys).toEqual(second.edgeKeys);
  });
});
