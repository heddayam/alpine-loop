import type {
  ConstraintViolationV3,
  GenerateClosedRoutesRequestV3,
  GenerateClosedRoutesResponseV3,
  TopologyProfile,
} from "@/lib/contracts";
import {
  accessPointIsEligible,
  areaBounds,
  coordinateIsInsideArea,
  type AccessPointCandidate,
  type AccessTopology,
  type GraphEdge,
  type GraphRepository,
  type ReconstructedDirectedEdge,
} from "@/lib/graph";

import { CLOSED_ROUTE_EFFORT_BUDGETS, type SolverBudget } from "./budget";
import {
  validateReconstructedClosedRoute,
  type ValidatedClosedRoute,
} from "./closed-route-validation";
import { generateClosedTours } from "./closed-tours";
import { RouteSearchCancelledError } from "./control";
import { AccessFilterResolutionError } from "./multi-start-solver";
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
  labelsPerNode: number;
  maximumCompositionDepth: number;
  maximumWalks: number;
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

function matchesFilter(candidate: Pick<AccessPointCandidate, "lon" | "lat">, context: ReachableGraphClosedRouteContext): boolean {
  return context.accessFilter.predicates.every((geometry) =>
    coordinateIsInsideArea([candidate.lon, candidate.lat], geometry));
}

