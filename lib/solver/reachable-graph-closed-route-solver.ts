import type {
  ConstraintViolationV3,
  GenerateClosedRoutesRequestV3,
  GenerateClosedRoutesResponseV3,
  TopologyProfile,
} from "@/lib/contracts";
import {
  type AccessPointCandidate,
  type AccessTopology,
  type EdgeTraversal,
  type GraphEdge,
  type GraphRepository,
  type ReconstructedDirectedEdge,
} from "@/lib/graph";

import { CLOSED_ROUTE_EFFORT_BUDGETS, type SolverBudget } from "./budget";
import {
  validateReconstructedClosedRoute,
  type ValidatedClosedRoute,
} from "./closed-route-validation";
import { RouteSearchCancelledError } from "./control";
import { AccessFilterResolutionError } from "./access-filter-error";
import { searchPenalizedClosedRoutes } from "./penalized-closed-route-search";
import {
  accessPointMatchesResolvedFilter,
  listEligibleAccessPointCandidates,
} from "./eligible-access-points";
import type { ResolvedAccessFilterContext } from "./types";

const METERS_PER_MILE = 1_609.344;
const METERS_PER_FOOT = 0.3048;
const MAXIMUM_ALLOWED_OVERLAP = 0.8;
const FIRST_PASS_ROUTES_PER_START = 2;

export interface ClosedRouteFeasibilityRepository {
  readonly packId: string;
  readonly dataVersion: string;
  getAccessTopology(
    profile: TopologyProfile,
    accessPointIds: readonly string[],
  ): Promise<AccessTopology[]>;
}

export type ReachableGraphClosedRouteContext = {
  repository: GraphRepository;
  topologyRepository: ClosedRouteFeasibilityRepository;
  accessFilter: ResolvedAccessFilterContext;
  budget: SolverBudget;
  signal?: AbortSignal;
  now?: () => number;
};

export type ReachableGraphClosedRouteSolverOptions = {
  pack: GenerateClosedRoutesResponseV3["pack"];
  requestIdFactory?: (request: GenerateClosedRoutesRequestV3) => string;
  sourceFreshness?: string;
  sourceConfidence?: "high" | "medium" | "low";
  fallbackSourceIds?: readonly string[];
  onValidationRejection?: (reason: string) => void;
  onPhaseTiming?: (phase: "graph" | "generation" | "validation", elapsedMs: number) => void;
};

type FeasibleStart = {
  start: AccessPointCandidate;
  topology: AccessTopology;
  groupKey: string;
};

type RankedClosedRoute = ValidatedClosedRoute & {
  exact: boolean;
  violations: ConstraintViolationV3[];
  score: number;
};

type SearchRound = {
  deep: boolean;
};

function stableHash(value: string): string {
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(36).padStart(13, "0");
}

function effectiveBudget(request: GenerateClosedRoutesRequestV3, supplied: SolverBudget): SolverBudget {
  const effort = CLOSED_ROUTE_EFFORT_BUDGETS[request.searchEffort];
  return {
    maximumDirectedEdges: Math.min(supplied.maximumDirectedEdges, effort.maximumDirectedEdges),
    maximumExpandedStates: Math.min(supplied.maximumExpandedStates, effort.maximumExpandedStates),
    deadlineMs: Math.min(supplied.deadlineMs, effort.deadlineMs),
    maximumRawCandidates: Math.min(supplied.maximumRawCandidates, effort.maximumRawCandidates),
  };
}

function safeFeasibility(
  topology: AccessTopology,
  maximumDistanceMeters: number,
  maximumRepeatedFraction: number,
  maximumSharedStemMeters: number | undefined,
): boolean {
  if (!topology.canReachCycle || topology.cycleNetworkId === null) return false;
  const stem = topology.minimumStemDistanceMeters;
  if (stem === null) return true;
  if (stem * 2 > maximumDistanceMeters) return false;
  if (stem > maximumDistanceMeters * maximumRepeatedFraction) return false;
  if (maximumSharedStemMeters !== undefined && stem > maximumSharedStemMeters) return false;
  return true;
}

