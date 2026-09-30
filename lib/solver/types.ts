import type { GeneratedClosedRouteV3, ConstraintViolationV3, RouteCriteria } from "@/lib/contracts";
import type { AreaGeometry } from "@/lib/graph";
import type { SearchCompletion } from "./budget";

export type ResolvedAccessFilterContext = {
  predicates: readonly AreaGeometry[];
  namedRegionPredicateIndex?: number;
  /** Replaces the named polygon predicate with actual installed entrance membership. */
  namedRegionIds?: readonly string[];
  coverage: AreaGeometry;
};

export type RouteSearchPolicy = {
  limit: number;
  startAccessPointId?: string;
};

export type RouteSearchRequest = RouteCriteria & RouteSearchPolicy;

export type RouteSearchResult = {
  completion?: SearchCompletion;
  exact: GeneratedClosedRouteV3[];
  nearMisses: Array<GeneratedClosedRouteV3 & { violations: ConstraintViolationV3[] }>;
  diagnostics: {
    elapsedMs: number;
    expandedStates: number;
    candidateCount: number;
    eligibleAccessPointCount: number;
    searchedAccessPointCount: number;
    graphQueryCount: number;
    maximumLoadedDirectedEdges: number;
    noCycleAccessPointCount: number;
    feasibleAccessPointCount: number;
    directedValidationRejectionCount: number;
    timeToFirstExactMs?: number;
    hardTruncationReasons: string[];
    /** Close alternatives are bounded independently of exact-match completion. */
    closeMatchTruncationReasons?: string[];
    nonBudgetShortfallReasons: string[];
  };
};
