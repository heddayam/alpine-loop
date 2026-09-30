import type {
  ConstraintViolationV3,
  RouteCriteria,
  PackManifest,
} from "@/lib/contracts";
import {
  type AccessPointCandidate,
  type EdgeTraversal,
  type GraphEdge,
  type GraphRepository,
  type ReconstructedDirectedEdge,
} from "@/lib/graph";

import { CLOSED_ROUTE_BUDGET, MAXIMUM_SEARCH_DEADLINE_MS, MAXIMUM_SEARCH_STATES, searchCompletionForReasons, type SolverBudget } from "./budget";
import {
  prepareClosedRouteValidator,
  type ValidatedClosedRoute,
} from "./closed-route-validation";
import { RouteSearchCancelledError } from "./control";
import { stableHash } from "./route-identity";
import { rankRouteMetrics } from "./route-quality";
import { AccessFilterResolutionError } from "./access-filter-error";
import { searchSimpleRoutes } from "./simple-route-search";
import {
  accessPointMatchesResolvedFilter,
  listEligibleAccessPointCandidates,
} from "./eligible-access-points";
import type { ResolvedAccessFilterContext, RouteSearchPolicy, RouteSearchRequest, RouteSearchResult } from "./types";

const METERS_PER_MILE = 1_609.344;
const MAXIMUM_ALLOWED_OVERLAP = 0.8;
const FIRST_PASS_ROUTES_PER_START = 2;

export type ReachableGraphClosedRouteContext = {
  repository: GraphRepository;
  accessFilter: ResolvedAccessFilterContext;
  budget: SolverBudget;
  signal?: AbortSignal;
  now?: () => number;
};

export type RouteGraphContext = Omit<ReachableGraphClosedRouteContext, "budget">;

export type PreparedRouteSearch = {
  readonly eligibleAccessPointIds: readonly string[];
  generate(policy: RouteSearchPolicy, budget: SolverBudget): Promise<RouteSearchResult>;
};

type PreparedStarts = {
  eligible: AccessPointCandidate[];
  starts: AccessPointCandidate[];
  feasible: FeasibleStart[];
  noCycleStartIds: ReadonlySet<string>;
  noCycleExcluded: number;
};

export type ReachableGraphClosedRouteSolverOptions = {
  pack: Pick<PackManifest, "id" | "dataVersion" | "builtAt">;
  sourceFreshness?: string;
  sourceConfidence?: "high" | "medium" | "low";
  fallbackSourceIds?: readonly string[];
  onValidationRejection?: (reason: string) => void;
  onPhaseTiming?: (phase: "graph" | "generation" | "validation", elapsedMs: number) => void;
};

type FeasibleStart = {
  start: AccessPointCandidate;
};

type RankedClosedRoute = ValidatedClosedRoute & {
  exact: boolean;
  violations: ConstraintViolationV3[];
  score: number;
};

function effectiveBudget(supplied: SolverBudget): SolverBudget {
  for (const value of Object.values(supplied)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Invalid solver budget");
  }
  return {
    maximumDirectedEdges: Math.min(supplied.maximumDirectedEdges, CLOSED_ROUTE_BUDGET.maximumDirectedEdges),
    maximumExpandedStates: Math.min(supplied.maximumExpandedStates, MAXIMUM_SEARCH_STATES),
    deadlineMs: Math.min(supplied.deadlineMs, MAXIMUM_SEARCH_DEADLINE_MS),
    maximumRetainedCycles: Math.min(supplied.maximumRetainedCycles, CLOSED_ROUTE_BUDGET.maximumRetainedCycles),
    maximumRetainedBytes: Math.min(supplied.maximumRetainedBytes ?? CLOSED_ROUTE_BUDGET.maximumRetainedBytes, CLOSED_ROUTE_BUDGET.maximumRetainedBytes),
  };
}

