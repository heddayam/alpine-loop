export type SolverBudget = {
  maximumDirectedEdges: number;
  maximumExpandedStates: number;
  deadlineMs: number;
  maximumRawCandidates: number;
};

export const CLOSED_ROUTE_BUDGET = Object.freeze({
  maximumDirectedEdges: 40_000,
  maximumExpandedStates: 500_000,
  deadlineMs: 15_000,
  maximumRawCandidates: 8_000,
}) satisfies Readonly<SolverBudget>;
