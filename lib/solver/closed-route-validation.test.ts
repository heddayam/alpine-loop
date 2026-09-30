import { describe, expect, test } from "vitest";

import type { AccessPointCandidate, ReconstructedDirectedEdge } from "@/lib/graph";

import { validateReconstructedClosedRoute, type ClosedRouteValidationOptions } from "./closed-route-validation";

const positions: Record<string, [number, number]> = {
  s: [0, 0], h: [0.001, 0], a: [0.002, 0.001], b: [0.002, -0.001],
  c: [-0.001, 0.001], d: [-0.001, -0.001], x: [0.004, 0], y: [0.005, 0],
};

function edge(id: number, physicalEdgeKey: number, from: string, to: string, lengthMeters = 100): ReconstructedDirectedEdge {
  return {
    id: `e${id}`,
    edgeKey: id,
    physicalEdgeKey,
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
    nearbyBuildingCount: 0,
    kind: "trailhead",
    accessState: "public",
    confidence: "high",
    parkingEvidence: "fixture",
    sourceIds: ["fixture"],
    lon,
    lat,
    knownConnectivity: 10,
    inclusiveConnectivity: 10,
    knownOutDegree: 2,
    inclusiveOutDegree: 2,
  };
}

function validate(edges: ReconstructedDirectedEdge[], startNodeId = "s", overrides: Partial<ClosedRouteValidationOptions> = {}) {
  return validateReconstructedClosedRoute(edges, {
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
    ...overrides,
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

  test("validates a long loop without exhausting the JavaScript call stack", () => {
    const nodeCount = 12_000;
    const edges = Array.from({ length: nodeCount }, (_, index) => {
      const fromNodeId = index === 0 ? "s" : `n${index}`;
      const toNodeId = index === nodeCount - 1 ? "s" : `n${index + 1}`;
      return {
        ...edge(index + 1, index + 1, "s", "a", 1),
        fromNodeId,
        toNodeId,
        coordinates: [
          [index / nodeCount / 100, 0],
          [(index + 1) % nodeCount / nodeCount / 100, 0],
        ] as [[number, number], [number, number]],
      };
    });
    const result = validate(edges);
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.value.route.topology).toMatchObject({
      kind: "simple-loop",
      cycleCount: 1,
      cycleBlockCount: 1,
    });
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

  test("physical loop identity is exact and independent of rotation and traversal direction", () => {
    const clockwise = [edge(1, 1, "s", "a"), edge(2, 2, "a", "b"), edge(3, 3, "b", "s")];
    const walks = [
      validate(clockwise),
      validate([clockwise[1]!, clockwise[2]!, clockwise[0]!], "a"),
      validate([edge(4, 3, "s", "b"), edge(5, 2, "b", "a"), edge(6, 1, "a", "s")]),
    ];
    for (const result of walks) expect(result.valid).toBe(true);
    const routes = walks.filter(result => result.valid).map(result => result.value.route);
    expect(routes[0]!.physicalLoopId).toMatch(/^physical-loop-v1:[0-9a-f]{64}$/);
    expect(new Set(routes.map(route => route.physicalLoopId)).size).toBe(1);
    const changedEdge = validate([edge(7, 1, "s", "a"), edge(8, 20, "a", "b"), edge(9, 3, "b", "s")]);
    expect(changedEdge.valid).toBe(true);
    if (changedEdge.valid) expect(changedEdge.value.route.physicalLoopId).not.toBe(routes[0]!.physicalLoopId);
  });

  test("alternative short entrances share a loop identity while retaining each route's geometry, metrics and access", () => {
    const family = `entrance-family:${"1".repeat(64)}`;
    const cycle = [edge(2, 2, "h", "a"), edge(3, 3, "a", "b"), edge(4, 4, "b", "h")];
    const first = validate([edge(1, 1, "s", "h", 76), ...cycle, edge(5, 1, "h", "s", 76)], "s", {
      start: { ...start(), knownEntranceFamilyId: family },
      routeId: "first-entrance",
    });
    const secondApproach = edge(6, 6, "x", "h", 68);
    secondApproach.accessState = "unknown";
    secondApproach.gainMeters = 3;
    const second = validate([secondApproach, ...cycle, edge(7, 6, "h", "x", 68)], "x", {
      start: { ...start("x"), accessState: "unknown", inclusiveEntranceFamilyId: family },
      includeUncertainAccess: true,
      routeId: "second-entrance",
      sourceConfidence: "low",
    });
    expect(first.valid).toBe(true);
    expect(second.valid).toBe(true);
    if (!first.valid || !second.valid) return;
    expect(first.value.route.physicalLoopId).toBe(second.value.route.physicalLoopId);
    expect(first.value.route.startAccessPoint.entranceFamilyId).toBe(second.value.route.startAccessPoint.entranceFamilyId);
    expect(first.value.route.startAccessPoint.id).not.toBe(second.value.route.startAccessPoint.id);
    expect(first.value.route.geometry).not.toEqual(second.value.route.geometry);
    expect(first.value.route.distanceMeters - second.value.route.distanceMeters).toBe(16);
    expect(first.value.route.elevationGainMeters).not.toBe(second.value.route.elevationGainMeters);
    expect(first.value.route.warnings).toEqual([]);
    expect(second.value.route.warnings).toContain("Access is uncertain");
    expect(second.value.route.warnings).toContain("Route uses trail access marked uncertain");
    expect(second.value.route.source.confidence).toBe("low");
    expect(first.value.route.trailSegments![0]!.id).not.toBe(second.value.route.trailSegments![0]!.id);
    const differentLoop = validate([edge(1, 1, "s", "h", 76), cycle[0]!, edge(8, 8, "a", "c"), edge(9, 9, "c", "h"), edge(5, 1, "h", "s", 76)], "s", {
      start: { ...start(), knownEntranceFamilyId: family },
    });
    expect(differentLoop.valid).toBe(true);
    if (differentLoop.valid) {
      expect(differentLoop.value.route.startAccessPoint.entranceFamilyId).toBe(family);
      expect(differentLoop.value.route.physicalLoopId).not.toBe(first.value.route.physicalLoopId);
    }
  });

  test("selects entrance identity by the requested access profile without borrowing the other profile", () => {
    const knownEntranceFamilyId = `entrance-family:${"1".repeat(64)}`;
    const inclusiveEntranceFamilyId = `entrance-family:${"2".repeat(64)}`;
    const edges = [edge(1, 1, "s", "a"), edge(2, 2, "a", "b"), edge(3, 3, "b", "s")];
    for (const includeUncertainAccess of [false, true]) {
      const result = validate(edges, "s", { start: { ...start(), knownEntranceFamilyId, inclusiveEntranceFamilyId }, includeUncertainAccess });
      expect(result.valid).toBe(true);
      if (result.valid) expect(result.value.route.startAccessPoint.entranceFamilyId).toBe(includeUncertainAccess ? inclusiveEntranceFamilyId : knownEntranceFamilyId);
    }
    for (const includeUncertainAccess of [false, true]) {
      const result = validate(edges, "s", {
        start: { ...start(), ...(includeUncertainAccess ? { knownEntranceFamilyId } : { inclusiveEntranceFamilyId }) }, includeUncertainAccess,
      });
      expect(result.valid).toBe(true);
      if (result.valid) expect(result.value.route.startAccessPoint).not.toHaveProperty("entranceFamilyId");
    }
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

  test("rejects figure-eight, chained-loop, and complex closed structures", () => {
    const figureEight = validate([
      edge(1, 1, "s", "a"), edge(2, 2, "a", "b"), edge(3, 3, "b", "s"),
      edge(4, 4, "s", "c"), edge(5, 5, "c", "d"), edge(6, 6, "d", "s"),
    ]);
    expect(figureEight).toEqual({ valid: false, reason: "unsupported-route-shape" });

    const chained = validate([
      edge(10, 10, "s", "a"), edge(11, 11, "a", "b"), edge(12, 12, "b", "s"),
      edge(13, 13, "s", "x"), edge(14, 14, "x", "c"), edge(15, 15, "c", "d"),
      edge(16, 16, "d", "x"), edge(17, 13, "x", "s"),
    ]);
    expect(chained).toEqual({ valid: false, reason: "unsupported-route-shape" });

    const complex = validate([
      edge(20, 20, "s", "a"), edge(21, 21, "a", "b"), edge(22, 22, "b", "s"),
      edge(23, 20, "s", "a"), edge(24, 24, "a", "s"),
    ]);
    expect(complex).toEqual({ valid: false, reason: "unsupported-route-shape" });
  });

  test("rejects a branched stem, extra spur, and repeated laps despite a single physical cycle", () => {
    const loop = [edge(2, 2, "h", "a"), edge(3, 3, "a", "b"), edge(4, 4, "b", "h")];
    const walks = [
      [edge(1, 1, "s", "h"), edge(5, 5, "h", "x"), edge(6, 5, "x", "h"), ...loop, edge(7, 1, "h", "s")],
      [edge(1, 1, "s", "h"), ...loop, ...loop, edge(7, 1, "h", "s")],
      [edge(1, 1, "s", "h"), loop[0]!, edge(5, 5, "a", "x"), edge(6, 5, "x", "a"), ...loop.slice(1), edge(7, 1, "h", "s")],
    ];
    for (const walk of walks) expect(validate(walk)).toEqual({ valid: false, reason: "unsupported-route-shape" });
  });

  test("rejects pure out-and-back, wrong direction, access, and coverage", () => {
    expect(validate([edge(1, 1, "s", "h"), edge(2, 1, "h", "s")])).toEqual({
      valid: false,
      reason: "unsupported-route-shape",
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