function candidateRank(left: AccessPointCandidate, right: AccessPointCandidate, includeUnknown: boolean): number {
  const confidence = { high: 0, medium: 1, low: 2 };
  return right.knownConnectivity - left.knownConnectivity
    || right.knownOutDegree - left.knownOutDegree
    || (includeUnknown ? right.inclusiveConnectivity - left.inclusiveConnectivity : 0)
    || (includeUnknown ? right.inclusiveOutDegree - left.inclusiveOutDegree : 0)
    || confidence[left.confidence] - confidence[right.confidence]
    || left.id.localeCompare(right.id);
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
  const value = (edge as GraphEdge & { physicalEdgeKey?: unknown }).physicalEdgeKey;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function reconstructTraversals(
  traversals: ReturnType<typeof generateClosedTours>["candidates"][number]["traversals"],
): ReconstructedDirectedEdge[] | null {
  const reconstructed: ReconstructedDirectedEdge[] = [];
  for (const [index, traversal] of traversals.entries()) {
    const physicalEdgeKey = edgePhysicalKey(traversal.edge);
    if (physicalEdgeKey === null) return null;
    const endpointElevations = [traversal.from.elevationMeters, traversal.to.elevationMeters];
    const minimumElevationMeters = endpointElevations.every((value): value is number => value !== null)
      ? Math.min(...endpointElevations)
      : null;
    reconstructed.push({
      ...traversal.edge,
      edgeKey: index,
      physicalEdgeKey,
      stablePhysicalEdgeId: `physical:${physicalEdgeKey}`,
      minimumElevationMeters,
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
    const coverageBbox = areaBounds(context.accessFilter.coverage);
    const allCandidates = await context.repository.getAccessPointCandidates({
      bbox: coverageBbox,
      includeUncertainAccess: true,
      signal: context.signal,
    });
    if (context.signal?.aborted) throw new RouteSearchCancelledError(context.signal.reason);
    const filtered = allCandidates.filter((candidate) => matchesFilter(candidate, context));
    const eligible = filtered.filter((candidate) => accessPointIsEligible(candidate, request.includeUncertainAccess));
    let starts: AccessPointCandidate[];
    if (request.startAccessPointId) {
      const selected = allCandidates.find(({ id }) => id === request.startAccessPointId);
      if (!selected) throw new AccessFilterResolutionError("START_NOT_FOUND", "The selected access point was not found");
      if (!matchesFilter(selected, context)) {
        throw new AccessFilterResolutionError("START_OUTSIDE_FILTER", "The selected access point is outside the trailhead filter");
      }
      if (!accessPointIsEligible(selected, request.includeUncertainAccess)) {
        throw new AccessFilterResolutionError("START_INELIGIBLE", "The selected access point is excluded by the access policy");
      }
      starts = [selected];
    } else {
      starts = [...eligible].sort((left, right) => candidateRank(left, right, request.includeUncertainAccess));
    }

    // This single batched lookup is intentionally performed for every eligible
    // filtered start before any reachable graph is loaded.
    const profile = request.includeUncertainAccess ? "inclusive" : "known";
    const topologies = await context.topologyRepository.getAccessTopology(profile, starts.map(({ id }) => id));
    if (context.signal?.aborted) throw new RouteSearchCancelledError(context.signal.reason);
    const topologyByStart = new Map(topologies.map((topology) => [topology.accessPointId, topology]));
    const noCycleAccessPointCount = starts.filter(({ id }) => !topologyByStart.get(id)?.canReachCycle).length;
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
    let directedValidationRejectionCount = 0;
    let timeToFirstExactMs: number | undefined;
    const searchedStarts = new Set<string>();
    const probedGroups = new Set<string>();
    const deeplySearchedGroups = new Set<string>();
    const candidates = new Map<string, RankedClosedRoute>();
    const rounds: SearchRound[] = [{
      deep: false,
      labelsPerNode: 3,
      maximumCompositionDepth: 1,
      maximumWalks: Math.max(4, Math.min(12, request.limit)),
    }];
    if (request.searchEffort === "thorough") rounds.push({
      deep: true,
      labelsPerNode: 8,
      maximumCompositionDepth: 4,
      maximumWalks: Math.max(24, request.limit * 3),
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
        maximumLoadedDirectedEdges = Math.max(maximumLoadedDirectedEdges, reachable.graph.edges.length);
        if (reachable.truncated) hardTruncationReasons.add("maximum-directed-edges");
        if (!round.deep) probedGroups.add(feasibleStart.groupKey);

        const generated = generateClosedTours(reachable.graph, feasibleStart.start, {
          distanceMeters: {
            min: request.distanceMiles.min * METERS_PER_MILE,
            max: maximumDistanceMeters,
            target: (request.distanceMiles.min + request.distanceMiles.max) * METERS_PER_MILE / 2,
          },
          ...(request.elevationGainFeet ? {
            elevationGainMeters: {
              min: request.elevationGainFeet.min * METERS_PER_FOOT,
              max: request.elevationGainFeet.max * METERS_PER_FOOT,
              target: (request.elevationGainFeet.min + request.elevationGainFeet.max) * METERS_PER_FOOT / 2,
            },
          } : {}),
          includeUncertainAccess: request.includeUncertainAccess,
          maximumWalks: Math.min(round.maximumWalks, rawAllocation),
        }, {
          budget: {
            maximumDirectedEdges: budget.maximumDirectedEdges,
            maximumExpandedStates: expansionAllocation,
            deadlineMs: Math.max(1, deadlineAt - now()),
            maximumRawCandidates: rawAllocation,
          },
          signal: context.signal,
          now,
          labelsPerNode: round.labelsPerNode,
          maximumCompositionDepth: round.maximumCompositionDepth,
        });
        expandedStates = Math.min(budget.maximumExpandedStates, expandedStates + generated.diagnostics.expandedStates);
        rawCandidateCount = Math.min(budget.maximumRawCandidates, rawCandidateCount + generated.diagnostics.candidateCount);
        if (generated.diagnostics.truncationReasons.includes("deadline")) hardTruncationReasons.add("deadline");
        if (round.deep && !generated.diagnostics.truncationReasons.includes("deadline")) {
          deeplySearchedGroups.add(feasibleStart.groupKey);
        }
        for (const candidate of generated.candidates) {
          composedCandidateCount += 1;
          const reconstructed = reconstructTraversals(candidate.traversals);
          if (!reconstructed) {
            directedValidationRejectionCount += 1;
            continue;
          }
          const signature = reconstructed.map(({ edgeKey, physicalEdgeKey }) => `${physicalEdgeKey}:${edgeKey}`).join(">");
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
      }
    }

    if (eligible.length === 0) nonBudgetShortfallReasons.add("no-eligible-start-access-points");
    if (starts.length > 0 && noCycleAccessPointCount === starts.length) {
      nonBudgetShortfallReasons.add("no-cycle-access-points");
    }
    if (feasible.length === 0 && starts.length > noCycleAccessPointCount) {
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
        repairedCandidateCount: 0,
        directedValidationRejectionCount,
        expandedAssemblyStates: expandedStates,
        ...(timeToFirstExactMs === undefined ? {} : { timeToFirstExactMs }),
        hardTruncationReasons: truncationReasons,
        nonBudgetShortfallReasons: shortfallReasons,
      },
    };
  }
}
