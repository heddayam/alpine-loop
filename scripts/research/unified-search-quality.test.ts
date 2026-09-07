import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import type { AccessPointCandidate, AreaGeometry, EdgeTraversal, GraphEdge, GraphNode, InducedGraph } from "../../lib/graph";
import { validateReconstructedClosedRoute } from "../../lib/solver/closed-route-validation";
import { searchPenalizedClosedRoutes as productionSearch } from "../../lib/solver/penalized-closed-route-search";
import type { RouteSearchRequest } from "../../lib/solver/types";

// The same assertions run against either implementation, without depending on its moves or scoring.
const search: typeof productionSearch = process.env.UNIFIED_SEARCH_MODULE
  ? (await import(pathToFileURL(process.env.UNIFIED_SEARCH_MODULE).href)).searchPenalizedClosedRoutes
  : productionSearch;
const MILE = 1_609.344;
type Trail = [from: string, to: string, meters: number, oneWay?: boolean];
const coverage: AreaGeometry = { type: "Polygon", coordinates: [[[-123, 36], [-121, 36], [-121, 39], [-123, 39], [-123, 36]]] };
const budget = { maximumDirectedEdges: 10_000, maximumExpandedStates: 100_000, maximumRawCandidates: 2_000, deadlineMs: 3_000 };

function fixture(trails: Trail[], elevations: Record<string, number> = {}) {
  const nodes = new Map<string, GraphNode>([...new Set(trails.flatMap(([from, to]) => [from, to]))].map((id, index) => [id, {
    id, lon: -122 + (index % 10) * 0.001, lat: 37 + Math.floor(index / 10) * 0.001,
    elevationMeters: elevations[id] ?? 100, flags: [],
  }]));
  const edges: GraphEdge[] = [];
  for (const [index, [from, to, lengthMeters, oneWay]] of trails.entries()) {
    for (const [a, b] of oneWay ? [[from, to]] : [[from, to], [to, from]]) {
      const start = nodes.get(a!)!;
      const end = nodes.get(b!)!;
      const ascent = end.elevationMeters! - start.elevationMeters!;
      edges.push({ id: `${index}:${a}->${b}`, edgeKey: edges.length + 1, physicalEdgeKey: index + 1,
        fromNodeId: a!, toNodeId: b!, coordinates: [[start.lon, start.lat], [end.lon, end.lat]],
        lengthMeters, gainMeters: Math.max(0, ascent), lossMeters: Math.max(0, -ascent),
        maximumElevationMeters: Math.max(start.elevationMeters!, end.elevationMeters!),
        maximumSustainedGradePct: Math.abs(ascent) / lengthMeters * 100, accessState: "public",
        trailName: `Trail ${index + 1}`, sourceIds: ["quality-fixture"], flags: [], edgeClass: "trail" });
    }
  }
  const root = nodes.get("s")!;
  const start: AccessPointCandidate = { id: "start", nodeId: "s", name: "Quality fixture", kind: "trailhead",
    accessState: "public", confidence: "high", parkingEvidence: "fixture", sourceIds: ["quality-fixture"],
    nearbyBuildingCount: 0, lon: root.lon, lat: root.lat, knownConnectivity: 10, inclusiveConnectivity: 10,
    knownOutDegree: 2, inclusiveOutDegree: 2 };
  return { graph: { nodes, edges, accessPoints: [start] } satisfies InducedGraph, start };
}

function criteria(min: number, max: number, overrides: Partial<RouteSearchRequest> = {}): RouteSearchRequest {
  return { closedRoute: { maximumRepeatedTrailPct: 0, allowMultiCycle: true },
    distanceMiles: { min: min / MILE, max: max / MILE }, includeUncertainAccess: true,
    searchEffort: "quick", limit: 4, ...overrides };
}

function validate(traversals: EdgeTraversal[], start: AccessPointCandidate) {
  const result = validateReconstructedClosedRoute(traversals.map(({ edge, from, to }) => ({
    ...edge, edgeKey: edge.edgeKey!, physicalEdgeKey: edge.physicalEdgeKey!,
    fromElevationMeters: from.elevationMeters, toElevationMeters: to.elevationMeters,
    minimumElevationMeters: Math.min(from.elevationMeters!, to.elevationMeters!),
  })), { start, includeUncertainAccess: true, coverage, sourceFreshness: "fixture", sourceConfidence: "high",
    fallbackSourceIds: ["quality-fixture"], routeId: "quality-route" });
  expect(result.valid).toBe(true);
  if (!result.valid) throw new Error(result.reason);
  return result.value;
}

