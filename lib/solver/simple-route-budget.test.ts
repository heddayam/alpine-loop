import { describe, expect, it } from "vitest";

import { enumerateSimpleRoutes, oracleGraph, physicalLoopKey, type PhysicalTrail } from "@/tests/solver/helpers/simple-route-oracle";
import { searchSimpleRoutes } from "./simple-route-search";
import type { RouteSearchRequest } from "./types";

const meters = (min: number, max: number) => ({ min: min / 1_609.344, max: max / 1_609.344 });
const budget = {
  maximumDirectedEdges: 40_000, maximumExpandedStates: 1_000, maximumRawCandidates: 8_000, deadlineMs: 15_000,
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
