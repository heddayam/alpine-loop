export type SolverBudget = {
  maximumDirectedEdges: number;
  maximumExpandedStates: number;
  deadlineMs: number;
  maximumRawCandidates: number;
};

export const CLOSED_ROUTE_EFFORT_BUDGETS = Object.freeze({
  quick: Object.freeze({
    maximumDirectedEdges: 10_000,
    maximumExpandedStates: 100_000,
    deadlineMs: 3_000,
    maximumRawCandidates: 2_000,
  }),
  thorough: Object.freeze({
    maximumDirectedEdges: 40_000,
    maximumExpandedStates: 500_000,
    deadlineMs: 15_000,
    maximumRawCandidates: 8_000,
  }),
}) satisfies Readonly<Record<"quick" | "thorough", Readonly<SolverBudget>>>;