function safeFeasibility(
  stem: number | null,
  maximumDistanceMeters: number,
  maximumRepeatedFraction: number,
  maximumSharedStemMeters: number | undefined,
): boolean {
  if (stem === null) return false;
  if (stem * 2 > maximumDistanceMeters) return false;
  if (stem > maximumDistanceMeters * maximumRepeatedFraction) return false;
  if (maximumSharedStemMeters !== undefined && stem > maximumSharedStemMeters) return false;
  return true;
}

function edgePhysicalKey(edge: GraphEdge): number | null {
  const value = edge.physicalEdgeKey;
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function directedEdgeKey(edge: GraphEdge): number | null {
  const value = edge.edgeKey;
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function reconstructTraversals(
  traversals: readonly EdgeTraversal[],
): ReconstructedDirectedEdge[] | null {
  const reconstructed: ReconstructedDirectedEdge[] = [];
  for (const traversal of traversals) {
    const physicalEdgeKey = edgePhysicalKey(traversal.edge);
    const edgeKey = directedEdgeKey(traversal.edge);
    if (physicalEdgeKey === null || edgeKey === null) return null;
    const profileElevations = traversal.edge.elevationProfile?.map(({ elevationMeters }) => elevationMeters);
    const endpointElevations = profileElevations ?? [traversal.from.elevationMeters, traversal.to.elevationMeters];
    const minimumElevationMeters = endpointElevations.every((value): value is number => value !== null)
      ? Math.min(...endpointElevations)
      : null;
    reconstructed.push({
      ...traversal.edge,
      edgeKey,
      physicalEdgeKey,
      minimumElevationMeters,
      fromElevationMeters: traversal.from.elevationMeters,
      toElevationMeters: traversal.to.elevationMeters,
    });
  }
  return reconstructed;
}

function rankRoute(value: ValidatedClosedRoute, request: RouteSearchRequest): RankedClosedRoute {
  return { ...value, ...rankRouteMetrics(value.route, request) };
}

function compareRanked(left: RankedClosedRoute, right: RankedClosedRoute): number {
  return Number(left.exact !== right.exact) * (left.exact ? -1 : 1)
    || left.violations.length - right.violations.length
    || left.violations.reduce((sum, item) => sum + item.normalizedDelta, 0)
      - right.violations.reduce((sum, item) => sum + item.normalizedDelta, 0)
    || left.score - right.score
    || left.route.id.localeCompare(right.route.id);
}

function cycleEdges(route: { edges: readonly GraphEdge[] }): readonly GraphEdge[] {
  let left = 0;
  let right = route.edges.length - 1;
  while (left < right && route.edges[left]!.physicalEdgeKey === route.edges[right]!.physicalEdgeKey
    && route.edges[left]!.fromNodeId === route.edges[right]!.toNodeId
    && route.edges[left]!.toNodeId === route.edges[right]!.fromNodeId) { left += 1; right -= 1; }
  return route.edges.slice(left, right + 1);
}

function physicalOverlap(candidate: { edges: readonly GraphEdge[] }, selected: { edges: readonly GraphEdge[] }): number {
  const left = cycleEdges(candidate);
  const right = cycleEdges(selected);
  const lengths = new Map(left.map(edge => [edge.physicalEdgeKey, edge.lengthMeters]));
  const shared = right.reduce((sum, edge) => sum + Math.min(lengths.get(edge.physicalEdgeKey) ?? 0, edge.lengthMeters), 0);
  const total = Math.min(left.reduce((sum, edge) => sum + edge.lengthMeters, 0), right.reduce((sum, edge) => sum + edge.lengthMeters, 0));
  return shared / Math.max(1, total);
}

function selectDiverse(
  ranked: readonly RankedClosedRoute[],
  limit: number,
  alreadySelected: readonly RankedClosedRoute[] = [],
): RankedClosedRoute[] {
  const selected: RankedClosedRoute[] = [];
  const counts = new Map<string, number>();
  for (const route of alreadySelected) {
    counts.set(route.route.startAccessPoint.id, (counts.get(route.route.startAccessPoint.id) ?? 0) + 1);
  }
  const overlaps = (candidate: RankedClosedRoute): boolean => [...alreadySelected, ...selected]
    .some((other) => physicalOverlap(candidate, other) > MAXIMUM_ALLOWED_OVERLAP);
  for (const candidate of ranked) {
    if (selected.length >= limit) break;
    const startId = candidate.route.startAccessPoint.id;
    if ((counts.get(startId) ?? 0) >= FIRST_PASS_ROUTES_PER_START || overlaps(candidate)) continue;
    selected.push(candidate);
    counts.set(startId, (counts.get(startId) ?? 0) + 1);
  }
  for (const candidate of ranked) {
    if (selected.length >= limit) break;
    if (selected.some(({ route }) => route.id === candidate.route.id) || overlaps(candidate)) continue;
    selected.push(candidate);
  }
  return selected;
}

export class ReachableGraphClosedRouteSolver {
  constructor(private readonly options: ReachableGraphClosedRouteSolverOptions) {}

  async generate(
    request: RouteSearchRequest,
    context: ReachableGraphClosedRouteContext,
  ): Promise<RouteSearchResult> {
    const startedAt = (context.now ?? Date.now)();
    const prepared = await this.#prepare(request, context, request.startAccessPointId);
    return this.#generate(request, context, prepared, startedAt);
  }

  /** Prepare one criteria/filter snapshot for repeated per-start searches. */
  async prepare(criteria: RouteCriteria, context: RouteGraphContext): Promise<PreparedRouteSearch> {
    const snapshot = structuredClone(criteria);
    const prepared = await this.#prepare(snapshot, context);
    return {
      eligibleAccessPointIds: prepared.eligible.map(({ id }) => id),
      generate: async (policy, budget) => {
        const starts = policy.startAccessPointId === undefined
          ? prepared.starts
          : prepared.starts.filter(({ id }) => id === policy.startAccessPointId);
        if (policy.startAccessPointId !== undefined && starts.length === 0) {
          throw new AccessFilterResolutionError("START_INELIGIBLE", "The selected access point was not prepared for this search");
        }
        const selected = policy.startAccessPointId === undefined ? prepared : {
          ...prepared,
          starts,
          feasible: prepared.feasible.filter(({ start }) => start.id === policy.startAccessPointId),
          noCycleExcluded: 0,
        };
        return this.#generate({ ...snapshot, ...policy }, { ...context, budget }, selected);
      },
    };
  }

  async #prepare(
    request: RouteCriteria,
    context: RouteGraphContext,
    startAccessPointId?: string,
  ): Promise<PreparedStarts> {
    if (context.repository.packId !== this.options.pack.id) {
      throw new Error(`Closed-route solver pack mismatch for ${this.options.pack.id}`);
    }
    if (context.signal?.aborted) throw new RouteSearchCancelledError(context.signal.reason);
    const { all: allCandidates, eligible, matchedFilters, noCycleExcluded } = await listEligibleAccessPointCandidates({
      repository: context.repository,
      accessFilter: context.accessFilter,
      includeUncertainAccess: request.includeUncertainAccess,
      startAccessPointId,
      signal: context.signal,
    });
    if (context.signal?.aborted) throw new RouteSearchCancelledError(context.signal.reason);
    let starts: AccessPointCandidate[];
    if (startAccessPointId) {
      const selected = allCandidates.find(({ id }) => id === startAccessPointId);
      if (!selected) throw new AccessFilterResolutionError("START_NOT_FOUND", "The selected access point was not found");
      if (!accessPointMatchesResolvedFilter(selected, context.accessFilter)) {
        throw new AccessFilterResolutionError("START_OUTSIDE_FILTER", "The selected access point is outside the trailhead filter");
      }
      // Checked before the closed-route filter: a chosen start that simply
      // cannot form a loop is reported as `no-cycle-access-points` below, not
      // misattributed to the area settings.
      if (!matchedFilters.some(({ id }) => id === selected.id)) {
        throw new AccessFilterResolutionError("START_INELIGIBLE", "The selected access point is excluded by the access-point area settings");
      }
      starts = [selected];
    } else {
      starts = eligible;
    }

    // Deleting edges cannot create a cycle or shorten a path to one. Release
    // hints therefore remain conservative for any installed subset with the
    // same access profile, identities, and edge lengths. A finite hint does not
    // prove that the installed subset still contains a cycle.
    const stemFor = (start: AccessPointCandidate): number | null => {
      const stem = request.includeUncertainAccess ? start.inclusiveMinimumStemMeters : start.knownMinimumStemMeters;
      if (stem === undefined || (stem !== null && (!Number.isFinite(stem) || stem < 0))) {
        throw new Error(`Graph database corruption: missing or invalid feasibility hint for ${start.id}`);
      }
      return stem;
    };
    const noCycleStartIds = new Set(starts.filter(start => stemFor(start) === null).map(({ id }) => id));
    const maximumDistanceMeters = request.distanceMiles.max * METERS_PER_MILE;
    const maximumRepeatedFraction = request.closedRoute.maximumRepeatedTrailPct / 100;
    const maximumSharedStemMeters = request.closedRoute.maximumSharedStemMiles === undefined
      ? undefined
      : request.closedRoute.maximumSharedStemMiles * METERS_PER_MILE;
    const feasible: FeasibleStart[] = [];
    for (const start of starts) {
      if (!safeFeasibility(
        stemFor(start),
        maximumDistanceMeters,
        maximumRepeatedFraction,
        maximumSharedStemMeters,
      )) continue;
      feasible.push({ start });
    }

    return {
      eligible, starts, feasible, noCycleStartIds, noCycleExcluded: startAccessPointId ? 0 : noCycleExcluded,
    };
  }

  async #generate(
    request: RouteSearchRequest,
    context: ReachableGraphClosedRouteContext,
    prepared: PreparedStarts,
    startedAt = (context.now ?? Date.now)(),
  ): Promise<RouteSearchResult> {
    if (context.signal?.aborted) throw new RouteSearchCancelledError(context.signal.reason);
    const now = context.now ?? Date.now;
    const budget = effectiveBudget(context.budget);
    const deadlineAt = startedAt + budget.deadlineMs;
    const hardTruncationReasons = new Set<string>();
    const closeMatchTruncationReasons = new Set<string>();
    const nonBudgetShortfallReasons = new Set<string>();
    const { eligible, starts, feasible, noCycleStartIds, noCycleExcluded } = prepared;
    const noCycleStartCount = starts.filter(({ id }) => noCycleStartIds.has(id)).length;
    const noCycleAccessPointCount = noCycleExcluded + noCycleStartCount;
    const maximumDistanceMeters = request.distanceMiles.max * METERS_PER_MILE;
    let graphQueryCount = 0;
    let maximumLoadedDirectedEdges = 0;
    let expandedStates = 0;
    let directedValidationRejectionCount = 0;
    let timeToFirstExactMs: number | undefined;
    const searchedStarts = new Set<string>();
    const candidates = new Map<string, RankedClosedRoute>();
    search: for (const [startIndex, feasibleStart] of feasible.entries()) {
      if (context.signal?.aborted) throw new RouteSearchCancelledError(context.signal.reason);
      const remainingTime = deadlineAt - now();
      const remainingExpanded = budget.maximumExpandedStates - expandedStates;
      if (remainingTime <= 0) {
        hardTruncationReasons.add("deadline");
        break search;
      }
      if (remainingExpanded <= 0) {
        hardTruncationReasons.add("maximum-expanded-states");
        break search;
      }
      const startsRemainingThisRound = feasible.length - startIndex;
      const startDeadlineAt = deadlineAt;
      const expansionAllocation = Math.max(
        1,
        Math.floor(remainingExpanded / Math.max(startsRemainingThisRound, 1)),
      );
      const queryController = new AbortController();
      const abortForParent = () => queryController.abort(context.signal?.reason);
      context.signal?.addEventListener("abort", abortForParent, { once: true });
      const timeout = setTimeout(
        () => queryController.abort(new Error("Closed-route search deadline exceeded")),
        Math.max(1, remainingTime),
      );
      let reachable;
      const graphStartedAt = now();
      try {
        graphQueryCount += 1;
        searchedStarts.add(feasibleStart.start.id);
        reachable = await context.repository.getReachableGraph({
          startNodeId: feasibleStart.start.nodeId,
          startCoordinates: [feasibleStart.start.lon, feasibleStart.start.lat],
          maximumDistanceMeters,
          maximumDirectedEdges: budget.maximumDirectedEdges,
          includeUncertainAccess: request.includeUncertainAccess,
          coverage: context.accessFilter.coverage,
          signal: queryController.signal,
        });
      } catch (error) {
        if (context.signal?.aborted) throw new RouteSearchCancelledError(context.signal.reason);
        if (queryController.signal.aborted) {
          hardTruncationReasons.add("deadline");
          break search;
        }
        throw error;
      } finally {
        clearTimeout(timeout);
        context.signal?.removeEventListener("abort", abortForParent);
      }
      this.options.onPhaseTiming?.("graph", Math.max(0, now() - graphStartedAt));
      maximumLoadedDirectedEdges = Math.max(maximumLoadedDirectedEdges, reachable.graph.edges.length);
      if (reachable.truncated) hardTruncationReasons.add("maximum-directed-edges");

      const graphWithSelectedStart = reachable.graph.accessPoints.some(({ id }) => id === feasibleStart.start.id)
        ? reachable.graph
        : { ...reachable.graph, accessPoints: [...reachable.graph.accessPoints, feasibleStart.start] };
      const generationStartedAt = now();
      const generated = searchSimpleRoutes(
        graphWithSelectedStart,
        feasibleStart.start,
        // Final validation precedes the user-visible limit/diversity decision.
        // The search archive has one best exact/close approach per physical loop.
        { ...request, limit: budget.maximumRetainedCycles },
        {
        budget: {
          maximumDirectedEdges: budget.maximumDirectedEdges,
          maximumExpandedStates: expansionAllocation,
          deadlineMs: Math.max(1, Math.floor((startDeadlineAt - now()) * 0.7)),
          maximumRetainedCycles: budget.maximumRetainedCycles,
          maximumRetainedBytes: budget.maximumRetainedBytes,
        },
        signal: context.signal,
        now,
        maximumRouteOverlapFraction: 1,
        },
      );
      this.options.onPhaseTiming?.("generation", Math.max(0, now() - generationStartedAt));
      expandedStates = Math.min(budget.maximumExpandedStates, expandedStates + generated.diagnostics.expandedStates);
      for (const reason of generated.diagnostics.truncationReasons) hardTruncationReasons.add(reason);
      for (const reason of generated.diagnostics.closeMatchTruncationReasons) closeMatchTruncationReasons.add(reason);
      const orderedCandidates = [...generated.candidates, ...generated.nearCandidates].map(candidate => {
        const keys = candidate.traversals.map(({ edge }) => edge.physicalEdgeKey);
        const forward = keys.join(">");
        const backward = keys.reverse().join(">");
        const signature = forward < backward ? forward : backward;
        return { candidate, routeId: `closed_${stableHash(`${feasibleStart.start.id}|${signature}`)}` };
      }).sort((left, right) => Number(left.candidate.violatedConstraints.length > 0) - Number(right.candidate.violatedConstraints.length > 0)
        || left.candidate.score - right.candidate.score || left.routeId.localeCompare(right.routeId));
      const validationStartedAt = now();
      const validateRoute = prepareClosedRouteValidator({
        start: feasibleStart.start,
        includeUncertainAccess: request.includeUncertainAccess,
        coverage: context.accessFilter.coverage,
        sourceFreshness: this.options.sourceFreshness ?? this.options.pack.builtAt,
        sourceConfidence: this.options.sourceConfidence ?? "high",
        fallbackSourceIds: this.options.fallbackSourceIds ?? [`${this.options.pack.id}:manifest`],
      });
      const selectedAtStart: RankedClosedRoute[] = [];
      for (const { candidate, routeId } of orderedCandidates) {
        if (now() >= startDeadlineAt) {
          // Exact candidates precede close candidates. A deadline reached only
          // while validating the fallback must not reopen exact exploration.
          (candidate.violatedConstraints.length === 0 ? hardTruncationReasons : closeMatchTruncationReasons).add("deadline");
          break;
        }
        // Ranking uses the same metrics as authoritative validation. Once a
        // better exact route is validated, an overlapping lower-ranked route
        // cannot enter this start's greedy result set. Never let an unvalidated
        // candidate suppress another route. Multi-start calls retain their
        // existing cross-start selection policy.
        if (feasible.length === 1 && candidate.violatedConstraints.length === 0
          && selectedAtStart.some(other => physicalOverlap({ edges: candidate.traversals.map(({ edge }) => edge) }, other) > MAXIMUM_ALLOWED_OVERLAP)) continue;
        const reconstructed = reconstructTraversals(candidate.traversals);
        if (!reconstructed) {
          directedValidationRejectionCount += 1;
          this.options.onValidationRejection?.("missing-schema-3-edge-identity");
          continue;
        }
        const validated = validateRoute(reconstructed, routeId);
        if (!validated.valid) {
          directedValidationRejectionCount += 1;
          this.options.onValidationRejection?.(validated.reason);
          continue;
        }
        if (request.gradeExperience && !validated.value.route.gradeExperience) {
          directedValidationRejectionCount += 1;
          this.options.onValidationRejection?.("missing-grade-experience-profile");
          continue;
        }
        const ranked = rankRoute(validated.value, request);
        const previous = candidates.get(routeId);
        if (!previous || compareRanked(ranked, previous) < 0) candidates.set(routeId, ranked);
        if (ranked.exact && timeToFirstExactMs === undefined) {
          timeToFirstExactMs = Math.max(0, now() - startedAt);
        }
        if (ranked.exact) {
          selectedAtStart.push(ranked);
          if (feasible.length === 1 && selectedAtStart.length >= request.limit) break;
        }
      }
      this.options.onPhaseTiming?.("validation", Math.max(0, now() - validationStartedAt));
    }

    if (eligible.length === 0 && noCycleAccessPointCount === 0) {
      nonBudgetShortfallReasons.add("no-eligible-start-access-points");
    }
    if (noCycleAccessPointCount > 0 && starts.length === noCycleStartCount) {
      nonBudgetShortfallReasons.add("no-cycle-access-points");
    }
    if (feasible.length === 0 && starts.length > noCycleStartCount) {
      nonBudgetShortfallReasons.add("topology-constraints-infeasible");
    }
    const ranked = [...candidates.values()].sort(compareRanked);
    const exact = selectDiverse(ranked.filter(({ exact: isExact }) => isExact), request.limit);
    const nearMisses = selectDiverse(ranked.filter(({ exact: isExact }) => !isExact), 3, exact);
    if (exact.length < request.limit) nonBudgetShortfallReasons.add("fewer-exact-routes-than-requested");
    const truncationReasons = [...hardTruncationReasons].sort();
    const shortfallReasons = [...nonBudgetShortfallReasons].sort();
    return {
      completion: searchCompletionForReasons(truncationReasons, budget),
      exact: exact.map(({ route }) => route),
      nearMisses: nearMisses.map(({ route, violations }) => ({ ...route, violations })),
      diagnostics: {
        elapsedMs: Math.max(0, now() - startedAt),
        expandedStates,
        candidateCount: candidates.size,
        eligibleAccessPointCount: eligible.length,
        searchedAccessPointCount: searchedStarts.size,
        graphQueryCount,
        maximumLoadedDirectedEdges,
        noCycleAccessPointCount,
        feasibleAccessPointCount: feasible.length,
        directedValidationRejectionCount,
        ...(timeToFirstExactMs === undefined ? {} : { timeToFirstExactMs }),
        hardTruncationReasons: truncationReasons,
        closeMatchTruncationReasons: [...closeMatchTruncationReasons].sort(),
        nonBudgetShortfallReasons: shortfallReasons,
      },
    };
  }
}
