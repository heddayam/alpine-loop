import { describe, expect, it } from "vitest";

import { enumerateSimpleRoutes, oracleGraph, physicalLoopKey, type PhysicalTrail } from "@/tests/solver/helpers/simple-route-oracle";
import { searchSimpleRoutes } from "./simple-route-search";
import { searchCompletionForReasons } from "./budget";
import type { RouteSearchRequest } from "./types";

const meters = (min: number, max: number) => ({ min: min / 1_609.344, max: max / 1_609.344 });
const budget = {
  maximumDirectedEdges: 40_000, maximumExpandedStates: 1_000, maximumRetainedCycles: 8_000, deadlineMs: 15_000,
};

function grid(size: number, hilly = false) {
  const trails: PhysicalTrail[] = [];
  const node = (row: number, column: number) => row === 0 && column === 0 ? "s" : `${row}-${column}`;
  const edge = (from: string, to: string): PhysicalTrail => {
    const id = trails.length + 1;
    const gain = hilly ? id % 5 === 0 ? 400 : 10 : 0;
    return { id, from, to, length: 300, gain, reverseGain: gain };
  };
  for (let row = 0; row < size; row += 1) {
    for (let column = 0; column < size; column += 1) {
      if (row + 1 < size) trails.push(edge(node(row, column), node(row + 1, column)));
      if (column + 1 < size) trails.push(edge(node(row, column), node(row, column + 1)));
    }
  }
  return oracleGraph(trails);
}

describe("route-search coverage within fixed work", () => {
  it.each([
    { name: "ordinary intersecting trails", hilly: false, repetition: 0, floor: 20 },
    { name: "steep branches above the gain cap", hilly: true, repetition: 15, floor: 15 },
  ])("finds useful loop coverage among $name before exhausting 1,000 states", ({ hilly, repetition, floor }) => {
    const graph = grid(6, hilly);
    const criteria: RouteSearchRequest = {
      distanceMiles: meters(2_000, 5_000), closedRoute: { maximumRepeatedTrailPct: repetition },
      includeUncertainAccess: true, limit: 8_000,
      ...(hilly ? { elevationGainFeet: { min: 0, max: 250 / 0.3048 } } : {}),
    };
    const result = searchSimpleRoutes(graph, "s", criteria, {
      budget, now: () => 0, maximumRouteOverlapFraction: 1,
    });
    // Before exact/resource pruning these same measured fixtures yielded four
    // and zero distinct exact loops. Count physical cycles, not orientations.
    const loops = new Set(result.candidates.map(({ traversals }) => physicalLoopKey(traversals.map(({ edge }) => edge))));
    expect(loops.size).toBeGreaterThanOrEqual(floor);
    expect(result.diagnostics.expandedStates).toBeLessThanOrEqual(1_000);
    expect(result.diagnostics.truncationReasons).toContain("maximum-expanded-states");
    expect(result.candidates.every(({ violatedConstraints }) => violatedConstraints.length === 0)).toBe(true);
  });

  it("keeps the oracle's suitable loops while avoiding long bridge approaches", () => {
    const trails: PhysicalTrail[] = [];
    const add = (from: string, to: string, length: number) => trails.push({ id: trails.length + 1, from, to, length });
    for (let index = 0; index < 50; index += 1) {
      const hub = index === 0 ? "s" : `hub-${index}`;
      if (index > 0) add(index === 1 ? "s" : `hub-${index - 1}`, hub, 100);
      add(hub, `a-${index}`, 300);
      add(`a-${index}`, `b-${index}`, 300);
      add(`b-${index}`, hub, 300);
    }
    const graph = oracleGraph(trails);
    const criteria: RouteSearchRequest = {
      distanceMiles: meters(500, 6_000), closedRoute: { maximumRepeatedTrailPct: 15 },
      includeUncertainAccess: true, limit: 8_000,
    };
    const expected = new Set(enumerateSimpleRoutes(graph, "s", criteria)
      .filter(({ violations }) => violations.length === 0).map(({ loopKey }) => loopKey));
    const result = searchSimpleRoutes(graph, "s", criteria, {
      budget, now: () => 0, maximumRouteOverlapFraction: 1,
    });
    expect(expected.size).toBe(2);
    expect(new Set(result.candidates.map(({ traversals }) => physicalLoopKey(traversals.map(({ edge }) => edge)))))
      .toEqual(expected);
    // The same contracted graph previously took 201 expansions and 76 offers.
    // Leave headroom above the measured 89 expansions and four offers.
    expect(result.diagnostics.expandedStates).toBeLessThan(130);
    expect(result.diagnostics.candidateCount).toBeLessThan(15);
    expect(result.diagnostics.truncationReasons).toEqual([]);
  });

  it("keeps the close-match reserve when a residual bound reaches the exact-search limit", () => {
    const result = searchSimpleRoutes(grid(5), "s", {
      distanceMiles: meters(2_500, 2_700), closedRoute: { maximumRepeatedTrailPct: 0 },
      includeUncertainAccess: true, limit: 10,
    }, { budget: { ...budget, maximumExpandedStates: 78 }, now: () => 0 });
    expect(result.candidates).toEqual([]);
    // Residual shortest-path work used to consume all 78 states before the
    // outer traversal could yield its reserved part to close-match discovery.
    expect(result.diagnostics.truncationReasons).toContain("exact-search-limit");
    expect(result.diagnostics.expandedStates).toBeLessThanOrEqual(78);
  });
});