function groupKey(topology: AccessTopology): string {
  const connector = topology.connectorKey ?? topology.connectorDecisionEdgeIds.join(",");
  return `${topology.profile}|${topology.cycleNetworkId}|${topology.portalDecisionNodeId}|${connector}`;
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
      stablePhysicalEdgeId: `physical:${physicalEdgeKey}`,
      minimumElevationMeters,
      fromElevationMeters: traversal.from.elevationMeters,
      toElevationMeters: traversal.to.elevationMeters,
    });
  }
  return reconstructed;
}

function violation(
  constraint: ConstraintViolationV3["constraint"],
  value: number,
  min: number,
  max: number,
): ConstraintViolationV3 | null {
  if (value >= min && value <= max) return null;
  const delta = value < min ? min - value : value - max;
  const scale = Math.max(Math.abs(max - min), Math.abs(min), Math.abs(max), 1);
  return { constraint, value, min, max, delta, normalizedDelta: delta / scale };
}

function centerDistance(value: number, min: number, max: number): number {
  return Math.abs(value - (min + max) / 2) / Math.max(Math.abs(max - min), Math.abs(min), Math.abs(max), 1);
}

function rankRoute(value: ValidatedClosedRoute, request: GenerateClosedRoutesRequestV3): RankedClosedRoute {
  const route = value.route;
  const ranges: Array<{ constraint: ConstraintViolationV3["constraint"]; value: number; min: number; max: number }> = [{
    constraint: "distance",
    value: route.distanceMeters,
    min: request.distanceMiles.min * METERS_PER_MILE,
    max: request.distanceMiles.max * METERS_PER_MILE,
  }];
  if (request.elevationGainFeet) ranges.push({
    constraint: "elevation-gain",
    value: route.elevationGainMeters,
    min: request.elevationGainFeet.min * METERS_PER_FOOT,
    max: request.elevationGainFeet.max * METERS_PER_FOOT,
  });
  if (request.maximumElevationFeet) ranges.push({
    constraint: "maximum-elevation",
    value: route.maximumElevationMeters,
    min: request.maximumElevationFeet.min * METERS_PER_FOOT,
    max: request.maximumElevationFeet.max * METERS_PER_FOOT,
  });
  if (request.steepestSustainedGradePct) ranges.push({
    constraint: "steepest-sustained-grade",
    value: route.steepestSustainedGradePct,
    min: request.steepestSustainedGradePct.min,
    max: request.steepestSustainedGradePct.max,
  });
  if (request.gradeExperience && route.gradeExperience) {
    ranges.push(
      { constraint: "climb-p90-grade", value: route.gradeExperience.climbP90Pct, min: 0, max: request.gradeExperience.maximumClimbP90Pct },
      { constraint: "steep-climbing-share", value: route.gradeExperience.steepClimbingSharePct, min: 0, max: request.gradeExperience.maximumSteepClimbingSharePct },
      { constraint: "longest-steep-climb", value: route.gradeExperience.longestSteepClimbMeters, min: 0, max: request.gradeExperience.maximumSteepRunMiles * METERS_PER_MILE },
      { constraint: "descent-p90-grade", value: route.gradeExperience.descentP90Pct, min: 0, max: request.gradeExperience.maximumDescentP90Pct },
    );
  }
  ranges.push({
    constraint: "repeated-trail",
    value: route.topology.repeatedTrailFraction * 100,
    min: 0,
    max: request.closedRoute.maximumRepeatedTrailPct,
  });
  if (request.closedRoute.maximumSharedStemMiles !== undefined) ranges.push({
    constraint: "shared-stem",
    value: route.topology.sharedStemDistanceMeters,
    min: 0,
    max: request.closedRoute.maximumSharedStemMiles * METERS_PER_MILE,
  });
  const violations = ranges
    .map((range) => violation(range.constraint, range.value, range.min, range.max))
    .filter((item): item is ConstraintViolationV3 => item !== null);
  const centerScore = ranges
    .filter(({ constraint }) => constraint !== "repeated-trail" && constraint !== "shared-stem")
    .reduce((sum, range) => sum + centerDistance(range.value, range.min, range.max), 0);
  return {
    ...value,
    exact: violations.length === 0,
    violations,
    score: centerScore
      + route.topology.repeatedTrailFraction
      + route.topology.sharedStemDistanceMeters / Math.max(route.distanceMeters, 1)
      + Math.max(0, route.trailNames.length - 1) * 0.03
      + ({ high: 0, medium: 0.1, low: 0.2 }[route.startAccessPoint.confidence]),
  };
}

