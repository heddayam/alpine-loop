import { describe, expect, it } from "vitest";

import {
  budgetForSearchAttempt, CLOSED_ROUTE_BUDGET, MAXIMUM_SEARCH_DEADLINE_MS,
  MAXIMUM_SEARCH_STATES, searchCompletionForReasons, type SearchCompletion,
} from "./budget";

describe("progressively expanded route-search budgets", () => {
  it("starts interactively and grows past the former fixed time/state limits without growing retained memory", () => {
    expect(budgetForSearchAttempt()).toEqual(budgetForSearchAttempt(1));
    expect(budgetForSearchAttempt(1)).toMatchObject({ maximumExpandedStates: 50_000, deadlineMs: 1_500 });
    expect(budgetForSearchAttempt(2)).toMatchObject({ maximumExpandedStates: 100_000, deadlineMs: 3_000 });
    const later = budgetForSearchAttempt(5);
    expect(later.maximumExpandedStates).toBeGreaterThan(CLOSED_ROUTE_BUDGET.maximumExpandedStates);
    expect(later.deadlineMs).toBeGreaterThan(CLOSED_ROUTE_BUDGET.deadlineMs);
    for (const attempt of [1, 2, 5, 20, 50, Number.MAX_SAFE_INTEGER]) {
      expect(budgetForSearchAttempt(attempt)).toMatchObject({
        maximumDirectedEdges: 40_000, maximumRetainedCycles: 8_000, maximumRetainedBytes: 32 * 1_024 * 1_024,
      });
    }
  });

  it.each([0, -1, 1.5, Number.NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid attempt %s", (attempt) => expect(() => budgetForSearchAttempt(attempt)).toThrow("Invalid search attempt"),
  );

  it("saturates at finite safe ceilings without overflow or a decreasing work allowance", () => {
    let previous = budgetForSearchAttempt(1);
    for (let attempt = 2; attempt <= 64; attempt += 1) {
      const next = budgetForSearchAttempt(attempt);
      expect(Number.isSafeInteger(next.maximumExpandedStates)).toBe(true);
      expect(Number.isSafeInteger(next.deadlineMs)).toBe(true);
      expect(next.maximumExpandedStates).toBeGreaterThanOrEqual(previous.maximumExpandedStates);
      expect(next.maximumExpandedStates).toBeLessThanOrEqual(MAXIMUM_SEARCH_STATES);
      expect(next.deadlineMs).toBeGreaterThanOrEqual(previous.deadlineMs);
      expect(next.deadlineMs).toBeLessThanOrEqual(MAXIMUM_SEARCH_DEADLINE_MS);
      previous = next;
    }
    expect(budgetForSearchAttempt(Number.MAX_SAFE_INTEGER)).toMatchObject({
      maximumExpandedStates: MAXIMUM_SEARCH_STATES, deadlineMs: MAXIMUM_SEARCH_DEADLINE_MS,
    });
  });
});

describe("truthful route-search completion", () => {
  it.each([
    { reasons: [], completion: "exhausted" },
    { reasons: ["deadline"], completion: "retryable" },
    { reasons: ["maximum-expanded-states"], completion: "retryable" },
    { reasons: ["exact-search-limit"], completion: "retryable" },
    { reasons: ["deadline", "maximum-expanded-states"], completion: "retryable" },
    { reasons: ["maximum-directed-edges"], completion: "limited" },
    { reasons: ["maximum-retained-cycles"], completion: "limited" },
    { reasons: ["candidate-memory-limit"], completion: "limited" },
    { reasons: ["deadline", "candidate-memory-limit"], completion: "limited" },
    { reasons: ["unrecognized-future-limit"], completion: "limited" },
  ] satisfies Array<{ reasons: string[]; completion: SearchCompletion }>)
  ("classifies $reasons as $completion", ({ reasons, completion }) => {
    expect(searchCompletionForReasons(reasons, budgetForSearchAttempt(1))).toBe(completion);
  });

  it("does not retry a saturated limiting resource or call a hard limit exhaustion", () => {
    const first = budgetForSearchAttempt(1);
    const timeCeiling = { ...first, deadlineMs: MAXIMUM_SEARCH_DEADLINE_MS };
    const stateCeiling = { ...first, maximumExpandedStates: MAXIMUM_SEARCH_STATES };
    expect(searchCompletionForReasons(["deadline"], timeCeiling)).toBe("limited");
    expect(searchCompletionForReasons(["maximum-expanded-states"], stateCeiling)).toBe("limited");
    expect(searchCompletionForReasons(["exact-search-limit"], timeCeiling)).toBe("limited");
    expect(searchCompletionForReasons(["exact-search-limit"], stateCeiling)).toBe("limited");
    expect(searchCompletionForReasons([], { ...timeCeiling, ...stateCeiling })).toBe("exhausted");
    // The other resource may still grow when it caused the actual stop.
    expect(searchCompletionForReasons(["deadline"], stateCeiling)).toBe("retryable");
    expect(searchCompletionForReasons(["maximum-expanded-states"], timeCeiling)).toBe("retryable");
  });
});
