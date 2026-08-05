import { describe, expect, test } from "vitest";

import type {
  GraphAccessPoint,
  GraphEdge,
  GraphNode,
  InducedGraph,
} from "@/lib/graph";

import { undirectedEdgeKey } from "./canonical";
import { generateClosedTours, type ClosedTourRequest } from "./closed-tours";

type FixtureBuilder = {
  graph: InducedGraph;
  start: GraphAccessPoint;
  addNode(id: string, elevationMeters?: number): void;
  addDirectedEdge(from: string, to: string, lengthMeters: number, gainMeters?: number): void;
  addBidirectionalEdge(from: string, to: string, lengthMeters: number, gainForward?: number): void;
};

function fixtureBuilder(): FixtureBuilder {
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const addNode = (id: string, elevationMeters = 0): void => {
    nodes.set(id, {
      id,
      lon: edges.length / 10_000,
      lat: nodes.size / 10_000,
      elevationMeters,
      flags: [],
    });
  };
  addNode("start");
  const addDirectedEdge = (from: string, to: string, lengthMeters: number, gainMeters = 0): void => {
    const fromNode = nodes.get(from)!;
    const toNode = nodes.get(to)!;
    edges.push({
      id: `${from}->${to}`,
      fromNodeId: from,
      toNodeId: to,
      coordinates: [[fromNode.lon, fromNode.lat], [toNode.lon, toNode.lat]],
      lengthMeters,
      gainMeters,
      lossMeters: 0,
      maximumElevationMeters: Math.max(fromNode.elevationMeters ?? 0, toNode.elevationMeters ?? 0),
      maximumSustainedGradePct: 5,
      accessState: "public",
      trailName: "Fixture Trail",
      sourceIds: ["fixture"],
      flags: [],
    });
  };
  const addBidirectionalEdge = (from: string, to: string, lengthMeters: number, gainForward = 0): void => {
    addDirectedEdge(from, to, lengthMeters, gainForward);
    addDirectedEdge(to, from, lengthMeters, 0);
  };
  const start: GraphAccessPoint = {
    id: "start-access",
    nodeId: "start",
    name: "Start",
    kind: "trailhead",
    accessState: "public",
    confidence: "high",
    parkingEvidence: "fixture",
    sourceIds: ["fixture"],
  };
  return {
    graph: { nodes, edges, accessPoints: [start] },
    start,
    addNode,
    addDirectedEdge,
    addBidirectionalEdge,
  };
}

function request(distanceMeters: { min: number; max: number }, overrides: Partial<ClosedTourRequest> = {}): ClosedTourRequest {
  return {
    distanceMeters,
    includeUncertainAccess: false,
    maximumWalks: 12,
    ...overrides,
  };
}