function compareRanked(left: RankedClosedRoute, right: RankedClosedRoute): number {
  return Number(left.exact !== right.exact) * (left.exact ? -1 : 1)
    || left.violations.length - right.violations.length
    || left.violations.reduce((sum, item) => sum + item.normalizedDelta, 0)
      - right.violations.reduce((sum, item) => sum + item.normalizedDelta, 0)
    || left.score - right.score
    || left.route.id.localeCompare(right.route.id);
}

function physicalOverlap(candidate: RankedClosedRoute, selected: RankedClosedRoute): number {
  const candidateDistances = new Map<number, number>();
  for (const edge of candidate.edges) {
    candidateDistances.set(edge.physicalEdgeKey, Math.max(candidateDistances.get(edge.physicalEdgeKey) ?? 0, edge.lengthMeters));
  }
  const total = [...candidateDistances.values()].reduce((sum, distance) => sum + distance, 0);
  const overlap = [...candidateDistances].reduce(
    (sum, [key, distance]) => sum + (selected.physicalEdgeKeys.has(key) ? distance : 0),
    0,
  );
  return total > 0 ? overlap / total : 0;
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
    request: GenerateClosedRoutesRequestV3,
    context: ReachableGraphClosedRouteContext,
  ): Promise<GenerateClosedRoutesResponseV3> {
    if (request.packId !== this.options.pack.id
      || context.repository.packId !== request.packId
      || context.topologyRepository.packId !== request.packId) {
      throw new Error(`Closed-route solver pack mismatch for ${request.packId}`);
    }
    if (context.topologyRepository.dataVersion !== this.options.pack.dataVersion) {
      throw new Error(`Closed-route topology data version mismatch for ${request.packId}`);
    }
    if (context.signal?.aborted) throw new RouteSearchCancelledError(context.signal.reason);

    const now = context.now ?? Date.now;
    const startedAt = now();
    const budget = effectiveBudget(request, context.budget);
    const deadlineAt = startedAt + budget.deadlineMs;
    const hardTruncationReasons = new Set<string>();
    const nonBudgetShortfallReasons = new Set<string>();
    const { all: allCandidates, eligible, matchedFilters, noCycleExcluded } = await listEligibleAccessPointCandidates({
      repository: context.repository,
      accessFilter: context.accessFilter,
      includeUncertainAccess: request.includeUncertainAccess,
      signal: context.signal,
    });
    if (context.signal?.aborted) throw new RouteSearchCancelledError(context.signal.reason);
    let starts: AccessPointCandidate[];
    if (request.startAccessPointId) {
      const selected = allCandidates.find(({ id }) => id === request.startAccessPointId);
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

    // This single batched lookup is intentionally performed for every eligible
    // filtered start before any reachable graph is loaded.
    const profile = request.includeUncertainAccess ? "inclusive" : "known";
    const topologies = await context.topologyRepository.getAccessTopology(profile, starts.map(({ id }) => id));
    if (context.signal?.aborted) throw new RouteSearchCancelledError(context.signal.reason);
    const topologyByStart = new Map(topologies.map((topology) => [topology.accessPointId, topology]));
    // Starts that cannot close a loop are normally removed before this point,
    // so the count has two sources: those excluded by the candidate filter, and
    // an explicitly chosen start, which bypasses that filter.
    const noCycleStartCount = starts.filter(({ id }) => !topologyByStart.get(id)?.canReachCycle).length;
    const noCycleAccessPointCount = (request.startAccessPointId ? 0 : noCycleExcluded) + noCycleStartCount;
    const maximumDistanceMeters = request.distanceMiles.max * METERS_PER_MILE;
    const maximumRepeatedFraction = request.closedRoute.maximumRepeatedTrailPct / 100;
    const maximumSharedStemMeters = request.closedRoute.maximumSharedStemMiles === undefined
      ? undefined
      : request.closedRoute.maximumSharedStemMiles * METERS_PER_MILE;
    const feasible: FeasibleStart[] = [];
    for (const start of starts) {
      const topology = topologyByStart.get(start.id);
      if (!topology || !safeFeasibility(
        topology,
        maximumDistanceMeters,
        maximumRepeatedFraction,
        maximumSharedStemMeters,
      )) continue;
      feasible.push({ start, topology, groupKey: groupKey(topology) });
    }

    let graphQueryCount = 0;
    let maximumLoadedDirectedEdges = 0;
    let expandedStates = 0;
    let rawCandidateCount = 0;
    let composedCandidateCount = 0;
    let repairedCandidateCount = 0;
    let assemblyCandidateCount = 0;
    let directedValidationRejectionCount = 0;
    let timeToFirstExactMs: number | undefined;
    const searchedStarts = new Set<string>();
    const probedGroups = new Set<string>();
    const deeplySearchedGroups = new Set<string>();
    const candidates = new Map<string, RankedClosedRoute>();
    const rounds: SearchRound[] = [{
      deep: false,
    }];
    if (request.searchEffort === "thorough") rounds.push({
      deep: true,
    });

    search: for (const round of rounds) {
      for (const [startIndex, feasibleStart] of feasible.entries()) {
        if (context.signal?.aborted) throw new RouteSearchCancelledError(context.signal.reason);
        const remainingTime = deadlineAt - now();
        const remainingExpanded = budget.maximumExpandedStates - expandedStates;
        const remainingRaw = budget.maximumRawCandidates - rawCandidateCount;
        if (remainingTime <= 0) {
          hardTruncationReasons.add("deadline");
          break search;
        }
        if (remainingExpanded <= 0) {
          hardTruncationReasons.add("maximum-expanded-states");
          break search;
        }
        if (remainingRaw <= 0) {
          hardTruncationReasons.add("maximum-raw-candidates");
          break search;
        }
        const startsRemainingThisRound = feasible.length - startIndex;
        const startDeadlineAt = deadlineAt;
        const expansionAllocation = Math.max(
          1,
          Math.floor(remainingExpanded / Math.max(startsRemainingThisRound, 1)),
        );
        const rawAllocation = Math.max(
          1,
          Math.floor(remainingRaw / Math.max(startsRemainingThisRound, 1)),
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
        if (!round.deep) probedGroups.add(feasibleStart.groupKey);

        const graphWithSelectedStart = reachable.graph.accessPoints.some(({ id }) => id === feasibleStart.start.id)
          ? reachable.graph
          : { ...reachable.graph, accessPoints: [...reachable.graph.accessPoints, feasibleStart.start] };
        const generationStartedAt = now();
        const generated = searchPenalizedClosedRoutes(
          graphWithSelectedStart,
          feasibleStart.start,
          request,
          {
          budget: {
            maximumDirectedEdges: budget.maximumDirectedEdges,
            maximumExpandedStates: expansionAllocation,
            deadlineMs: Math.max(1, Math.floor((startDeadlineAt - now()) * 0.7)),
            maximumRawCandidates: rawAllocation,
          },
          signal: context.signal,
          now,
          maximumRouteOverlapFraction: MAXIMUM_ALLOWED_OVERLAP,
          },
        );
        this.options.onPhaseTiming?.("generation", Math.max(0, now() - generationStartedAt));
        expandedStates = Math.min(budget.maximumExpandedStates, expandedStates + generated.diagnostics.expandedStates);
        rawCandidateCount = Math.min(budget.maximumRawCandidates, rawCandidateCount + generated.diagnostics.candidateCount);
        repairedCandidateCount += generated.diagnostics.repairAccepted;
        assemblyCandidateCount += generated.diagnostics.assemblyAccepted;
        for (const reason of generated.diagnostics.truncationReasons) hardTruncationReasons.add(reason);
        if (round.deep && !generated.diagnostics.truncationReasons.includes("deadline")) {
          deeplySearchedGroups.add(feasibleStart.groupKey);
        }
        const orderedCandidates = [...generated.candidates, ...generated.nearCandidates].sort((left, right) =>
          left.score - right.score
          || left.id.localeCompare(right.id));
        const validationStartedAt = now();
        for (const candidate of orderedCandidates) {
          if (now() >= startDeadlineAt) {
            hardTruncationReasons.add("deadline");
            break;
          }
          composedCandidateCount += 1;
          const reconstructed = reconstructTraversals(candidate.traversals);
          if (!reconstructed) {
            directedValidationRejectionCount += 1;
            this.options.onValidationRejection?.("missing-schema-3-edge-identity");
            continue;
          }
          const forwardSignature = reconstructed.map(({ physicalEdgeKey }) => physicalEdgeKey).join(">");
          const reverseSignature = [...reconstructed].reverse().map(({ physicalEdgeKey }) => physicalEdgeKey).join(">");
          const signature = forwardSignature < reverseSignature ? forwardSignature : reverseSignature;
          const routeId = `closed_${stableHash(`${feasibleStart.start.id}|${signature}`)}`;
          const validated = validateReconstructedClosedRoute(reconstructed, {
            compressedEdgeIds: reconstructed.map(({ edgeKey }) => edgeKey),
            start: feasibleStart.start,
            includeUncertainAccess: request.includeUncertainAccess,
            coverage: context.accessFilter.coverage,
            sourceFreshness: this.options.sourceFreshness ?? this.options.pack.builtAt,
            sourceConfidence: this.options.sourceConfidence ?? "high",
            fallbackSourceIds: this.options.fallbackSourceIds ?? [`${this.options.pack.id}:manifest`],
            routeId,
          });
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
          if (!request.closedRoute.allowMultiCycle && validated.value.route.topology.cycleCount > 1) continue;
          const ranked = rankRoute(validated.value, request);
          const previous = candidates.get(routeId);
          if (!previous || compareRanked(ranked, previous) < 0) candidates.set(routeId, ranked);
          if (ranked.exact && timeToFirstExactMs === undefined) {
            timeToFirstExactMs = Math.max(0, now() - startedAt);
          }
        }
        this.options.onPhaseTiming?.("validation", Math.max(0, now() - validationStartedAt));
      }
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
    if (request.searchEffort === "quick" && probedGroups.size > 0) {
      nonBudgetShortfallReasons.add("quick-groups-not-deeply-searched");
    }
    const ranked = [...candidates.values()].sort(compareRanked);
    const exact = selectDiverse(ranked.filter(({ exact: isExact }) => isExact), request.limit);
    const nearMisses = selectDiverse(ranked.filter(({ exact: isExact }) => !isExact), 3, exact);
    if (exact.length < request.limit) nonBudgetShortfallReasons.add("fewer-exact-routes-than-requested");
    const truncationReasons = [...hardTruncationReasons].sort();
    const shortfallReasons = [...nonBudgetShortfallReasons].sort();
    return {
      version: 3,
      requestId: this.options.requestIdFactory?.(request) ?? `closed-route-request-${stableHash(JSON.stringify(request))}`,
      pack: this.options.pack,
      requested: request.limit,
      resolvedAccessFilter: context.accessFilter.summary,
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
        exhausted: truncationReasons.length > 0,
        truncationReasons,
        shortfallReasons,
        noCycleAccessPointCount,
        feasibleAccessPointCount: feasible.length,
        attachmentGroupCount: new Set(feasible.map(({ groupKey: key }) => key)).size,
        probedAttachmentGroupCount: probedGroups.size,
        deeplySearchedAttachmentGroupCount: deeplySearchedGroups.size,
        loadedTopologyNetworkCount: 0,
        cycleBlockCount: 0,
        cyclePrimitiveCount: 0,
        composedCandidateCount,
        repairedCandidateCount,
        directedValidationRejectionCount,
        expandedAssemblyStates: assemblyCandidateCount,
        ...(timeToFirstExactMs === undefined ? {} : { timeToFirstExactMs }),
        hardTruncationReasons: truncationReasons,
        nonBudgetShortfallReasons: shortfallReasons,
      },
    };
  }
}
