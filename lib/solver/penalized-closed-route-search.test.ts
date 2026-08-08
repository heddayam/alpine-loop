import { describe, expect, it } from "vitest";

import type { GenerateClosedRoutesRequestV3 } from "@/lib/contracts";
import type { GraphAccessPoint, GraphEdge, GraphNode, InducedGraph } from "@/lib/graph";

import { RouteSearchCancelledError } from "./control";
import { searchPenalizedClosedRoutes } from "./penalized-closed-route-search";

type PhysicalEdge = {
  id: number;
  from: string;
  to: string;
  length: number;
  oneWay?: boolean;
  gain?: number;
  reverseGain?: number;
};

const start: GraphAccessPoint = {
  id: "start",
  nodeId: "s",
  name: "Start",
  kind: "trailhead",
  accessState: "public",
  confidence: "high",
  parkingEvidence: "fixture",
  sourceIds: ["fixture"],
  nearbyBuildingCount: 0,
};

function graph(specs: readonly PhysicalEdge[]): InducedGraph {
  const nodeIds = [...new Set(specs.flatMap(({ from, to }) => [from, to]))];
  const nodes = new Map<string, GraphNode>(nodeIds.map((id, index) => [id, {
    id,
    lon: -122 + index * 0.001,
    lat: 37 + index * 0.001,
    elevationMeters: 100 + index * 10,
    flags: [],
  }]));
  const edges: GraphEdge[] = [];
  let edgeKey = 1;
  for (const spec of specs) {
    const makeEdge = (from: string, to: string, gainMeters: number): GraphEdge => ({
      id: `edge-${edgeKey}`,
      edgeKey: edgeKey++,
      physicalEdgeKey: spec.id,
      fromNodeId: from,
      toNodeId: to,
      coordinates: [
        [nodes.get(from)!.lon, nodes.get(from)!.lat],
        [nodes.get(to)!.lon, nodes.get(to)!.lat],
      ],
      lengthMeters: spec.length,
      gainMeters,
      lossMeters: 0,
      maximumElevationMeters: 250,
      maximumSustainedGradePct: 8,
      accessState: "public",
      trailName: null,
      sourceIds: ["fixture"],
      flags: [],
    });
    edges.push(makeEdge(spec.from, spec.to, spec.gain ?? 20));
    if (!spec.oneWay) edges.push(makeEdge(spec.to, spec.from, spec.reverseGain ?? 5));
  }
  return { nodes, edges, accessPoints: [start] };
}

function request(overrides: Partial<GenerateClosedRoutesRequestV3> = {}): GenerateClosedRoutesRequestV3 {
  return {
    version: 3,
    packId: "fixture",
    accessFilter: { mode: "drawn-area", bbox: [-123, 36, -121, 38] },
    routeFamily: "closed",
    closedRoute: {
      maximumRepeatedTrailPct: 0,
      allowMultiCycle: false,
    },
    distanceMiles: { min: 1.8, max: 2 },
    includeUncertainAccess: true,
    searchEffort: "quick",
    limit: 3,
    ...overrides,
  };
}

const budget = {
  maximumDirectedEdges: 10_000,
  maximumExpandedStates: 100_000,
  deadlineMs: 3_000,
  maximumRawCandidates: 2_000,
};