function run(input: ReturnType<typeof fixture>, request: RouteSearchRequest) {
  const result = search(input.graph, input.start, request, { budget, now: () => 0 });
  const all = [...result.candidates, ...result.nearCandidates];
  const legal = new Map(input.graph.edges.map((edge) => [edge.edgeKey, edge]));
  for (const candidate of all) {
    for (const { edge } of candidate.traversals) expect(edge).toEqual(legal.get(edge.edgeKey));
    const { route } = validate(candidate.traversals, input.start);
    expect(route.distanceMeters).toBeCloseTo(candidate.distanceMeters);
    expect(route.elevationGainMeters).toBeCloseTo(candidate.elevationGainMeters);
    expect(route.topology.repeatedTrailFraction).toBeCloseTo(candidate.repeatedEdgeFraction);
  }
  const exact = result.candidates.map((candidate) => validate(candidate.traversals, input.start));
  for (const { route } of exact) {
    expect(route.distanceMeters).toBeGreaterThanOrEqual(request.distanceMiles.min * MILE - 1e-6);
    expect(route.distanceMeters).toBeLessThanOrEqual(request.distanceMiles.max * MILE + 1e-6);
    expect(route.topology.repeatedTrailFraction).toBeLessThanOrEqual(request.closedRoute.maximumRepeatedTrailPct / 100 + 1e-9);
    if (!request.closedRoute.allowMultiCycle) expect(route.topology.cycleCount).toBe(1);
    if (request.elevationGainFeet) {
      expect(route.elevationGainMeters).toBeGreaterThanOrEqual(request.elevationGainFeet.min * 0.3048 - 1e-6);
      expect(route.elevationGainMeters).toBeLessThanOrEqual(request.elevationGainFeet.max * 0.3048 + 1e-6);
    }
  }
  return { ...result, exact };
}

const mainLoop: Trail[] = [["s", "a", 1_000], ["a", "b", 1_000], ["b", "s", 1_000]];

