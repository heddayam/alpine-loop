import { describe, expect, it } from "vitest";
import type { GraphAccessPoint, GraphEdge, GraphNode, InducedGraph } from "@/lib/graph";
import {
  compressSearchGraph,
  expandCompressedPath,
  expandCompressedTraversal,
} from "./compressed-graph";

function node(id: string, elevationMeters = 100): GraphNode {
  const coordinate = id.charCodeAt(0) - 65;
  return { id, lon: coordinate, lat: 0, elevationMeters, flags: [] };
}

function edge(
  id: string,
  fromNodeId: string,
  toNodeId: string,
  overrides: Partial<GraphEdge> = {},
): GraphEdge {
  const fromCoordinate = fromNodeId.charCodeAt(0) - 65;
  const toCoordinate = toNodeId.charCodeAt(0) - 65;
  return {
    id,
    fromNodeId,
    toNodeId,
    coordinates: [[fromCoordinate, 0], [toCoordinate, 0]],
    lengthMeters: 100,
    gainMeters: 10,
    lossMeters: 2,
    maximumElevationMeters: 120,
    maximumSustainedGradePct: 8,
    accessState: "public",
    trailName: "Ridge Trail",
    sourceIds: [`source-${id}`],
    flags: ["coverage-safe"],
    ...overrides,
  };
}

function accessPoint(id: string, nodeId: string): GraphAccessPoint {
  return {
    id,
    nodeId,
    name: id,
    kind: "trailhead",
    accessState: "public",
    confidence: "high",
    parkingEvidence: null,
    sourceIds: [],
  };
}

function graph(
  nodeIds: string[],
  edges: GraphEdge[],
  accessPoints: GraphAccessPoint[] = [],
): InducedGraph {
  return {
    nodes: new Map(nodeIds.map((id) => [id, node(id)])),
    edges,
    accessPoints,
  };
}

