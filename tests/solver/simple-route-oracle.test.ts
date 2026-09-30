import { describe, expect, it } from "vitest";

import type { InducedGraph } from "@/lib/graph";
import { searchSimpleRoutes } from "@/lib/solver/simple-route-search";
import type { RouteSearchRequest } from "@/lib/solver/types";

import {
  directedKey,
  enumerateSimpleRoutes,
  oracleGraph,
  physicalLoopKey,
  type PhysicalTrail,
} from "./helpers/simple-route-oracle";

const meters = (min: number, max: number) => ({ min: min / 1_609.344, max: max / 1_609.344 });
const feet = (min: number, max: number) => ({ min: min / 0.3048, max: max / 0.3048 });
const budget = {
  maximumDirectedEdges: 10_000, maximumExpandedStates: 1_000_000,
  maximumRetainedCycles: 100_000, deadlineMs: 10_000,
};

function request(overrides: Partial<RouteSearchRequest> = {}): RouteSearchRequest {
  return {
    distanceMiles: meters(0, 10_000), closedRoute: { maximumRepeatedTrailPct: 55 },
    includeUncertainAccess: true, limit: 1_000, ...overrides,
  };
}

function compareOracle(graph: InducedGraph, criteria = request()): void {
  const reference = enumerateSimpleRoutes(graph, "s", criteria);
  const exact = reference.filter(({ violations }) => violations.length === 0);
  const result = searchSimpleRoutes(graph, "s", criteria, {
    budget, now: () => 0, maximumRouteOverlapFraction: 1,
  });
  // These fixtures are intentionally below the old archive cap. A failure is
  // semantic coverage loss, not an arbitrary output/budget limit in the test.
  expect(exact.length).toBeLessThan(256);
  expect(new Set(result.candidates.map(({ traversals }) => physicalLoopKey(traversals.map(({ edge }) => edge)))))
    .toEqual(new Set(exact.map(({ loopKey }) => loopKey)));
  const byTraversal = new Map(reference.map((route) => [directedKey(route.edges), route]));
  for (const candidate of result.candidates) {
    const route = byTraversal.get(directedKey(candidate.traversals.map(({ edge }) => edge)));
    expect(route, "Every result must be an independently enumerated simple loop/lollipop").toBeDefined();
    expect(route!.violations).toEqual([]);
    expect(candidate.distanceMeters).toBeCloseTo(route!.distance, 9);
    expect(candidate.elevationGainMeters).toBeCloseTo(route!.gain, 9);
    expect(candidate.repeatedEdgeFraction).toBeCloseTo(route!.repeatedDistance / route!.distance, 9);
  }
  expect(result.diagnostics.truncationReasons.filter((reason) => !reason.includes("archive"))).toEqual([]);
}

