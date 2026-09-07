import type { GeneratedClosedRouteV3, ConstraintViolationV3, RouteCriteria, SearchEffortV3 } from "@/lib/contracts";
import type { AreaGeometry } from "@/lib/graph";

export type ResolvedAccessFilterContext = {
  predicates: readonly AreaGeometry[];
  namedRegionPredicateIndex?: number;
  coverage: AreaGeometry;
};

export type RouteSearchPolicy = {
  searchEffort: SearchEffortV3;
  limit: number;
  startAccessPointId?: string;
};

export type RouteSearchRequest = RouteCriteria & RouteSearchPolicy;

export type RouteSearchResult = {
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
    attachmentGroupCount: number;
    probedAttachmentGroupCount: number;
    deeplySearchedAttachmentGroupCount: number;
    composedCandidateCount: number;
    repairedCandidateCount: number;
    directedValidationRejectionCount: number;
    expandedAssemblyStates: number;
    timeToFirstExactMs?: number;
    hardTruncationReasons: string[];
    nonBudgetShortfallReasons: string[];
  };
};
