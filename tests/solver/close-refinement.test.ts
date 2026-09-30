import { describe, expect, it } from "vitest";

import { searchCompletionForReasons, type SolverBudget } from "@/lib/solver/budget";
import { searchSimpleRoutes } from "@/lib/solver/simple-route-search";
import type { RouteSearchRequest } from "@/lib/solver/types";
import { enumerateSimpleRoutes, oracleGraph, physicalLoopKey, type PhysicalTrail } from "./helpers/simple-route-oracle";

const meters = (min: number, max: number) => ({ min: min / 1_609.344, max: max / 1_609.344 });
const budget = (maximumExpandedStates: number): SolverBudget => ({
  maximumDirectedEdges: 40_000,
  maximumExpandedStates,
  maximumRetainedCycles: 8_000,
  maximumRetainedBytes: 32 * 1024 * 1024,
  deadlineMs: 100_000,
});

function grid(size: number) {
  const trails: PhysicalTrail[] = [];
  const node = (row: number, column: number) => row === 0 && column === 0 ? "s" : `${row}-${column}`;
  const add = (from: string, to: string) => trails.push({
    id: trails.length + 1, from, to, length: 100, gain: 1, reverseGain: 1,
  });
  for (let row = 0; row < size; row += 1) {
    for (let column = 0; column < size; column += 1) {
      if (row + 1 < size) add(node(row, column), node(row + 1, column));
      if (column + 1 < size) add(node(row, column), node(row, column + 1));
    }
  }
  return oracleGraph(trails);
}

const maximumGain = 0.5;
const noExactCriteria: RouteSearchRequest = {
  distanceMiles: meters(500, 2_000),
  elevationGainFeet: { min: 0, max: maximumGain / 0.3048 },
  closedRoute: { maximumRepeatedTrailPct: 0 },
  includeUncertainAccess: true,
  limit: 10,
};

describe("close refinement after exact exploration", () => {
  it.each([1_000, 2_000, 100_000, 200_000])(
    "finishes a proven-empty exact search with useful close results at %i states",
    (maximumExpandedStates) => {
      const graph = grid(6);
      // Independent infeasibility certificate: every directed edge exceeds the
      // entire requested gain cap. Every nonempty loop/lollipop must fail it.
      // This proof needs neither production pruning nor a huge route oracle.
      expect(graph.edges.every(edge => edge.gainMeters > maximumGain)).toBe(true);
      const allowance = budget(maximumExpandedStates);
      const result = searchSimpleRoutes(graph, "s", noExactCriteria, {
        budget: allowance, now: () => 0, maximumRouteOverlapFraction: 1,
      });

      expect(result.candidates).toEqual([]);
      expect(result.diagnostics.validCandidateCount).toBe(0);
      expect(result.nearCandidates.length).toBeGreaterThan(0);
      for (const candidate of result.nearCandidates) {
        expect(candidate.violatedConstraints).toContain("gain-above-maximum");
        expect(candidate.traversals[0]!.from.id).toBe("s");
        expect(candidate.traversals.at(-1)!.to.id).toBe("s");
      }
      expect(result.diagnostics.truncationReasons).toEqual([]);
      expect(searchCompletionForReasons(result.diagnostics.truncationReasons, allowance)).toBe("exhausted");
      expect(result.diagnostics.closeMatchTruncationReasons).toContain("maximum-expanded-states");
      expect(result.diagnostics.expandedStates).toBeLessThanOrEqual(maximumExpandedStates);
      // The exact proof examines only the start's outgoing edges after the
      // return-distance pass. Leave a full graph-sized margin for that work;
      // increasing exact allowance must not scale the close fallback past 50k.
      expect(result.diagnostics.expandedStates).toBeLessThanOrEqual(50_000 + graph.edges.length);
    },
  );

  it("keeps the close deadline independent of a much longer exact allowance", () => {
    let clock = 0;
    const allowance = budget(200_000);
    const result = searchSimpleRoutes(grid(6), "s", noExactCriteria, {
      budget: allowance, now: () => clock++, maximumRouteOverlapFraction: 1,
    });
    expect(result.nearCandidates.length).toBeGreaterThan(0);
    expect(result.diagnostics.truncationReasons).toEqual([]);
    expect(searchCompletionForReasons(result.diagnostics.truncationReasons, allowance)).toBe("exhausted");
    expect(result.diagnostics.closeMatchTruncationReasons).toContain("deadline");
    // The fake clock advances per budget check, so this is deterministic and
    // does not depend on machine speed. Include generous preprocessing room.
    expect(result.diagnostics.elapsedMs).toBeLessThan(2_000);
  });

  it.each([
    { name: "distinct-cycle capacity", limits: { maximumRetainedCycles: 1 }, reason: "maximum-retained-cycles", keepsClose: true },
    { name: "candidate memory capacity", limits: { maximumRetainedBytes: 1 }, reason: "candidate-memory-limit", keepsClose: false },
  ])("does not turn close-only $name into unfinished exact exploration", ({ limits, reason, keepsClose }) => {
    const allowance = { ...budget(100_000), ...limits };
    const result = searchSimpleRoutes(grid(6), "s", noExactCriteria, {
      budget: allowance, now: () => 0, maximumRouteOverlapFraction: 1,
    });
    expect(result.candidates).toEqual([]);
    expect(result.diagnostics.truncationReasons).toEqual([]);
    expect(searchCompletionForReasons(result.diagnostics.truncationReasons, allowance)).toBe("exhausted");
    expect(result.diagnostics.closeMatchTruncationReasons).toContain(reason);
    if (keepsClose) expect(result.nearCandidates).toHaveLength(1);
  });

  it("keeps genuinely interrupted exact exploration retryable and finds the oracle's loops with more work", () => {
    const graph = grid(3);
    const criteria: RouteSearchRequest = {
      distanceMiles: meters(500, 900),
      closedRoute: { maximumRepeatedTrailPct: 0 },
      includeUncertainAccess: true,
      limit: 8_000,
    };
    const expected = new Set(enumerateSimpleRoutes(graph, "s", criteria)
      .filter(({ violations }) => violations.length === 0).map(({ loopKey }) => loopKey));
    expect(expected.size).toBe(6);

    const small = budget(30);
    const interrupted = searchSimpleRoutes(graph, "s", criteria, {
      budget: small, now: () => 0, maximumRouteOverlapFraction: 1,
    });
    expect(interrupted.candidates).toEqual([]);
    expect(interrupted.diagnostics.truncationReasons).toContain("exact-search-limit");
    expect(searchCompletionForReasons(interrupted.diagnostics.truncationReasons, small)).toBe("retryable");

    const large = budget(10_000);
    const complete = searchSimpleRoutes(graph, "s", criteria, {
      budget: large, now: () => 0, maximumRouteOverlapFraction: 1,
    });
    expect(new Set(complete.candidates.map(({ traversals }) => physicalLoopKey(traversals.map(({ edge }) => edge)))))
      .toEqual(expected);
    expect(searchCompletionForReasons(complete.diagnostics.truncationReasons, large)).toBe("exhausted");
  });
});