describe("generateClosedTours", () => {
  test("reaches a long target before many lexicographically earlier short branches exhaust the search", () => {
    const fixture = fixtureBuilder();
    for (let index = 0; index < 80; index += 1) {
      const id = `a-short-${index.toString().padStart(2, "0")}`;
      fixture.addNode(id);
      fixture.addBidirectionalEdge("start", id, 20);
    }
    const ring = Array.from({ length: 11 }, (_, index) => `z-ring-${index}`);
    for (const nodeId of ring) fixture.addNode(nodeId);
    fixture.addBidirectionalEdge("start", ring[0]!, 500, 40);
    for (let index = 0; index < ring.length - 1; index += 1) {
      fixture.addBidirectionalEdge(ring[index]!, ring[index + 1]!, 500, 40);
    }
    fixture.addBidirectionalEdge(ring.at(-1)!, "start", 500, 40);

    const result = generateClosedTours(
      fixture.graph,
      fixture.start,
      request({ min: 5_800, max: 6_200 }),
      {
        budget: {
          maximumDirectedEdges: 500,
          maximumExpandedStates: 50,
          maximumRawCandidates: 20,
          deadlineMs: 1_000,
        },
      },
    );

    expect(result.candidates[0]?.exactDistance).toBe(true);
    expect(result.candidates[0]?.distanceMeters).toBe(6_000);
    expect(result.candidates[0]?.traversals).toHaveLength(12);
    expect(result.diagnostics.expandedStates).toBeLessThanOrEqual(50);
  });

  test("merges two cycles beyond a shared connector into one chained-loop tour", () => {
    const fixture = fixtureBuilder();
    for (const nodeId of ["hub", "a", "b", "c", "d"]) fixture.addNode(nodeId);
    fixture.addBidirectionalEdge("start", "hub", 200);
    fixture.addBidirectionalEdge("hub", "a", 500);
    fixture.addBidirectionalEdge("a", "b", 500);
    fixture.addBidirectionalEdge("b", "hub", 500);
    fixture.addBidirectionalEdge("hub", "c", 500);
    fixture.addBidirectionalEdge("c", "d", 500);
    fixture.addBidirectionalEdge("d", "hub", 500);

    const result = generateClosedTours(
      fixture.graph,
      fixture.start,
      request({ min: 3_300, max: 3_500 }),
      { maximumCompositionDepth: 2 },
    );
    const chained = result.candidates.find((candidate) => candidate.distanceMeters === 3_400);

    expect(chained).toBeDefined();
    expect(chained?.traversals[0]?.from.id).toBe("start");
    expect(chained?.traversals.at(-1)?.to.id).toBe("start");
    const keys = chained!.traversals.map(({ edge }) => undirectedEdgeKey(edge));
    const connectorKey = undirectedEdgeKey(
      fixture.graph.edges.find((edge) => edge.id === "start->hub")!,
    );
    expect(keys.filter((key) => key === connectorKey)).toHaveLength(2);
    expect(new Set(keys).size).toBe(7);
    expect(chained?.repeatedEdgeFraction).toBeCloseTo(200 / 3_400);
  });

  test("builds a figure-eight by composing edge-disjoint cycles at the start", () => {
    const fixture = fixtureBuilder();
    for (const nodeId of ["a", "b", "c", "d"]) fixture.addNode(nodeId);
    fixture.addBidirectionalEdge("start", "a", 400);
    fixture.addBidirectionalEdge("a", "b", 400);
    fixture.addBidirectionalEdge("b", "start", 400);
    fixture.addBidirectionalEdge("start", "c", 500);
    fixture.addBidirectionalEdge("c", "d", 500);
    fixture.addBidirectionalEdge("d", "start", 500);

    const result = generateClosedTours(
      fixture.graph,
      "start",
      request({ min: 2_650, max: 2_750 }),
      { maximumCompositionDepth: 2 },
    );

    expect(result.candidates[0]?.distanceMeters).toBe(2_700);
    expect(result.candidates[0]?.repeatedEdgeFraction).toBe(0);
    expect(result.candidates[0]?.traversals.filter(({ from }) => from.id === "start")).toHaveLength(2);
  });

  test("uses directed gain when targeting elevation and excludes uncertain edges by policy", () => {
    const fixture = fixtureBuilder();
    for (const nodeId of ["a", "b", "x"]) fixture.addNode(nodeId);
    fixture.addDirectedEdge("start", "a", 500, 120);
    fixture.addDirectedEdge("a", "b", 500, 100);
    fixture.addDirectedEdge("b", "start", 500, 80);
    fixture.addDirectedEdge("start", "x", 500, 0);
    fixture.addDirectedEdge("x", "a", 500, 0);
    fixture.graph.edges.at(-1)!.accessState = "unknown";

    const result = generateClosedTours(
      fixture.graph,
      fixture.start,
      request(
        { min: 1_400, max: 1_600 },
        { elevationGainMeters: { min: 280, max: 320 } },
      ),
    );

    expect(result.candidates[0]).toMatchObject({
      distanceMeters: 1_500,
      elevationGainMeters: 300,
      exactElevationGain: true,
    });
    expect(result.candidates.flatMap(({ traversals }) => traversals).some(({ edge }) => edge.accessState === "unknown"))
      .toBe(false);
  });

  test("is deterministic, validates ranges, and honors hard graph and candidate budgets", () => {
    const fixture = fixtureBuilder();
    for (const nodeId of ["a", "b"]) fixture.addNode(nodeId);
    fixture.addBidirectionalEdge("start", "a", 500);
    fixture.addBidirectionalEdge("a", "b", 500);
    fixture.addBidirectionalEdge("b", "start", 500);
    const options = {
      budget: {
        maximumDirectedEdges: 20,
        maximumExpandedStates: 100,
        maximumRawCandidates: 1,
        deadlineMs: 1_000,
      },
      // Wall-clock elapsed time is diagnostic, not solver output. Pin it so
      // this assertion continues to cover deterministic candidate generation.
      now: () => 0,
    };

    const first = generateClosedTours(fixture.graph, fixture.start, request({ min: 1_000, max: 2_000 }), options);
    const second = generateClosedTours(fixture.graph, fixture.start, request({ min: 1_000, max: 2_000 }), options);
    expect(first).toEqual(second);
    expect(first.candidates).toHaveLength(1);
    expect(first.diagnostics.candidateCount).toBe(1);

    const tooSmall = generateClosedTours(fixture.graph, fixture.start, request({ min: 1_000, max: 2_000 }), {
      budget: { ...options.budget, maximumDirectedEdges: 2 },
    });
    expect(tooSmall.candidates).toEqual([]);
    expect(tooSmall.diagnostics.truncationReasons).toContain("maximum-directed-edges");
    expect(() => generateClosedTours(fixture.graph, fixture.start, request({ min: 2, max: 1 }))).toThrow(
      "distanceMeters must be a finite, non-negative ordered range",
    );
  });
});
