export type SolverBudget = {
  maximumDirectedEdges: number;
  maximumExpandedStates: number;
  deadlineMs: number;
  maximumRetainedCycles: number;
  /** Accounted candidate payload, in addition to the distinct-cycle cap. */
  maximumRetainedBytes?: number;
};

export const CLOSED_ROUTE_BUDGET = Object.freeze({
  maximumDirectedEdges: 40_000,
  maximumExpandedStates: 500_000,
  deadlineMs: 15_000,
  maximumRetainedCycles: 8_000,
  maximumRetainedBytes: 32 * 1024 * 1024,
}) satisfies Readonly<SolverBudget>;

/** Close matches get a bounded fallback, even as exact exploration deepens. */
export const CLOSE_MATCH_BUDGET = Object.freeze({
  maximumExpandedStates: 50_000,
  deadlineMs: 1_500,
});

export type SearchCompletion = "retryable" | "exhausted" | "limited";

// Node timeouts overflow above this value; state counters must remain exact.
export const MAXIMUM_SEARCH_DEADLINE_MS = 2_147_483_647;
export const MAXIMUM_SEARCH_STATES = Number.MAX_SAFE_INTEGER;

/** Replay unfinished starts with increasing work, keeping memory limits fixed. */
export function budgetForSearchAttempt(attempt = 1): SolverBudget {
  if (!Number.isSafeInteger(attempt) || attempt < 1) throw new Error("Invalid search attempt");
  const multiplier = 2 ** Math.min(attempt - 1, 53);
  return {
    ...CLOSED_ROUTE_BUDGET,
    maximumExpandedStates: Math.min(MAXIMUM_SEARCH_STATES, 50_000 * multiplier),
    deadlineMs: Math.min(MAXIMUM_SEARCH_DEADLINE_MS, 1_500 * multiplier),
  };
}

export function searchCompletionForReasons(reasons: readonly string[], budget: SolverBudget): SearchCompletion {
  if (!reasons.length) return "exhausted";
  if (reasons.some(reason => !["deadline", "maximum-expanded-states", "exact-search-limit"].includes(reason))) return "limited";
  if (reasons.includes("deadline") && budget.deadlineMs >= MAXIMUM_SEARCH_DEADLINE_MS) return "limited";
  if (reasons.includes("exact-search-limit") && budget.deadlineMs >= MAXIMUM_SEARCH_DEADLINE_MS) return "limited";
  if (reasons.some(reason => reason !== "deadline") && budget.maximumExpandedStates >= MAXIMUM_SEARCH_STATES) return "limited";
  return "retryable";
}
