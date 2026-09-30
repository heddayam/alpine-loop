import { describe, expect, it } from "vitest";

import { oracleGraph, type PhysicalTrail } from "@/tests/solver/helpers/simple-route-oracle";
import { budgetForSearchAttempt, CLOSE_MATCH_BUDGET, searchCompletionForReasons } from "./budget";
import { RouteSearchCancelledError } from "./control";
import { searchSimpleRoutes } from "./simple-route-search";
import type { RouteSearchRequest } from "./types";

// Exact exploration rejects every prefix on elevation. Relaxed exploration
// still has many distinct cycles and approaches, more than its work allowance.
function denseGraph() {
  const trails: PhysicalTrail[] = [];
  const nodes = ["s", "a", "b", "c", "d", "e", "f", "g"];
  for (const [index, from] of nodes.entries()) {
    for (const to of nodes.slice(index + 1)) trails.push({ id: trails.length + 1, from, to, length: 100 });
  }
  return oracleGraph(trails);
}

const request: RouteSearchRequest = {
  distanceMiles: { min: 200 / 1_609.344, max: 1_500 / 1_609.344 },
  maximumElevationFeet: { min: 0, max: 50 },
  closedRoute: { maximumRepeatedTrailPct: 50 },
  includeUncertainAccess: true,
  limit: 10,
};

describe("bounded close-match fallback", () => {
  it("uses at most 50,000 additional states even as exact-search attempts deepen", () => {
    const graph = denseGraph();
    const results = [3, 4].map(attempt => searchSimpleRoutes(graph, "s", request, {
      budget: budgetForSearchAttempt(attempt), now: () => 0,
    }));
    for (const result of results) {
      expect(result.candidates).toEqual([]);
      expect(result.nearCandidates.length).toBeGreaterThan(0);
      expect(result.nearCandidates.every(candidate => candidate.violatedConstraints.includes("maximum-elevation-outside-range"))).toBe(true);
      expect(result.diagnostics.truncationReasons).toEqual([]);
      expect(result.diagnostics.closeMatchTruncationReasons).toEqual(["maximum-expanded-states"]);
      // The exact phase settles each node and rejects each outgoing start
      // edge; only then does the additional fallback allowance begin.
      const exactStates = graph.nodes.size + graph.edges.filter(edge => edge.fromNodeId === "s").length;
      expect(result.diagnostics.expandedStates).toBe(exactStates + CLOSE_MATCH_BUDGET.maximumExpandedStates);
      expect(searchCompletionForReasons(result.diagnostics.truncationReasons, budgetForSearchAttempt(3))).toBe("exhausted");
      expect(result.diagnostics.exhausted).toBe(true);
    }
    expect(results[1]).toEqual(results[0]);
  });

  it("keeps useful close matches when the fixed 1,500ms fallback deadline ends", () => {
    let clock = 0;
    const budget = budgetForSearchAttempt(5);
    const result = searchSimpleRoutes(denseGraph(), "s", request, { budget, now: () => clock++ });
    expect(result.nearCandidates.length).toBeGreaterThan(0);
    expect(result.diagnostics.truncationReasons).toEqual([]);
    expect(result.diagnostics.closeMatchTruncationReasons).toEqual(["deadline"]);
    expect(result.diagnostics.elapsedMs).toBeGreaterThanOrEqual(CLOSE_MATCH_BUDGET.deadlineMs);
    expect(result.diagnostics.elapsedMs).toBeLessThan(2_000);
    expect(result.diagnostics.expandedStates).toBeLessThan(CLOSE_MATCH_BUDGET.maximumExpandedStates);
    expect(searchCompletionForReasons(result.diagnostics.truncationReasons, budget)).toBe("exhausted");
  });

  it("respects the whole-attempt state allowance when less than 50,000 states remain", () => {
    const budget = { ...budgetForSearchAttempt(1), maximumExpandedStates: 1_000 };
    const result = searchSimpleRoutes(denseGraph(), "s", request, { budget, now: () => 0 });
    expect(result.nearCandidates.length).toBeGreaterThan(0);
    expect(result.diagnostics.expandedStates).toBe(1_000);
    expect(result.diagnostics.truncationReasons).toEqual([]);
    expect(result.diagnostics.closeMatchTruncationReasons).toEqual(["maximum-expanded-states"]);
  });

  it("respects the remaining whole-attempt time without labeling exact exploration incomplete", () => {
    let clock = 0;
    const budget = { ...budgetForSearchAttempt(3), deadlineMs: 100 };
    const result = searchSimpleRoutes(denseGraph(), "s", request, { budget, now: () => clock++ });
    expect(result.nearCandidates.length).toBeGreaterThan(0);
    expect(result.diagnostics.truncationReasons).toEqual([]);
    expect(result.diagnostics.closeMatchTruncationReasons).toEqual(["deadline"]);
    expect(result.diagnostics.elapsedMs).toBeLessThanOrEqual(101);
  });

  it("reports no fallback limit when a small close-only search finishes", () => {
    const graph = oracleGraph([
      { id: 1, from: "s", to: "a", length: 100 },
      { id: 2, from: "a", to: "b", length: 100 },
      { id: 3, from: "b", to: "s", length: 100 },
    ]);
    const result = searchSimpleRoutes(graph, "s", request, { budget: budgetForSearchAttempt(1), now: () => 0 });
    expect(result.candidates).toEqual([]);
    expect(result.nearCandidates).toHaveLength(1);
    expect(result.diagnostics.truncationReasons).toEqual([]);
    expect(result.diagnostics.closeMatchTruncationReasons).toEqual([]);
    expect(result.diagnostics.exhausted).toBe(false);
  });

  it("leaves exact routes and their hard archive limit independent of the fallback", () => {
    const budget = { ...budgetForSearchAttempt(1), maximumRetainedCycles: 2 };
    const result = searchSimpleRoutes(denseGraph(), "s", { ...request, maximumElevationFeet: undefined }, {
      budget, now: () => 0,
    });
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates.every(candidate => candidate.violatedConstraints.length === 0)).toBe(true);
    expect(result.diagnostics.truncationReasons).toEqual(["maximum-retained-cycles"]);
    expect(result.diagnostics.closeMatchTruncationReasons).toEqual([]);
    expect(searchCompletionForReasons(result.diagnostics.truncationReasons, budget)).toBe("limited");
  });

  it("still honors cancellation during the close-only fallback", () => {
    const controller = new AbortController();
    let clock = 0;
    expect(() => searchSimpleRoutes(denseGraph(), "s", request, {
      budget: budgetForSearchAttempt(3), signal: controller.signal,
      now: () => {
        if (++clock === 100) controller.abort("Stopped");
        return clock;
      },
    })).toThrow(RouteSearchCancelledError);
  });
});
