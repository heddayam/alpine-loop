export type SolverBudget = {
  maximumDirectedEdges: number;
  maximumExpandedStates: number;
  deadlineMs: number;
  maximumRawCandidates: number;
};

export const DEFAULT_SOLVER_BUDGET: Readonly<SolverBudget> = Object.freeze({
  maximumDirectedEdges: 10_000,
  maximumExpandedStates: 100_000,
  deadlineMs: 3_000,
  maximumRawCandidates: 2_000,
});
