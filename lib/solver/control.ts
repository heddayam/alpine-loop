import type { SolverBudget } from "./budget";

export type SearchDiagnostics = {
  elapsedMs: number;
  expandedStates: number;
  candidateCount: number;
  exhausted: boolean;
  truncationReasons: string[];
};

export class RouteSearchCancelledError extends Error {
  constructor(reason?: unknown) {
    super(reason instanceof Error ? reason.message : "Route generation was cancelled");
    this.name = "RouteSearchCancelledError";
    this.cause = reason;
  }
}

export class SearchController {
  readonly #budget: SolverBudget;
  readonly #signal?: AbortSignal;
  readonly #now: () => number;
  readonly #startedAt: number;
  readonly #truncationReasons = new Set<string>();
  #expandedStates = 0;
  #candidateCount = 0;

  constructor(budget: SolverBudget, options: { signal?: AbortSignal; now?: () => number } = {}) {
    this.#budget = budget;
    this.#signal = options.signal;
    this.#now = options.now ?? Date.now;
    this.#startedAt = this.#now();
    this.checkCancellation();
  }

  checkGraphSize(directedEdgeCount: number): boolean {
    this.checkCancellation();
    if (directedEdgeCount <= this.#budget.maximumDirectedEdges) return true;
    this.#truncationReasons.add("maximum-directed-edges");
    return false;
  }

  tryExpand(): boolean {
    this.checkCancellation();
    if (this.#truncationReasons.has("maximum-raw-candidates")) return false;
    if (this.#now() - this.#startedAt >= this.#budget.deadlineMs) {
      this.#truncationReasons.add("deadline");
      return false;
    }
    if (this.#expandedStates >= this.#budget.maximumExpandedStates) {
      this.#truncationReasons.add("maximum-expanded-states");
      return false;
    }
    this.#expandedStates += 1;
    return true;
  }

  tryRecordCandidate(): boolean {
    this.checkCancellation();
    if (this.#candidateCount >= this.#budget.maximumRawCandidates) {
      this.#truncationReasons.add("maximum-raw-candidates");
      return false;
    }
    this.#candidateCount += 1;
    return true;
  }

  absorbWork(diagnostics: Pick<SearchDiagnostics, "expandedStates" | "truncationReasons">): void {
    this.checkCancellation();
    this.#expandedStates = Math.min(
      this.#budget.maximumExpandedStates,
      this.#expandedStates + diagnostics.expandedStates,
    );
    for (const reason of diagnostics.truncationReasons) this.#truncationReasons.add(reason);
  }

  checkCancellation(): void {
    if (this.#signal?.aborted) throw new RouteSearchCancelledError(this.#signal.reason);
  }

  diagnostics(): SearchDiagnostics {
    const truncationReasons = [...this.#truncationReasons].sort();
    return {
      elapsedMs: Math.max(0, this.#now() - this.#startedAt),
      expandedStates: this.#expandedStates,
      candidateCount: this.#candidateCount,
      exhausted: truncationReasons.length > 0,
      truncationReasons,
    };
  }
}
