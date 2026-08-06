import { describe, expect, test } from "vitest";

import type { AccessPointCandidate, ReconstructedDirectedEdge } from "@/lib/graph";

import { validateReconstructedClosedRoute } from "./closed-route-validation";

const positions: Record<string, [number, number]> = {
  s: [0, 0], h: [0.001, 0], a: [0.002, 0.001], b: [0.002, -0.001],
  c: [-0.001, 0.001], d: [-0.001, -0.001], x: [0.004, 0], y: [0.005, 0],
};

function edge(id: number, physicalEdgeKey: number, from: string, to: string, lengthMeters = 100): ReconstructedDirectedEdge {
  return {
    id: `e${id}`,
    edgeKey: id,
    physicalEdgeKey,
    stablePhysicalEdgeId: `p${physicalEdgeKey}`,
    minimumElevationMeters: 10,
    fromNodeId: from,
    toNodeId: to,
    coordinates: [positions[from]!, positions[to]!],
    lengthMeters,
    gainMeters: 10,
    lossMeters: 5,
    maximumElevationMeters: 100,
    maximumSustainedGradePct: 5,
    accessState: "public",
    trailName: "Fixture Trail",
    sourceIds: ["fixture"],
    flags: [],
  };
}

function start(nodeId = "s"): AccessPointCandidate {
  const [lon, lat] = positions[nodeId]!;
  return {
    id: `access-${nodeId}`,
    nodeId,
    name: "Fixture Access",
    kind: "trailhead",
    accessState: "public",
    confidence: "high",
    parkingEvidence: "fixture",
    populationWithinRadius: null,
    localReliefM: null,
    sourceIds: ["fixture"],
    lon,
    lat,
    knownConnectivity: 10,
    inclusiveConnectivity: 10,
    knownOutDegree: 2,
    inclusiveOutDegree: 2,
  };
}

function validate(edges: ReconstructedDirectedEdge[], startNodeId = "s") {
  return validateReconstructedClosedRoute(edges, {
    compressedEdgeIds: edges.map(({ edgeKey }) => edgeKey),
    start: start(startNodeId),
    includeUncertainAccess: false,
    coverage: {
      type: "Polygon",
      coordinates: [[[-1, -1], [1, -1], [1, 1], [-1, 1], [-1, -1]]],
    },
    sourceFreshness: "2026-01-01T00:00:00.000Z",
    sourceConfidence: "high",
    fallbackSourceIds: ["fixture"],
    routeId: "closed_fixture",
  });
}

