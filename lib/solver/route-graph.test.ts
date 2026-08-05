import { describe, expect, it } from "vitest";
import type { GenerateRoutesRequestV1 } from "@/lib/contracts";
import type { GraphEdge, GraphNode, InducedGraph } from "@/lib/graph";
import { graphForRouteRequest, rankEligibleStarts } from "./route-graph";

function edge(id: string, fromNodeId: string, toNodeId: string): GraphEdge {
  return {
    id, fromNodeId, toNodeId,
    coordinates: [[0, 0], [0.001, 0.001]],
    lengthMeters: 100,
    gainMeters: 0,
    lossMeters: 0,
    maximumElevationMeters: 10,
    maximumSustainedGradePct: 1,
    accessState: "public",
    trailName: null,
    sourceIds: ["osm"],
    flags: [],
  };
}

const request: GenerateRoutesRequestV1 = {
  version: 1,
  packId: "pack",
  bbox: [-1, -1, 1, 1],
  startAccessPointId: "start-a",
  routeTypes: ["loop"],
  distanceMiles: { min: 1, max: 2 },
  includeUncertainAccess: false,
  limit: 10,
};

function graph(): InducedGraph {
  const node = (id: string): [string, GraphNode] => [id, { id, lon: 0, lat: 0, elevationMeters: 10, flags: [] }];
  return {
    nodes: new Map([node("a"), node("b"), node("x"), node("y")]),
    edges: [edge("ab", "a", "b"), edge("ba", "b", "a"), edge("xy", "x", "y"), edge("yx", "y", "x")],
    accessPoints: [
      { id: "start-a", nodeId: "a", name: "A", kind: "parking", accessState: "public", confidence: "high", parkingEvidence: "parking", sourceIds: ["osm"] },
      { id: "start-x", nodeId: "x", name: "X", kind: "parking", accessState: "public", confidence: "low", parkingEvidence: "parking", sourceIds: ["osm"] },
    ],
  };
}

describe("route-distance graph reduction", () => {
  it("leaves a graph below the safety cap untouched", () => {
    const input = graph();
    expect(graphForRouteRequest(input, request, 4)).toBe(input);
  });

  it("keeps only edges reachable from an explicit start within the route distance", () => {
    const reduced = graphForRouteRequest(graph(), request, 2);
    expect(reduced.edges.map(({ id }) => id)).toEqual(["ab", "ba"]);
    expect(reduced.accessPoints.map(({ id }) => id)).toEqual(["start-a"]);
  });

  it("uses the highest-confidence automatic starts when rescuing an overlarge graph", () => {
    const reduced = graphForRouteRequest(graph(), { ...request, startAccessPointId: undefined }, 2);
    expect(reduced.edges.map(({ id }) => id)).toEqual(["ab", "ba"]);
  });

  it("prefers a connected automatic start over a better-labeled isolated point", () => {
    const input = graph();
    input.accessPoints.push({
      id: "start-isolated",
      nodeId: "isolated",
      name: "Beautiful Trailhead",
      kind: "trailhead",
      accessState: "public",
      confidence: "high",
      parkingEvidence: "parking",
      sourceIds: ["osm"],
    });
    input.nodes.set("isolated", {
      id: "isolated", lon: 0, lat: 0, elevationMeters: 10, flags: [],
    });
    expect(rankEligibleStarts(input, { ...request, startAccessPointId: undefined })[0]?.id).toBe("start-a");
  });

  it("does not count inaccessible edges when ranking automatic starts", () => {
    const input = graph();
    input.edges.push(
      { ...edge("isolated-private", "isolated", "private-neighbor"), accessState: "private" },
      { ...edge("private-isolated", "private-neighbor", "isolated"), accessState: "private" },
    );
    input.nodes.set("isolated", { id: "isolated", lon: 0, lat: 0, elevationMeters: 10, flags: [] });
    input.nodes.set("private-neighbor", { id: "private-neighbor", lon: 0, lat: 0, elevationMeters: 10, flags: [] });
    input.accessPoints.push({
      id: "start-isolated", nodeId: "isolated", name: "Beautiful Trailhead", kind: "trailhead",
      accessState: "public", confidence: "high", parkingEvidence: "parking", sourceIds: ["osm"],
    });
    expect(rankEligibleStarts(input, { ...request, startAccessPointId: undefined })[0]?.id).toBe("start-a");
  });

  it("prefers a better-connected start within the same component", () => {
    const input = graph();
    input.nodes.set("c", { id: "c", lon: 0, lat: 0, elevationMeters: 10, flags: [] });
    input.edges.push(edge("ac", "a", "c"), edge("ca", "c", "a"));
    input.accessPoints.push({
      id: "start-b", nodeId: "b", name: "B", kind: "parking", accessState: "public",
      confidence: "high", parkingEvidence: "parking", sourceIds: ["osm"],
    });
    expect(rankEligibleStarts(input, { ...request, startAccessPointId: undefined })[0]?.id).toBe("start-a");
  });
});