describe("independent simple-route coverage oracle", () => {
  it("counts a triangle as one physical loop with two legal directions", () => {
    const graph = oracleGraph([
      { id: 1, from: "s", to: "a", length: 200 },
      { id: 2, from: "a", to: "b", length: 200 },
      { id: 3, from: "b", to: "s", length: 200 },
    ]);
    const reference = enumerateSimpleRoutes(graph, "s", request());
    expect(reference).toHaveLength(2);
    expect(new Set(reference.map(({ loopKey }) => loopKey))).toEqual(new Set(["1,2,3"]));
    compareOracle(graph);
  });

  it("preserves distinct parallel trails and physical self loops", () => {
    const graph = oracleGraph([
      { id: 1, from: "s", to: "a", length: 200 },
      { id: 2, from: "s", to: "a", length: 300 },
      { id: 3, from: "a", to: "a", length: 100, oneWay: true },
      { id: 4, from: "s", to: "s", length: 150, oneWay: true },
    ]);
    expect(new Set(enumerateSimpleRoutes(graph, "s", request()).map(({ loopKey }) => loopKey)))
      .toEqual(new Set(["1,2", "3", "4"]));
    compareOracle(graph);
  });

  it("uses actual direction-dependent return length and gain on a reversible stem", () => {
    const graph = oracleGraph([
      { id: 1, from: "s", to: "p", length: 90, reverseLength: 250, gain: 7, reverseGain: 50 },
      { id: 2, from: "p", to: "a", length: 200, oneWay: true, gain: 10 },
      { id: 3, from: "a", to: "b", length: 200, oneWay: true, gain: 20 },
      { id: 4, from: "b", to: "p", length: 200, oneWay: true, gain: 10 },
    ]);
    const criteria = request({
      distanceMiles: meters(930, 950), elevationGainFeet: feet(90, 110),
      closedRoute: { maximumRepeatedTrailPct: 27, maximumSharedStemMiles: 100 / 1_609.344 },
    });
    const reference = enumerateSimpleRoutes(graph, "s", criteria).filter(({ violations }) => violations.length === 0);
    expect(reference).toHaveLength(1);
    expect(reference[0]).toMatchObject({ distance: 940, gain: 97, stemDistance: 90, repeatedDistance: 250 });
    compareOracle(graph, criteria);
  });

  it("retains a longer stem when only it meets the requested minimum distance", () => {
    const graph = oracleGraph([
      { id: 1, from: "s", to: "p", length: 100 },
      { id: 2, from: "s", to: "b", length: 75 },
      { id: 3, from: "b", to: "p", length: 75 },
      { id: 4, from: "p", to: "x", length: 300 },
      { id: 5, from: "x", to: "y", length: 300 },
      { id: 6, from: "y", to: "p", length: 300 },
    ]);
    const criteria = request({ distanceMiles: meters(1_180, 1_220) });
    const exact = enumerateSimpleRoutes(graph, "s", criteria).filter(({ violations }) => violations.length === 0);
    expect(exact.length).toBeGreaterThan(0);
    expect(exact.every(({ stemDistance }) => stemDistance === 150)).toBe(true);
    compareOracle(graph, criteria);
  });

  it.each([false, true])("applies explicit unknown-access eligibility (%s)", (includeUncertainAccess) => {
    const graph = oracleGraph([
      { id: 1, from: "s", to: "a", length: 200 },
      { id: 2, from: "a", to: "b", length: 200, access: "unknown" },
      { id: 3, from: "b", to: "s", length: 200 },
      { id: 4, from: "b", to: "s", length: 150, access: "private" },
      { id: 5, from: "b", to: "s", length: 170, access: "prohibited" },
    ]);
    compareOracle(graph, request({ includeUncertainAccess }));
  });

  it("never treats an irreversible stem or an additional lobe as a legal lollipop", () => {
    const graph = oracleGraph([
      { id: 1, from: "s", to: "a", length: 100 },
      { id: 2, from: "a", to: "b", length: 100 },
      { id: 3, from: "b", to: "s", length: 100 },
      { id: 4, from: "s", to: "p", length: 100, oneWay: true },
      { id: 5, from: "p", to: "x", length: 100 },
      { id: 6, from: "x", to: "y", length: 100 },
      { id: 7, from: "y", to: "p", length: 100 },
    ]);
    const reference = enumerateSimpleRoutes(graph, "s", request());
    expect(new Set(reference.map(({ loopKey }) => loopKey))).toEqual(new Set(["1,2,3"]));
    compareOracle(graph);
  });

  it("matches 40 deterministic weighted directed multigraphs under independent resource ranges", () => {
    let state = 0x41c64e6d;
    const random = () => { state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0; return state / 2 ** 32; };
    for (let example = 0; example < 40; example += 1) {
      const ids = ["s", "a", "b", "c", "d"];
      const trails: PhysicalTrail[] = Array.from({ length: 7 }, (_, index) => ({
        id: index + 1, from: ids[Math.floor(random() * ids.length)]!, to: ids[Math.floor(random() * ids.length)]!,
        length: 50 + Math.floor(random() * 300), oneWay: random() < 0.4,
        gain: Math.floor(random() * 40), reverseGain: Math.floor(random() * 40),
        access: random() < 0.25 ? "unknown" : "public",
      }));
      const graph = oracleGraph(trails);
      compareOracle(graph);
      compareOracle(graph, request({
        distanceMiles: meters(200, 1_000), elevationGainFeet: feet(20, 100),
        closedRoute: { maximumRepeatedTrailPct: 30, maximumSharedStemMiles: 250 / 1_609.344 },
        includeUncertainAccess: false,
      }));
    }
  });

  it("matches 128 asymmetric multigraphs with independently varied minimum and maximum resources", () => {
    let state = 0x13579ace;
    const random = () => { state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0; return state / 2 ** 32; };
    for (let example = 0; example < 128; example += 1) {
      const ids = ["s", "a", "b", "c", "d"];
      const trails: PhysicalTrail[] = Array.from({ length: 8 }, (_, index) => ({
        id: index + 1, from: ids[Math.floor(random() * ids.length)]!, to: ids[Math.floor(random() * ids.length)]!,
        length: 50 + Math.floor(random() * 300), reverseLength: 50 + Math.floor(random() * 300),
        oneWay: random() < 0.3, gain: Math.floor(random() * 40), reverseGain: Math.floor(random() * 40),
        access: random() < 0.2 ? "unknown" : "public",
      }));
      compareOracle(oracleGraph(trails), request({
        includeUncertainAccess: random() < 0.5,
        closedRoute: {
          maximumRepeatedTrailPct: Math.floor(random() * 55),
          maximumSharedStemMiles: Math.floor(random() * 500) / 1_609.344,
        },
        distanceMiles: meters(Math.floor(random() * 400), 400 + Math.floor(random() * 700)),
        elevationGainFeet: feet(Math.floor(random() * 70), 70 + Math.floor(random() * 90)),
      }));
    }
  });

  it("checks maximum-elevation minima against the return stem as well as the outward path", () => {
    const graph = oracleGraph([
      { id: 1, from: "s", to: "p", length: 100 },
      { id: 2, from: "p", to: "a", length: 100 },
      { id: 3, from: "a", to: "b", length: 100 },
      { id: 4, from: "b", to: "p", length: 100 },
      { id: 5, from: "s", to: "x", length: 100 },
      { id: 6, from: "x", to: "y", length: 100 },
      { id: 7, from: "y", to: "s", length: 100 },
    ]);
    // Exercise the directed-record contract without assuming reverse metadata
    // is identical. Another exact loop ensures a fallback cannot mask the loss.
    for (const edge of graph.edges) {
      if (edge.id === "1:back" || edge.physicalEdgeKey! >= 5) edge.maximumElevationMeters = 200;
    }
    const criteria = request({ maximumElevationFeet: feet(150, 250) });
    expect(new Set(enumerateSimpleRoutes(graph, "s", criteria)
      .filter(({ violations }) => violations.length === 0).map(({ loopKey }) => loopKey)))
      .toEqual(new Set(["2,3,4", "5,6,7"]));
    compareOracle(graph, criteria);
  });

  it("does not lose a grade-minimum match whose sustained climb spans edge interiors", () => {
    const graph = oracleGraph([
      { id: 1, from: "s", to: "a", length: 75, oneWay: true, profile: [
        { distanceMeters: 0, elevationMeters: 100 }, { distanceMeters: 25, elevationMeters: 100 },
        { distanceMeters: 50, elevationMeters: 120 }, { distanceMeters: 75, elevationMeters: 100 },
      ] },
      { id: 2, from: "a", to: "b", length: 75, oneWay: true },
      { id: 3, from: "b", to: "s", length: 75, oneWay: true },
    ]);
    const criteria = request({ distanceMiles: meters(200, 250), steepestSustainedGradePct: { min: 15, max: 25 } });
    expect(enumerateSimpleRoutes(graph, "s", criteria)).toMatchObject([{ maximumGrade: 20, violations: [] }]);
    compareOracle(graph, criteria);
  });

  it("retains two distinct loops reached through the same long approach", () => {
    const graph = oracleGraph([
      { id: 1, from: "s", to: "p", length: 2_000 },
      { id: 2, from: "p", to: "a", length: 100 },
      { id: 3, from: "a", to: "b", length: 100 },
      { id: 4, from: "b", to: "p", length: 100 },
      { id: 5, from: "p", to: "x", length: 100 },
      { id: 6, from: "x", to: "y", length: 100 },
      { id: 7, from: "y", to: "p", length: 100 },
    ]);
    const criteria = request({ distanceMiles: meters(4_000, 4_600), limit: 10 });
    const expected = new Set(enumerateSimpleRoutes(graph, "s", criteria)
      .filter(({ violations }) => violations.length === 0).map(({ loopKey }) => loopKey));
    expect(expected).toEqual(new Set(["2,3,4", "5,6,7"]));
    const result = searchSimpleRoutes(graph, "s", criteria, { budget, now: () => 0 });
    expect(new Set(result.candidates.map(({ traversals }) => physicalLoopKey(traversals.map(({ edge }) => edge)))))
      .toEqual(expected);
  });

  it("does not let 257 similar candidates evict a separate suitable loop", () => {
    const graph = oracleGraph([
      { id: 1, from: "s", to: "a", length: 1_000, oneWay: true },
      ...Array.from({ length: 257 }, (_, index) => ({
        id: index + 2, from: "a", to: "b", length: 10, oneWay: true,
      })),
      { id: 259, from: "b", to: "s", length: 1_000, oneWay: true },
      { id: 260, from: "s", to: "x", length: 1_250, oneWay: true },
      { id: 261, from: "x", to: "s", length: 1_250, oneWay: true },
    ]);
    const criteria = request({ distanceMiles: meters(1_000, 3_020), limit: 10 });
    const reference = enumerateSimpleRoutes(graph, "s", criteria).filter(({ violations }) => violations.length === 0);
    expect(reference).toHaveLength(258);
    const result = searchSimpleRoutes(graph, "s", criteria, { budget, now: () => 0 });
    expect(result.candidates.map(({ traversals }) => physicalLoopKey(traversals.map(({ edge }) => edge))))
      .toContain("260,261");
    expect(result.candidates).toHaveLength(2);
  });
});