describe("unified search independent route-quality scenarios", () => {
  it("retains a substantial chained loop whose remote component violates repetition alone", () => {
    const input = fixture([...mainLoop, ["s", "p", 500], ["p", "x", 700], ["x", "y", 700], ["y", "p", 700]]);
    const result = run(input, criteria(6_000, 6_200, { closedRoute: { maximumRepeatedTrailPct: 10, allowMultiCycle: true } }));
    expect(result.exact.length).toBeGreaterThan(0);
    const { route } = result.exact[0]!;
    expect(route.distanceMeters).toBe(6_100);
    expect(route.topology.kind).toBe("chained-loops");
    expect(route.topology.cycleCount).toBe(2);
    expect(route.topology.repeatedTrailDistanceMeters).toBe(500);
  });

  it.each([0, 1_000])("ignores a 600 m side loop with a %i m connector instead of padding the target", (connector) => {
    const p = connector ? "p" : "s";
    const input = fixture([...mainLoop, ...(connector ? [["s", p, connector] as Trail] : []),
      [p, "x", 200], ["x", "y", 200], ["y", p, 200]]);
    const target = 3_600 + connector * 2;
    const result = run(input, criteria(target - 100, target + 100, { closedRoute: { maximumRepeatedTrailPct: 35, allowMultiCycle: true } }));
    expect(result.exact).toHaveLength(0);
    expect(result.nearCandidates.some(({ distanceMeters }) => distanceMeters === 3_000)).toBe(true);
  });

  it("preserves an intentionally short hike", () => {
    const result = run(fixture([["s", "a", 200], ["a", "b", 200], ["b", "s", 200]]), criteria(550, 650));
    expect(result.exact.length).toBeGreaterThan(0);
    expect(result.exact[0]!.route.topology.kind).toBe("simple-loop");
    expect(result.exact[0]!.route.distanceMeters).toBe(600);
  });

  it("reaches a one-way cycle through a legal bidirectional stem", () => {
    const input = fixture([["s", "p", 500], ["p", "a", 800, true], ["a", "b", 800, true], ["b", "p", 800, true]]);
    const result = run(input, criteria(3_300, 3_500, { closedRoute: { maximumRepeatedTrailPct: 20, allowMultiCycle: false } }));
    expect(result.exact.length).toBeGreaterThan(0);
    expect(result.exact[0]!.route.topology.kind).toBe("lollipop");
    expect(result.exact[0]!.route.distanceMeters).toBe(3_400);
  });

  it("does not invent a return direction for a one-way connector", () => {
    const input = fixture([["s", "p", 500, true], ["p", "a", 800, true], ["a", "b", 800, true], ["b", "p", 800, true]]);
    const result = run(input, criteria(3_300, 3_500, { closedRoute: { maximumRepeatedTrailPct: 100, allowMultiCycle: true } }));
    expect(result.exact).toHaveLength(0);
    expect(result.nearCandidates).toHaveLength(0);
  });

  it("finds diverse unrepeated single loops in a junction-dense grid", () => {
    const width = 8;
    const trails: Trail[] = [];
    const id = (index: number) => index === 0 ? "s" : `n${index}`;
    for (let index = 0; index < width * width; index += 1) {
      for (const other of [index % width < width - 1 ? index + 1 : -1, index + width]) {
        if (other >= 0 && other < width * width) trails.push([id(index), id(other), 300]);
      }
    }
    const result = run(fixture(trails), criteria(3_000, 4_800, { closedRoute: { maximumRepeatedTrailPct: 0, allowMultiCycle: false } }));
    expect(result.exact.length).toBeGreaterThanOrEqual(3);
    for (let i = 0; i < result.exact.length; i += 1) {
      for (let j = i + 1; j < result.exact.length; j += 1) {
        const a = result.exact[i]!.physicalEdgeKeys;
        const b = result.exact[j]!.physicalEdgeKeys;
        const shared = [...a].filter((key) => b.has(key)).length;
        expect(shared / Math.min(a.size, b.size)).toBeLessThanOrEqual(0.8);
      }
    }
  });

  it("can select two coupled path changes to satisfy distance and ascent together", () => {
    // The long ascent adds 1 km; the shorter return removes 1 km. Either edit alone misses distance.
    const input = fixture([["s", "a", 2_000, true], ["s", "x", 1_500, true], ["x", "a", 1_500, true],
      ["a", "b", 1_000, true], ["b", "s", 1_000, true], ["a", "c", 500, true], ["c", "s", 500, true]],
    { x: 200, b: 200, c: 200 });
    const result = run(input, criteria(3_900, 4_100, { elevationGainFeet: { min: 190 / 0.3048, max: 210 / 0.3048 } }));
    expect(result.exact.length).toBeGreaterThan(0);
    expect(result.exact[0]!.route.distanceMeters).toBe(4_000);
    expect(result.exact[0]!.route.elevationGainMeters).toBe(200);
  });

  it("does not pad the target with a second lap of the same loop", () => {
    const result = run(fixture(mainLoop), criteria(5_900, 6_100, { closedRoute: { maximumRepeatedTrailPct: 55, allowMultiCycle: true } }));
    expect(result.exact).toHaveLength(0);
    expect(result.nearCandidates.some(({ distanceMeters }) => distanceMeters === 3_000)).toBe(true);
  });

  it("demonstrates that distance, first use, gain, and repeats cannot identify a tiny side lobe", () => {
    const simple = fixture(mainLoop);
    const lobes = fixture([["s", "a", 800], ["a", "b", 800], ["b", "s", 800],
      ["s", "x", 200], ["x", "y", 200], ["y", "s", 200]]);
    const forward = (input: ReturnType<typeof fixture>) => validate(input.graph.edges.filter((_, index) => index % 2 === 0)
      .map((edge) => ({ edge, from: input.graph.nodes.get(edge.fromNodeId)!, to: input.graph.nodes.get(edge.toNodeId)! })), input.start).route;
    const a = forward(simple);
    const b = forward(lobes);
    expect([a.distanceMeters, a.elevationGainMeters, a.topology.repeatedTrailDistanceMeters])
      .toEqual([b.distanceMeters, b.elevationGainMeters, b.topology.repeatedTrailDistanceMeters]);
    expect(a.topology.kind).toBe("simple-loop");
    expect(b.topology.kind).toBe("figure-eight");
  });

  it("demonstrates the quality blind spot of leaving and rejoining a trail at different nearby junctions", () => {
    const input = fixture([["s", "u", 1_000, true], ["u", "v", 40, true], ["v", "s", 1_000, true],
      ["u", "x", 90, true], ["x", "v", 90, true]]);
    const route = (indexes: number[]) => validate(indexes.map((index) => {
      const edge = input.graph.edges[index]!;
      return { edge, from: input.graph.nodes.get(edge.fromNodeId)!, to: input.graph.nodes.get(edge.toNodeId)! };
    }), input.start).route;
    const direct = route([0, 1, 2]);
    const bypass = route([0, 3, 4, 2]);
    expect(direct.topology.kind).toBe("simple-loop");
    expect(bypass.topology.kind).toBe("simple-loop");
    expect([direct.topology.repeatedTrailFraction, bypass.topology.repeatedTrailFraction]).toEqual([0, 0]);
    expect([direct.distanceMeters, bypass.distanceMeters]).toEqual([2_040, 2_180]);
    // Target fit and first-use distance both favor the bypass at a 2,180 m target.
    // The selected walk has no closed inner subwalk for same-junction trimming to remove.
    expect(Math.abs(bypass.distanceMeters - 2_180)).toBeLessThan(Math.abs(direct.distanceMeters - 2_180));
    const junctions = bypass.geometry.coordinates.slice(0, -1).map((point) => point.join(","));
    expect(new Set(junctions).size).toBe(junctions.length);
  });
});