describe("closed-route reconstruction validation", () => {
  test("classifies simple loops and computes zero physical repetition", () => {
    const result = validate([edge(1, 1, "s", "a"), edge(2, 2, "a", "b"), edge(3, 3, "b", "s")]);
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.value.route.topology).toMatchObject({
      kind: "simple-loop",
      cycleCount: 1,
      cycleBlockCount: 1,
      repeatedTrailDistanceMeters: 0,
      repeatedTrailFraction: 0,
      sharedStemDistanceMeters: 0,
    });
    expect(result.value.route.minimumElevationMeters).toBe(10);
  });

  test("classifies a lollipop and measures the one-way repeated stem exactly", () => {
    const result = validate([
      edge(1, 1, "s", "h"), edge(2, 2, "h", "a"), edge(3, 3, "a", "b"),
      edge(4, 4, "b", "h"), edge(5, 1, "h", "s"),
    ]);
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.value.route.topology).toMatchObject({
      kind: "lollipop",
      repeatedTrailDistanceMeters: 100,
      repeatedTrailFraction: 0.2,
      sharedStemDistanceMeters: 100,
      connectorCount: 1,
    });
  });

  test("measures sustained grade across short edge boundaries", () => {
    const edges = [
      edge(50, 50, "s", "a", 50), edge(51, 51, "a", "b", 50),
      edge(52, 52, "b", "h", 50), edge(53, 53, "h", "s", 50),
    ];
    const elevations = [[0, 5], [5, 10], [10, 5], [5, 0]] as const;
    edges.forEach((item, index) => {
      item.fromElevationMeters = elevations[index]![0];
      item.toElevationMeters = elevations[index]![1];
      item.maximumSustainedGradePct = 80;
    });
    const result = validate(edges);
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.value.route.steepestSustainedGradePct).toBeCloseTo(10, 8);
  });

  test("distinguishes figure-eight, chained-loop, and complex closed structures", () => {
    const figureEight = validate([
      edge(1, 1, "s", "a"), edge(2, 2, "a", "b"), edge(3, 3, "b", "s"),
      edge(4, 4, "s", "c"), edge(5, 5, "c", "d"), edge(6, 6, "d", "s"),
    ]);
    expect(figureEight.valid && figureEight.value.route.topology.kind).toBe("figure-eight");
    expect(figureEight.valid && figureEight.value.route.topology.cycleCount).toBe(2);

    const chained = validate([
      edge(10, 10, "s", "a"), edge(11, 11, "a", "b"), edge(12, 12, "b", "s"),
      edge(13, 13, "s", "x"), edge(14, 14, "x", "c"), edge(15, 15, "c", "d"),
      edge(16, 16, "d", "x"), edge(17, 13, "x", "s"),
    ]);
    expect(chained.valid && chained.value.route.topology.kind).toBe("chained-loops");

    const complex = validate([
      edge(20, 20, "s", "a"), edge(21, 21, "a", "b"), edge(22, 22, "b", "s"),
      edge(23, 20, "s", "a"), edge(24, 24, "a", "s"),
    ]);
    expect(complex.valid && complex.value.route.topology.kind).toBe("complex-closed");
  });

  test("rejects pure out-and-back, wrong direction, access, and coverage", () => {
    expect(validate([edge(1, 1, "s", "h"), edge(2, 1, "h", "s")])).toEqual({
      valid: false,
      reason: "zero-cycle",
    });
    expect(validate([edge(1, 1, "h", "s")])).toEqual({ valid: false, reason: "wrong-start" });
    const closed = [edge(1, 1, "s", "a"), edge(2, 2, "a", "b"), edge(3, 3, "b", "s")];
    closed[1]!.accessState = "closed";
    expect(validate(closed)).toEqual({ valid: false, reason: "illegal-access" });
    const outside = [edge(4, 4, "s", "a"), edge(5, 5, "a", "b"), edge(6, 6, "b", "s")];
    outside[1]!.coordinates = [[2, 2], [3, 3]];
    expect(validate(outside)).toEqual({ valid: false, reason: "outside-coverage" });
  });

  test("rejects an edge whose endpoints are inside coverage but whose segment crosses a hole", () => {
    const edges = [
      edge(30, 30, "s", "a"), edge(31, 31, "a", "b"), edge(32, 32, "b", "s"),
    ];
    edges[0]!.coordinates = [[-0.5, 0], [0.5, 0]];
    edges[1]!.coordinates = [[0.5, 0], [0.5, 0.5]];
    edges[2]!.coordinates = [[0.5, 0.5], [-0.5, 0]];
    const result = validateReconstructedClosedRoute(edges, {
      compressedEdgeIds: [30, 31, 32],
      start: start(),
      includeUncertainAccess: false,
      coverage: {
        type: "Polygon",
        coordinates: [
          [[-1, -1], [1, -1], [1, 1], [-1, 1], [-1, -1]],
          [[-0.1, -0.1], [-0.1, 0.1], [0.1, 0.1], [0.1, -0.1], [-0.1, -0.1]],
        ],
      },
      sourceFreshness: "2026-01-01T00:00:00.000Z",
      sourceConfidence: "high",
      fallbackSourceIds: ["fixture"],
      routeId: "closed_hole_crossing",
    });

    expect(result).toEqual({ valid: false, reason: "outside-coverage" });
  });

  test("rejects missing minimum elevation instead of fabricating a route minimum", () => {
    const edges = [edge(40, 40, "s", "a"), edge(41, 41, "a", "b"), edge(42, 42, "b", "s")];
    edges[1]!.minimumElevationMeters = null;
    expect(validate(edges)).toEqual({ valid: false, reason: "incomplete-elevation" });
  });
});
