import type { RouteSearchRequest } from "./types";
import { describe, expect, it } from "vitest";

import type { GraphAccessPoint, GraphEdge, GraphNode, InducedGraph } from "@/lib/graph";

import { RouteSearchCancelledError } from "./control";
import { searchSimpleRoutes } from "./simple-route-search";

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

function request(overrides: Partial<RouteSearchRequest> = {}): RouteSearchRequest {
  return {
    closedRoute: {
      maximumRepeatedTrailPct: 0
    },
    distanceMiles: { min: 1.8, max: 2 },
    includeUncertainAccess: true,
    limit: 3,
    ...overrides,
  };
}

const budget = {
  maximumDirectedEdges: 10_000,
  maximumExpandedStates: 100_000,
  deadlineMs: 3_000,
  maximumRetainedCycles: 2_000,
};

describe("searchSimpleRoutes", () => {
  it("finds a directed physical cycle and returns a contiguous raw walk", () => {
    const fixture = graph([
      { id: 1, from: "s", to: "a", length: 1_000 },
      { id: 2, from: "a", to: "b", length: 1_000 },
      { id: 3, from: "b", to: "s", length: 1_000 },
    ]);
    const result = searchSimpleRoutes(fixture, start, request(), { budget });

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
    const result = searchSimpleRoutes(fixture, start, request({
      steepestSustainedGradePct: { min: 0, max: 5 },
    }), { budget });

    expect(result.candidates).toEqual([]);
    expect(result.nearCandidates.length).toBeGreaterThan(0);
  });

  it("retains maximum-elevation failures as labeled near candidates", () => {
    const fixture = graph([
      { id: 1, from: "s", to: "a", length: 1_000 },
      { id: 2, from: "a", to: "b", length: 1_000 },
      { id: 3, from: "b", to: "s", length: 1_000 },
    ]);
    const result = searchSimpleRoutes(fixture, start, request({
      maximumElevationFeet: { min: 0, max: 500 },
    }), { budget });

    expect(result.candidates).toEqual([]);
    expect(result.nearCandidates.length).toBeGreaterThan(0);
    expect(result.nearCandidates[0]!.violatedConstraints).toContain("maximum-elevation-outside-range");
  });

  it("retains interior elevation samples when a whole ring becomes one corridor", () => {
    const fixture = graph([
      { id: 1, from: "s", to: "a", length: 50, oneWay: true, gain: 10 },
      { id: 2, from: "a", to: "b", length: 50, oneWay: true, gain: 10 },
      { id: 3, from: "b", to: "s", length: 50, oneWay: true, gain: 0 },
    ]);
    const result = searchSimpleRoutes(fixture, start, request({
      distanceMiles: { min: 140 / 1_609.344, max: 160 / 1_609.344 },
      steepestSustainedGradePct: { min: 0, max: 5 },
    }), { budget, now: () => 0 });
    expect(result.candidates).toEqual([]);
    expect(result.nearCandidates[0]!.violatedConstraints).toContain("sustained-grade-outside-range");
    expect(result.nearCandidates[0]!.elevationGainMeters).toBe(20);
    expect(result.nearCandidates[0]!.traversals.map(({ edge }) => edge.edgeKey)).toEqual([1, 2, 3]);
  });

  it("retains shared-stem failures as labeled near candidates", () => {
    const fixture = graph([
      { id: 1, from: "s", to: "p", length: 500 },
      { id: 2, from: "p", to: "a", length: 800 },
      { id: 3, from: "a", to: "b", length: 800 },
      { id: 4, from: "b", to: "p", length: 800 },
    ]);
    const result = searchSimpleRoutes(fixture, start, request({
      closedRoute: { maximumRepeatedTrailPct: 35, maximumSharedStemMiles: 0.2 },
      distanceMiles: { min: 2.05, max: 2.2 },
    }), { budget });

    expect(result.candidates).toEqual([]);
    expect(result.nearCandidates.length).toBeGreaterThan(0);
    expect(result.nearCandidates[0]!.violatedConstraints).toContain("shared-stem-above-maximum");
  });

  it("constructs a bridge-stem lollipop when repetition is allowed", () => {
    const fixture = graph([
      { id: 1, from: "s", to: "p", length: 500 },
      { id: 2, from: "p", to: "a", length: 800 },
      { id: 3, from: "a", to: "b", length: 800 },
      { id: 4, from: "b", to: "p", length: 800 },
    ]);
    const result = searchSimpleRoutes(fixture, start, request({
      closedRoute: { maximumRepeatedTrailPct: 35, maximumSharedStemMiles: 0.4 },
      distanceMiles: { min: 2.05, max: 2.2 },
    }), { budget });

    expect(result.candidates.length).toBeGreaterThan(0);
    expect(result.candidates[0]!.distanceMeters).toBe(3_400);
    expect(result.candidates[0]!.repeatedEdgeFraction).toBeCloseTo(500 / 3_400);
    expect(result.candidates[0]!.traversals[0]!.edge.physicalEdgeKey).toBe(1);
    expect(result.candidates[0]!.traversals.at(-1)!.edge.physicalEdgeKey).toBe(1);
  });

  it("keeps figure-eight lobes separate", () => {
    const fixture = graph([
      { id: 1, from: "s", to: "a", length: 600 },
      { id: 2, from: "a", to: "b", length: 600 },
      { id: 3, from: "b", to: "s", length: 600 },
      { id: 4, from: "s", to: "c", length: 600 },
      { id: 5, from: "c", to: "d", length: 600 },
      { id: 6, from: "d", to: "s", length: 600 },
    ]);
    const result = searchSimpleRoutes(fixture, start, request({
      closedRoute: { maximumRepeatedTrailPct: 0 },
      distanceMiles: { min: 2.1, max: 2.3 },
      limit: 1,
    }), { budget });

    expect(result.candidates).toEqual([]);
    expect(result.nearCandidates.length).toBeGreaterThan(0);
    expect(result.nearCandidates.every(({ distanceMeters }) => distanceMeters === 1_800)).toBe(true);
  });

  it("reports hard caps without exceeding them", () => {
    const fixture = graph([
      { id: 1, from: "s", to: "a", length: 1_000 },
      { id: 2, from: "a", to: "b", length: 1_000 },
      { id: 3, from: "b", to: "s", length: 1_000 },
    ]);
    const result = searchSimpleRoutes(fixture, start, request(), {
      budget: { ...budget, maximumExpandedStates: 1 },
    });

    expect(result.diagnostics.expandedStates).toBe(1);
    expect(result.diagnostics.exhausted).toBe(true);
    expect(result.diagnostics.truncationReasons).toContain("maximum-expanded-states");
  });

  it("reaches a separate loop by a stem without chaining it with the local loop", () => {
    const fixture = graph([
      { id: 1, from: "s", to: "a", length: 1_000 },
      { id: 2, from: "a", to: "b", length: 1_000 },
      { id: 3, from: "b", to: "s", length: 1_000 },
      { id: 4, from: "s", to: "p", length: 500 },
      { id: 5, from: "p", to: "x", length: 700 },
      { id: 6, from: "x", to: "y", length: 700 },
      { id: 7, from: "y", to: "p", length: 700 },
    ]);
    const result = searchSimpleRoutes(fixture, start, request({
      closedRoute: { maximumRepeatedTrailPct: 10 },
      distanceMiles: { min: 6_000 / 1_609.344, max: 6_200 / 1_609.344 },
      limit: 1,
    }), { budget, now: () => 0 });
    expect(result.candidates).toEqual([]);
    expect(result.nearCandidates.some(({ distanceMeters }) => distanceMeters === 3_100)).toBe(true);
    expect(result.nearCandidates.every(({ distanceMeters }) => distanceMeters === 3_000 || distanceMeters === 3_100)).toBe(true);
  });

  it.each([0, 1_000])("removes a tiny side loop and its %i m connector instead of padding the distance", (connector) => {
    const hub = connector ? "p" : "s";
    const fixture = graph([
      { id: 1, from: "s", to: "a", length: 1_000 },
      { id: 2, from: "a", to: "b", length: 1_000 },
      { id: 3, from: "b", to: "s", length: 1_000 },
      ...(connector ? [{ id: 4, from: "s", to: hub, length: connector }] : []),
      { id: 5, from: hub, to: "x", length: 200 },
      { id: 6, from: "x", to: "y", length: 200 },
      { id: 7, from: "y", to: hub, length: 200 },
    ]);
    const target = 3_600 + 2 * connector;
    const result = searchSimpleRoutes(fixture, start, request({
      closedRoute: { maximumRepeatedTrailPct: 35 },
      distanceMiles: { min: (target - 100) / 1_609.344, max: (target + 100) / 1_609.344 },
      limit: 1,
    }), { budget, now: () => 0 });
    expect(result.candidates).toEqual([]);
    const shorter = result.nearCandidates.find((candidate) => candidate.distanceMeters === 3_000)!;
    expect(shorter.violatedConstraints).toContain("distance-below-minimum");
    expect(shorter.repeatedEdgeFraction).toBe(0);
    expect(new Set(shorter.traversals.map(({ edge }) => edge.physicalEdgeKey))).toEqual(new Set([1, 2, 3]));
  });

  it("does not suggest walking a loop forward and then backward to meet a longer target", () => {
    const fixture = graph([
      { id: 1, from: "s", to: "a", length: 1_000 },
      { id: 2, from: "a", to: "b", length: 1_000 },
      { id: 3, from: "b", to: "s", length: 1_000 },
    ]);
    const result = searchSimpleRoutes(fixture, start, request({
      closedRoute: { maximumRepeatedTrailPct: 55 },
      distanceMiles: { min: 5_900 / 1_609.344, max: 6_100 / 1_609.344 },
      limit: 1,
    }), { budget, now: () => 0 });
    expect(result.candidates).toEqual([]);
    expect(result.nearCandidates.some((candidate) => candidate.distanceMeters === 3_000)).toBe(true);
  });

  it("does not use a one-way trail as a retraced stem", () => {
    const fixture = graph([
      { id: 1, from: "s", to: "p", length: 500, oneWay: true },
      { id: 2, from: "p", to: "a", length: 800 },
      { id: 3, from: "a", to: "b", length: 800 },
      { id: 4, from: "b", to: "p", length: 800 },
    ]);
    const result = searchSimpleRoutes(fixture, start, request({
      closedRoute: { maximumRepeatedTrailPct: 100 },
    }), { budget });
    expect(result.candidates).toEqual([]);
    expect(result.nearCandidates).toEqual([]);
  });

  it("keeps distinct parallel physical trails as a valid cycle", () => {
    const result = searchSimpleRoutes(graph([
      { id: 1, from: "s", to: "a", length: 1_500 },
      { id: 2, from: "s", to: "a", length: 1_500 },
    ]), start, request(), { budget });
    expect(result.candidates).toHaveLength(1);
    expect(new Set(result.candidates[0]!.traversals.map(({ edge }) => edge.physicalEdgeKey))).toEqual(new Set([1, 2]));
  });

  // Fixed-work discovery floor measured against the former solver: 4, 7, 9
  // diverse exact routes respectively. This is a small synthetic regression,
  // not a claim about exhaustive discovery or regional performance.
  it.each([[3, 4], [5, 7], [7, 9]])("preserves useful discovery on a %i-wide grid", (size, minimumExact) => {
    const specs: PhysicalEdge[] = [];
    const node = (x: number, y: number) => x === 0 && y === 0 ? "s" : `${x}:${y}`;
    let id = 1;
    for (let x = 0; x < size; x++) for (let y = 0; y < size; y++) {
      if (x + 1 < size) specs.push({ id: id++, from: node(x, y), to: node(x + 1, y), length: 250 });
      if (y + 1 < size) specs.push({ id: id++, from: node(x, y), to: node(x, y + 1), length: 250 });
    }
    const result = searchSimpleRoutes(graph(specs), start, request({
      distanceMiles: { min: (size * 500 - 100) / 1609.344, max: (size * 500 + 100) / 1609.344 },
      closedRoute: { maximumRepeatedTrailPct: 35 },
      limit: 10,
    }), { budget: { ...budget, maximumExpandedStates: 25_000 }, now: () => 0 });
    expect(result.candidates.length).toBeGreaterThanOrEqual(minimumExact);
    expect(result.diagnostics.expandedStates).toBeLessThanOrEqual(25_000);
    expect(result.diagnostics.candidateCount).toBeLessThanOrEqual(budget.maximumRetainedCycles);
  });

  it("enforces the directed-edge load cap", () => {
    const result = searchSimpleRoutes(graph([
      { id: 1, from: "s", to: "a", length: 1_000 },
      { id: 2, from: "a", to: "b", length: 1_000 },
      { id: 3, from: "b", to: "s", length: 1_000 },
    ]), start, request(), { budget: { ...budget, maximumDirectedEdges: 2 } });
    expect(result.candidates).toEqual([]);
    expect(result.nearCandidates).toEqual([]);
    expect(result.diagnostics.truncationReasons).toContain("maximum-directed-edges");
  });

  it("cooperatively aborts during weighted-bound computation", () => {
    const controller = new AbortController();
    let calls = 0;
    expect(() => searchSimpleRoutes(graph([
      { id: 1, from: "s", to: "a", length: 1_000 },
      { id: 2, from: "a", to: "b", length: 1_000 },
      { id: 3, from: "b", to: "s", length: 1_000 },
    ]), start, request(), { budget, signal: controller.signal, now: () => {
      if (++calls === 3) controller.abort("stop");
      return 0;
    } })).toThrow(RouteSearchCancelledError);
  });

  it("cooperatively aborts before graph work", () => {
    const controller = new AbortController();
    controller.abort(new Error("stop"));
    expect(() => searchSimpleRoutes(graph([
      { id: 1, from: "s", to: "a", length: 1_000 },
    ]), start, request(), { budget, signal: controller.signal })).toThrow(RouteSearchCancelledError);
  });
});