describe("searchPenalizedClosedRoutes", () => {
  it("finds a directed physical cycle and returns a contiguous raw walk", () => {
    const fixture = graph([
      { id: 1, from: "s", to: "a", length: 1_000 },
      { id: 2, from: "a", to: "b", length: 1_000 },
      { id: 3, from: "b", to: "s", length: 1_000 },
    ]);
    const result = searchPenalizedClosedRoutes(fixture, start, request(), { budget });

    expect(result.candidates).toHaveLength(1);
    const route = result.candidates[0]!;
    expect(route.distanceMeters).toBe(3_000);
    expect(route.repeatedEdgeFraction).toBe(0);
    expect(route.traversals[0]!.from.id).toBe("s");
    expect(route.traversals.at(-1)!.to.id).toBe("s");
    for (let index = 1; index < route.traversals.length; index += 1) {
      expect(route.traversals[index - 1]!.to.id).toBe(route.traversals[index]!.from.id);
    }
  });

  it("uses a route-wide sustained-grade prefilter and retains failures for authoritative validation", () => {
    const fixture = graph([
      { id: 1, from: "s", to: "a", length: 1_000 },
      { id: 2, from: "a", to: "b", length: 1_000 },
      { id: 3, from: "b", to: "s", length: 1_000 },
    ]);
    const result = searchPenalizedClosedRoutes(fixture, start, request({
      steepestSustainedGradePct: { min: 0, max: 5 },
    }), { budget });

    expect(result.candidates).toEqual([]);
    expect(result.nearCandidates.length).toBeGreaterThan(0);
  });

  it("constructs a bridge-stem lollipop when repetition is allowed", () => {
    const fixture = graph([
      { id: 1, from: "s", to: "p", length: 500 },
      { id: 2, from: "p", to: "a", length: 800 },
      { id: 3, from: "a", to: "b", length: 800 },
      { id: 4, from: "b", to: "p", length: 800 },
    ]);
    const result = searchPenalizedClosedRoutes(fixture, start, request({
      closedRoute: { maximumRepeatedTrailPct: 35, maximumSharedStemMiles: 0.4, allowMultiCycle: false },
      distanceMiles: { min: 2.05, max: 2.2 },
    }), { budget });

    expect(result.candidates.length).toBeGreaterThan(0);
    expect(result.candidates[0]!.distanceMeters).toBe(3_400);
    expect(result.candidates[0]!.repeatedEdgeFraction).toBeCloseTo(500 / 3_400);
    expect(result.candidates[0]!.traversals[0]!.edge.physicalEdgeKey).toBe(1);
    expect(result.candidates[0]!.traversals.at(-1)!.edge.physicalEdgeKey).toBe(1);
  });

  it("assembles archived short cycles into a compound route", () => {
    const fixture = graph([
      { id: 1, from: "s", to: "a", length: 600 },
      { id: 2, from: "a", to: "b", length: 600 },
      { id: 3, from: "b", to: "s", length: 600 },
      { id: 4, from: "s", to: "c", length: 600 },
      { id: 5, from: "c", to: "d", length: 600 },
      { id: 6, from: "d", to: "s", length: 600 },
    ]);
    const result = searchPenalizedClosedRoutes(fixture, start, request({
      closedRoute: { maximumRepeatedTrailPct: 0, allowMultiCycle: true },
      distanceMiles: { min: 2.1, max: 2.3 },
      limit: 1,
    }), { budget });

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.distanceMeters).toBe(3_600);
    expect(new Set(result.candidates[0]!.traversals.map(({ edge }) => edge.physicalEdgeKey)).size).toBe(6);
    expect(result.diagnostics.assemblyAccepted).toBeGreaterThan(0);
  });

  it("reports hard caps without exceeding them", () => {
    const fixture = graph([
      { id: 1, from: "s", to: "a", length: 1_000 },
      { id: 2, from: "a", to: "b", length: 1_000 },
      { id: 3, from: "b", to: "s", length: 1_000 },
    ]);
    const result = searchPenalizedClosedRoutes(fixture, start, request(), {
      budget: { ...budget, maximumExpandedStates: 1 },
    });

    expect(result.diagnostics.expandedStates).toBe(1);
    expect(result.diagnostics.exhausted).toBe(true);
    expect(result.diagnostics.truncationReasons).toContain("maximum-expanded-states");
  });

  it("cooperatively aborts before and during graph work", () => {
    const controller = new AbortController();
    controller.abort(new Error("stop"));
    expect(() => searchPenalizedClosedRoutes(graph([
      { id: 1, from: "s", to: "a", length: 1_000 },
    ]), start, request(), { budget, signal: controller.signal })).toThrow(RouteSearchCancelledError);
  });
});
