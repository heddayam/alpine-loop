import { topologySha256 } from "@/lib/graph/topology-hash";
import { CLOSED_ROUTE_TOPOLOGY_ALGORITHM_VERSION } from "@/lib/graph/closed-route-topology";
import { describe, expect, it } from "vitest";
import { buildClosedRouteTopology } from "./topology-compiler";
import type { CompiledEdge, NormalizedAccessPoint, NormalizedNode } from "./types";

const builtAt = "2026-08-05T00:00:00Z";
const options = { builtAt, algorithmVersion: "test-topology-v1", policyVersion: "test-policy-v1" };

it("indexes a long bridge forest without per-block full-edge scans", () => {
  const nodeCount = 20_000;
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
  const cycle = graph(nodeIds, [...definitions, { physical: "closing", from: nodeIds.at(-1)!, to: nodeIds[0]! }], nodeIds[0]);
  expect(buildClosedRouteTopology(cycle.nodes, cycle.edges, cycle.accessPoints, options).profiles[0]!.accessTopology[0])
    .toMatchObject({ canReachCycle: true, minimumStemDistanceM: 0 });
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

it("keeps the 100 m approach when a one-way dead-end triangle is attached at the start", () => {
  const input = graph(["s", "t", "u", "v", "x", "y"], [
    { physical: "stem", from: "s", to: "t" },
    { physical: "tu", from: "t", to: "u" }, { physical: "uv", from: "u", to: "v" }, { physical: "vt", from: "v", to: "t" },
    { physical: "sx", from: "s", to: "x", reverse: false }, { physical: "xy", from: "x", to: "y", reverse: false },
    { physical: "sy", from: "s", to: "y", reverse: false },
  ], "s");
  const result = buildClosedRouteTopology(input.nodes, input.edges, input.accessPoints, options);
  for (const profile of result.profiles) {
    expect(profile.accessTopology[0]).toMatchObject({ minimumStemDistanceM: 100, canReachCycle: true,
      attachmentDecisionNodeId: 1, cycleNetworkId: 1, portalDecisionNodeId: 2 });
    expect(profile).toMatchObject({ formatVersion: 2, nodeCount: 0, decisionNodeCount: 0, decisionEdgeCount: 0,
      nodes: [], decisionEdges: [], blocks: [], blockLinks: [], networks: [] });
  }
});

it("recognizes a true one-way cycle but requires a legal return along its access tail", () => {
  const input = graph(["a", "b", "c", "tail"], [
    { physical: "ab", from: "a", to: "b", reverse: false }, { physical: "bc", from: "b", to: "c", reverse: false },
    { physical: "ca", from: "c", to: "a", reverse: false }, { physical: "tail", from: "tail", to: "a", reverse: false },
  ], "a");
  input.accessPoints.push({ ...input.accessPoints[0]!, id: "tail", nodeId: "tail" });
  const [cycle, tail] = buildClosedRouteTopology(input.nodes, input.edges, input.accessPoints, options).profiles[0]!.accessTopology;
  expect(cycle).toMatchObject({ canReachCycle: true, minimumStemDistanceM: 0 });
  expect(tail).toMatchObject({ canReachCycle: false, minimumStemDistanceM: null, cycleNetworkId: null,
    portalDecisionNodeId: null, connectorKey: null, connectorDecisionEdgeIds: [] });
});

it("keeps bridge stems between two loops and selects the smallest original portal on equal distances", () => {
  const input = graph(["a", "b", "c", "middle", "x", "y", "z"], [
    { physical: "ab", from: "a", to: "b" }, { physical: "bc", from: "b", to: "c" }, { physical: "ca", from: "c", to: "a" },
    { physical: "left", from: "middle", to: "c" }, { physical: "right", from: "middle", to: "x" },
    { physical: "xy", from: "x", to: "y" }, { physical: "yz", from: "y", to: "z" }, { physical: "zx", from: "z", to: "x" },
  ], "middle");
  const result = buildClosedRouteTopology(input.nodes, input.edges, input.accessPoints, options);
  expect(result.profiles[0]!.accessTopology[0]).toMatchObject({ canReachCycle: true, minimumStemDistanceM: 100,
    attachmentDecisionNodeId: 4, cycleNetworkId: 1, portalDecisionNodeId: 3 });
  expect(buildClosedRouteTopology([...input.nodes].reverse(), [...input.edges].reverse(), input.accessPoints, options)).toEqual(result);
});

it("recognizes self-loops and reconstructs ordered original connectors across zero-length ties", () => {
  const input = graph(["a", "b", "c"], [
    { physical: "first", from: "a", to: "b" }, { physical: "second", from: "b", to: "c" },
    { physical: "loop", from: "c", to: "c", reverse: false },
  ], "a");
  input.edges.forEach((edge) => { edge.lengthM = 0; });
  const result = buildClosedRouteTopology(input.nodes, input.edges, input.accessPoints, options);
  expect(result.profiles[0]!.accessTopology[0]).toMatchObject({ canReachCycle: true, minimumStemDistanceM: 0,
    portalDecisionNodeId: 3, connectorKey: topologySha256({ algorithmVersion: CLOSED_ROUTE_TOPOLOGY_ALGORITHM_VERSION,
      directedEdgeIds: ["first:forward", "second:forward"] }) });
});

it("keeps identities independent of metadata, build time and unrelated known-profile changes", () => {
  const input = graph(["a", "b", "c", "d", "e"], [
    { physical: "stem", from: "a", to: "b" }, { physical: "loop", from: "b", to: "b", reverse: false },
    { physical: "uncertain", from: "d", to: "e", access: "unknown" },
  ], "a");
  const original = buildClosedRouteTopology(input.nodes, input.edges, input.accessPoints, options);
  const decorated = buildClosedRouteTopology(input.nodes, input.edges.map((edge) => ({ ...edge,
    flags: ["trail-name:renamed"], sourceRefs: ["new-source"], gainM: 999 })), input.accessPoints, { ...options, builtAt: "later" });
  expect(decorated.contentHash).toBe(original.contentHash);
  const knownChanged = buildClosedRouteTopology(input.nodes, input.edges.map((edge) => ({ ...edge, accessState: "public" })), input.accessPoints, options);
  expect(knownChanged.profiles[0]!.contentHash).not.toBe(original.profiles[0]!.contentHash);
  expect(knownChanged.profiles[1]).toEqual(original.profiles[1]);
});

it("excludes context roads and restricted trails from physical cycle feasibility", () => {
  const input = graph(["a", "b"], [
    { physical: "trail", from: "a", to: "b" }, { physical: "other", from: "a", to: "b" },
  ], "a");
  for (const patch of [{ edgeClass: "street" as const }, { accessState: "private" as const }]) {
    const result = buildClosedRouteTopology(input.nodes, input.edges.map((edge) => edge.stablePhysicalId === "other" ? { ...edge, ...patch } : edge), input.accessPoints, options);
    expect(result.profiles.map((profile) => profile.accessTopology[0]!.canReachCycle)).toEqual([false, false]);
  }
});

it("rejects malformed graph identities, physical geometry, lengths and attachments explicitly", () => {
  const input = graph(["a", "b", "c"], [{ physical: "ab", from: "a", to: "b" }], "a");
  const build = (nodes = input.nodes, edges = input.edges, points = input.accessPoints) => buildClosedRouteTopology(nodes, edges, points, options);
  expect(() => build([...input.nodes, input.nodes[0]!])).toThrow("unique stable node IDs");
  expect(() => build(input.nodes, [...input.edges, input.edges[0]!])).toThrow("unique stable directed edge IDs");
  expect(() => build(input.nodes, [{ ...input.edges[0]!, fromNode: "missing" }])).toThrow("unknown node");
  expect(() => build(input.nodes, [input.edges[0]!, { ...input.edges[1]!, fromNode: "c" }])).toThrow("inconsistent endpoints");
  expect(() => build(input.nodes, [input.edges[0]!, { ...input.edges[1]!, geometry: [[3, 4], [5, 6]] }])).toThrow("inconsistent geometry");
  expect(() => build(input.nodes, [{ ...input.edges[0]!, lengthM: -1 }])).toThrow("nonnegative length");
  expect(() => build(input.nodes, input.edges, [{ ...input.accessPoints[0]!, nodeId: "missing" }])).toThrow("unknown node");
});

// Independent bounded oracle: all-pairs distances and edge-removal reachability,
// rather than SCC traversal, low links or Dijkstra. This checks tiny multigraphs.
it("agrees with an independent oracle across 80 deterministic tiny directed graphs", () => {
  let randomState = 7183;
  const random = (maximum: number) => { randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0; return randomState % maximum; };
  for (let sample = 0; sample < 80; sample += 1) {
    const ids = ["a", "b", "c", "d", "e"];
    const definitions = Array.from({ length: 8 }, (_, index) => ({ physical: `edge-${index}`,
      from: ids[random(5)]!, to: ids[random(5)]!, reverse: random(2) === 0, access: random(3) ? "public" as const : "unknown" as const }));
    const input = graph(ids, definitions, "a");
    input.edges.forEach((edge) => { edge.lengthM = random(5); });
    input.accessPoints = ids.map((id) => ({ ...input.accessPoints[0]!, id, nodeId: id }));
    const result = buildClosedRouteTopology(input.nodes, input.edges, input.accessPoints, options);
    for (const profile of result.profiles) {
      const edges = input.edges.filter((edge) => profile.profile === "inclusive" || edge.accessState === "public");
      const distance = ids.map((_, i) => ids.map((_, j) => i === j ? 0 : Infinity));
      for (const edge of edges) {
        const a = ids.indexOf(edge.fromNode), b = ids.indexOf(edge.toNode);
        distance[a]![b] = Math.min(distance[a]![b]!, edge.lengthM);
      }
      for (let k = 0; k < 5; k += 1) for (let i = 0; i < 5; i += 1) for (let j = 0; j < 5; j += 1) {
        distance[i]![j] = Math.min(distance[i]![j]!, distance[i]![k]! + distance[k]![j]!);
      }
      const mutual = (a: number, b: number) => Number.isFinite(distance[a]![b]! + distance[b]![a]!);
      const physical = definitions.filter((edge) => (profile.profile === "inclusive" || edge.access === "public")
        && mutual(ids.indexOf(edge.from), ids.indexOf(edge.to)));
      const cycle = new Set<number>();
      for (const removed of physical) {
        const reachable = new Set([removed.from]);
        for (let step = 0; step < 5; step += 1) for (const edge of physical) if (edge !== removed) {
          if (reachable.has(edge.from)) reachable.add(edge.to);
          if (reachable.has(edge.to)) reachable.add(edge.from);
        }
        if (reachable.has(removed.to)) { cycle.add(ids.indexOf(removed.from)); cycle.add(ids.indexOf(removed.to)); }
      }
      for (let i = 0; i < 5; i += 1) {
        const expected = Math.min(...[...cycle].filter((node) => mutual(i, node)).map((node) => distance[i]![node]!));
        expect(profile.accessTopology[i], `sample ${sample}, ${profile.profile}, ${ids[i]}`).toMatchObject({
          canReachCycle: Number.isFinite(expected), minimumStemDistanceM: Number.isFinite(expected) ? expected : null,
        });
      }
    }
  }
});