describe("compressSearchGraph", () => {
  it("compresses a bidirectional degree-two chain deterministically", () => {
    const edges = [
      edge("bc", "B", "C"),
      edge("ab", "A", "B"),
      edge("cb", "C", "B"),
      edge("ba", "B", "A"),
    ];

    const compressed = compressSearchGraph(graph(["A", "B", "C"], edges));
    const reordered = compressSearchGraph(graph(["A", "B", "C"], [...edges].reverse()));

    expect([...compressed.nodes.keys()]).toEqual(["A", "C"]);
    expect(compressed.traversals).toHaveLength(2);
    expect(compressed.traversals.map(({ edge: aggregate }) => aggregate.id)).toEqual(
      reordered.traversals.map(({ edge: aggregate }) => aggregate.id),
    );
    expect(compressed.adjacency.get("A")?.[0]?.originalTraversals.map(({ edge: item }) => item.id)).toEqual([
      "ab",
      "bc",
    ]);
    expect(compressed.adjacency.get("C")?.[0]?.originalTraversals.map(({ edge: item }) => item.id)).toEqual([
      "cb",
      "ba",
    ]);
  });

  it("retains forks and does not merge alternative branches", () => {
    const compressed = compressSearchGraph(
      graph(["A", "B", "C", "D"], [
        edge("ab", "A", "B"),
        edge("ba", "B", "A"),
        edge("bc", "B", "C"),
        edge("cb", "C", "B"),
        edge("bd", "B", "D"),
        edge("db", "D", "B"),
      ]),
    );

    expect([...compressed.nodes.keys()]).toEqual(["A", "B", "C", "D"]);
    expect(compressed.traversals).toHaveLength(6);
    expect(compressed.adjacency.get("B")?.map(({ to }) => to.id)).toEqual(["A", "C", "D"]);
  });

  it("compresses a legal one-way chain without inventing reverse travel", () => {
    const compressed = compressSearchGraph(
      graph(["A", "B", "C", "D"], [
        edge("ab", "A", "B"),
        edge("bc", "B", "C"),
        edge("cd", "C", "D"),
      ]),
    );

    expect([...compressed.nodes.keys()]).toEqual(["A", "D"]);
    expect(compressed.traversals).toHaveLength(1);
    expect(compressed.traversals[0]?.from.id).toBe("A");
    expect(compressed.traversals[0]?.to.id).toBe("D");
    expect(compressed.adjacency.has("D")).toBe(false);
  });

  it("retains an asymmetric direction break as a decision node", () => {
    const compressed = compressSearchGraph(
      graph(["A", "B", "C"], [
        edge("ab", "A", "B"),
        edge("bc", "B", "C"),
        edge("cb", "C", "B"),
      ]),
    );

    expect([...compressed.nodes.keys()]).toEqual(["A", "B", "C"]);
    expect(compressed.traversals.map(({ originalTraversals }) => originalTraversals.map(({ edge: item }) => item.id))).toEqual([
      ["ab"],
      ["bc"],
      ["cb"],
    ]);
  });

  it("retains access-point nodes that occur inside a chain", () => {
    const compressed = compressSearchGraph(
      graph(
        ["A", "B", "C", "D"],
        [
          edge("ab", "A", "B"), edge("ba", "B", "A"),
          edge("bc", "B", "C"), edge("cb", "C", "B"),
          edge("cd", "C", "D"), edge("dc", "D", "C"),
        ],
        [accessPoint("middle trailhead", "C")],
      ),
    );

    expect([...compressed.nodes.keys()]).toEqual(["A", "C", "D"]);
    expect(compressed.accessPoints[0]?.nodeId).toBe("C");
    expect(compressed.adjacency.get("A")?.[0]?.to.id).toBe("C");
    expect(compressed.adjacency.get("C")?.some(({ to }) => to.id === "A")).toBe(true);
  });

  it("preserves aggregate metrics, geometry, coverage flags, and provenance", () => {
    const first = edge("ab", "A", "B", {
      lengthMeters: 80,
      gainMeters: 12,
      lossMeters: 1,
      maximumElevationMeters: 125,
      maximumSustainedGradePct: 7,
      sourceIds: ["z", "a"],
      flags: ["coverage-safe", "bridge"],
    });
    const second = edge("bc", "B", "C", {
      coordinates: [[1, 0], [1.5, 0.25], [2, 0]],
      lengthMeters: 120,
      gainMeters: 3,
      lossMeters: 9,
      maximumElevationMeters: 140,
      maximumSustainedGradePct: 11,
      accessState: "unknown",
      sourceIds: ["a", "m"],
      flags: ["coverage-safe", "stairs"],
    });

    const compressed = compressSearchGraph(graph(["A", "B", "C"], [first, second]));
    const aggregate = compressed.traversals[0]!.edge;

    expect(aggregate).toMatchObject({
      fromNodeId: "A",
      toNodeId: "C",
      lengthMeters: 200,
      gainMeters: 15,
      lossMeters: 10,
      maximumElevationMeters: 140,
      maximumSustainedGradePct: 11,
      accessState: "unknown",
      sourceIds: ["a", "m", "z"],
      flags: ["bridge", "coverage-safe", "stairs"],
    });
    expect(aggregate.coordinates).toEqual([[0, 0], [1, 0], [1.5, 0.25], [2, 0]]);
  });

  it("expands compressed paths back to the exact original traversal objects", () => {
    const edges = [
      edge("ab", "A", "B"),
      edge("bc", "B", "C"),
      edge("cd", "C", "D"),
      edge("de", "D", "E"),
    ];
    const compressed = compressSearchGraph(
      graph(["A", "B", "C", "D", "E"], edges, [accessPoint("junction", "C")]),
    );
    const path = [compressed.adjacency.get("A")![0]!, compressed.adjacency.get("C")![0]!];
    const expanded = expandCompressedPath(path);

    expect(expanded.map(({ edge: item }) => item.id)).toEqual(["ab", "bc", "cd", "de"]);
    expect(expanded.map(({ edge: item }) => item)).toEqual(edges);
    expect(expandCompressedTraversal(path[0]!)).toEqual(expanded.slice(0, 2));
    expect(compressed.originalDirectedEdgeCount).toBe(edges.length);
  });

  it("keeps a deterministic anchor for an all-degree-two cycle", () => {
    const compressed = compressSearchGraph(
      graph(["A", "B", "C"], [
        edge("ab", "A", "B"), edge("ba", "B", "A"),
        edge("bc", "B", "C"), edge("cb", "C", "B"),
        edge("ca", "C", "A"), edge("ac", "A", "C"),
      ]),
    );

    expect([...compressed.nodes.keys()]).toEqual(["A"]);
    expect(compressed.traversals).toHaveLength(2);
    expect(compressed.traversals.every(({ from, to }) => from.id === "A" && to.id === "A")).toBe(true);
    expect(expandCompressedPath(compressed.traversals)).toHaveLength(6);
  });
});