describe("physical-cycle retention budgets", () => {
  const criteria: RouteSearchRequest = {
    distanceMiles: meters(500, 1_000), closedRoute: { maximumRepeatedTrailPct: 55 },
    includeUncertainAccess: true, limit: 10,
  };

  it("can replace a worse direction at capacity and finish without a false limit", () => {
    const graph = oracleGraph([
      { id: 1, from: "s", to: "a", length: 200, gain: 25, reverseGain: 10 },
      { id: 2, from: "a", to: "b", length: 200, gain: 25, reverseGain: 10 },
      { id: 3, from: "b", to: "s", length: 200, gain: 25, reverseGain: 10 },
    ]);
    const result = searchSimpleRoutes(graph, "s", {
      ...criteria, elevationGainFeet: { min: 0, max: 80 / 0.3048 },
    }, { budget: { ...budget, maximumRetainedCycles: 1 }, now: () => 0 });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.elevationGainMeters).toBe(30);
    expect(result.diagnostics.candidateCount).toBeGreaterThan(1);
    expect(result.diagnostics.truncationReasons).toEqual([]);
  });

  it("does not spend the cycle allowance on repeated approaches before discovering a separate loop", () => {
    const graph = oracleGraph([
      { id: 1, from: "s", to: "p", length: 100 },
      { id: 2, from: "s", to: "p", length: 110 },
      { id: 3, from: "p", to: "a", length: 200 },
      { id: 4, from: "a", to: "b", length: 200 },
      { id: 5, from: "b", to: "p", length: 200 },
      { id: 6, from: "s", to: "x", length: 280 },
      { id: 7, from: "x", to: "y", length: 280 },
      { id: 8, from: "y", to: "s", length: 280 },
    ]);
    const request = { ...criteria, distanceMiles: meters(750, 950) };
    const expected = new Set(enumerateSimpleRoutes(graph, "s", request)
      .filter(({ violations }) => violations.length === 0).map(({ loopKey }) => loopKey));
    expect(expected).toEqual(new Set(["3,4,5", "6,7,8"]));
    const result = searchSimpleRoutes(graph, "s", request, {
      budget: { ...budget, maximumRetainedCycles: 2 }, now: () => 0,
    });
    expect(new Set(result.candidates.map(({ traversals }) => physicalLoopKey(traversals.map(({ edge }) => edge)))))
      .toEqual(expected);
    expect(result.diagnostics.candidateCount).toBeGreaterThan(2);
    expect(result.diagnostics.truncationReasons).toEqual([]);
    expect(searchCompletionForReasons(result.diagnostics.truncationReasons, budget)).toBe("exhausted");
  });

  it("reports a hard limit only when another distinct cycle exceeds the retention allowance", () => {
    const trails: PhysicalTrail[] = [];
    for (let index = 0; index < 3; index += 1) {
      trails.push(
        { id: index * 3 + 1, from: "s", to: `a${index}`, length: 200 },
        { id: index * 3 + 2, from: `a${index}`, to: `b${index}`, length: 200 },
        { id: index * 3 + 3, from: `b${index}`, to: "s", length: 200 },
      );
    }
    const retainedBudget = { ...budget, maximumRetainedCycles: 2 };
    const result = searchSimpleRoutes(oracleGraph(trails), "s", criteria, { budget: retainedBudget, now: () => 0 });
    expect(result.candidates).toHaveLength(2);
    expect(result.diagnostics.truncationReasons).toContain("maximum-retained-cycles");
    expect(result.diagnostics.truncationReasons).not.toContain("maximum-raw-candidates");
    expect(searchCompletionForReasons(result.diagnostics.truncationReasons, retainedBudget)).toBe("limited");
  });

  it("reports candidate memory exhaustion without retaining an oversized first candidate", () => {
    const graph = oracleGraph([
      { id: 1, from: "s", to: "a", length: 200 },
      { id: 2, from: "a", to: "b", length: 200 },
      { id: 3, from: "b", to: "s", length: 200 },
    ]);
    const retainedBudget = { ...budget, maximumRetainedBytes: 1 };
    const result = searchSimpleRoutes(graph, "s", criteria, { budget: retainedBudget, now: () => 0 });
    expect(result.candidates).toEqual([]);
    expect(result.diagnostics.truncationReasons).toContain("candidate-memory-limit");
    expect(searchCompletionForReasons(result.diagnostics.truncationReasons, retainedBudget)).toBe("limited");
  });
});
