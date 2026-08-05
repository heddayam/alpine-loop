import type {
  GenerateRoutesRequestV1,
  GenerateRoutesRequestV2,
  GenerateRoutesResponseV2,
  GeneratedRouteV2,
} from "@/lib/contracts";
import {
  accessPointIsEligible,
  areaBounds,
  coordinateIsInsideArea,
  type AccessPointCandidate,
  type InducedGraph,
} from "@/lib/graph";
import { compareScoredCandidates, scoreCandidate, type ScoredCandidate } from "./candidate";
import { RouteSearchCancelledError } from "./control";
import { undirectedDistanceOverlap } from "./diversity";
import { generateInitialCandidates } from "./generate";
import { generatedRoute, type GeneratedRouteOptions } from "./route-solver";
import type { RouteGenerationV2Context, RouteSolverV2 } from "./types";

const METERS_PER_MILE = 1_609.344;
const MAXIMUM_AUTOMATIC_STARTS = 8;
const FIRST_PASS_ROUTES_PER_START = 2;
const RESPONSE_HEADROOM_MILLISECONDS = 750;

export type MultiStartRouteSolverOptions = {
  pack: GenerateRoutesResponseV2["pack"];
  requestIdFactory?: (request: GenerateRoutesRequestV2) => string;
  sourceFreshness?: string;
  sourceConfidence?: "high" | "medium" | "low";
  fallbackSourceIds?: string[];
};

export class AccessFilterResolutionError extends Error {
  constructor(
    readonly code: "START_NOT_FOUND" | "START_OUTSIDE_FILTER" | "START_INELIGIBLE",
    message: string,
  ) {
    super(message);
    this.name = "AccessFilterResolutionError";
  }
}

function stableHash(value: string): string {
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(36).padStart(13, "0");
}

function matchesFilter(candidate: Pick<AccessPointCandidate, "lon" | "lat">, context: RouteGenerationV2Context): boolean {
  return context.accessFilter.predicates.every((geometry) =>
    coordinateIsInsideArea([candidate.lon, candidate.lat], geometry));
}

function candidateRank(left: AccessPointCandidate, right: AccessPointCandidate, includeUnknown: boolean): number {
  const connectivity = includeUnknown ? "inclusiveConnectivity" : "knownConnectivity";
  const degree = includeUnknown ? "inclusiveOutDegree" : "knownOutDegree";
  const confidence = { high: 0, medium: 1, low: 2 };
  return right[connectivity] - left[connectivity] ||
    right[degree] - left[degree] ||
    Number(left.name.startsWith("OSM ")) - Number(right.name.startsWith("OSM ")) ||
    confidence[left.confidence] - confidence[right.confidence] ||
    Number(Boolean(right.parkingEvidence)) - Number(Boolean(left.parkingEvidence)) ||
    left.id.localeCompare(right.id);
}

function internalRequest(
  request: GenerateRoutesRequestV2,
  startAccessPointId: string,
  routeType: GenerateRoutesRequestV2["routeTypes"][number],
  coverageBbox: GenerateRoutesRequestV1["bbox"],
): GenerateRoutesRequestV1 {
  return {
    version: 1,
    packId: request.packId,
    bbox: coverageBbox,
    startAccessPointId,
    routeTypes: [routeType],
    distanceMiles: request.distanceMiles,
    ...(request.elevationGainFeet ? { elevationGainFeet: request.elevationGainFeet } : {}),
    ...(request.maximumElevationFeet ? { maximumElevationFeet: request.maximumElevationFeet } : {}),
    ...(request.steepestSustainedGradePct
      ? { steepestSustainedGradePct: request.steepestSustainedGradePct }
      : {}),
    includeUncertainAccess: request.includeUncertainAccess,
    limit: request.limit,
  };
}

function endMatchesFilter(candidate: ScoredCandidate, context: RouteGenerationV2Context): boolean {
  const traversal = candidate.traversals.at(-1);
  if (!traversal) return false;
  return context.accessFilter.predicates.every((geometry) =>
    coordinateIsInsideArea([traversal.to.lon, traversal.to.lat], geometry));
}

function routeV2(
  candidate: ScoredCandidate,
  options: GeneratedRouteOptions,
  truncated: boolean,
  stale: boolean,
  context: RouteGenerationV2Context,
): GeneratedRouteV2 {
  const end = endMatchesFilter(candidate, context);
  const route = generatedRoute(candidate, options, truncated, stale);
  return {
    ...route,
    warnings: end || candidate.shape !== "point-to-point"
      ? route.warnings
      : [...new Set([...route.warnings, "Finish is outside the trailhead filter"])],
    filterMatch: { start: true, end },
  };
}

function selectWithStartDiversity(
  ranked: readonly ScoredCandidate[],
  limit: number,
  alreadySelected: readonly ScoredCandidate[] = [],
): ScoredCandidate[] {
  const selected: ScoredCandidate[] = [];
  const counts = new Map<string, number>();
  for (const candidate of alreadySelected) {
    counts.set(candidate.startAccessPoint.id, (counts.get(candidate.startAccessPoint.id) ?? 0) + 1);
  }
  const overlaps = (candidate: ScoredCandidate) => [...alreadySelected, ...selected].some(
    (other) => undirectedDistanceOverlap(candidate, other) > 0.8,
  );
  for (const candidate of ranked) {
    if (selected.length >= limit) break;
    if ((counts.get(candidate.startAccessPoint.id) ?? 0) >= FIRST_PASS_ROUTES_PER_START || overlaps(candidate)) continue;
    selected.push(candidate);
    counts.set(candidate.startAccessPoint.id, (counts.get(candidate.startAccessPoint.id) ?? 0) + 1);
  }
  for (const candidate of ranked) {
    if (selected.length >= limit) break;
    if (selected.some(({ id }) => id === candidate.id) || overlaps(candidate)) continue;
    selected.push(candidate);
  }
  return selected;
}

function filterPointToPointEnds(
  graph: InducedGraph,
  request: GenerateRoutesRequestV2,
  context: RouteGenerationV2Context,
): InducedGraph {
  if (!request.pointToPoint.finishMustMatchAccessFilter) return graph;
  return {
    ...graph,
    accessPoints: graph.accessPoints.filter((point) => {
      const node = graph.nodes.get(point.nodeId);
      return Boolean(node && context.accessFilter.predicates.every((geometry) =>
        coordinateIsInsideArea([node!.lon, node!.lat], geometry)));
    }),
  };
}

export class DeterministicMultiStartRouteSolver implements RouteSolverV2 {
  constructor(private readonly options: MultiStartRouteSolverOptions) {}

  async generate(
    request: GenerateRoutesRequestV2,
    context: RouteGenerationV2Context,
  ): Promise<GenerateRoutesResponseV2> {
    if (request.packId !== this.options.pack.id || context.repository.packId !== request.packId) {
      throw new Error(`Route solver pack mismatch for ${request.packId}`);
    }
    if (context.signal?.aborted) throw new RouteSearchCancelledError(context.signal.reason);
    const now = context.now ?? Date.now;
    const startedAt = now();
    const coverageBbox = areaBounds(context.accessFilter.coverage);
    const allCandidates = await context.repository.getAccessPointCandidates({
      bbox: coverageBbox,
      includeUncertainAccess: true,
      signal: context.signal,
    });
    const filtered = allCandidates.filter((candidate) => matchesFilter(candidate, context));
    const eligible = filtered.filter((candidate) => accessPointIsEligible(candidate, request.includeUncertainAccess));
    let starts: AccessPointCandidate[];
    if (request.startAccessPointId) {
      const known = allCandidates.find(({ id }) => id === request.startAccessPointId);
      if (!known) throw new AccessFilterResolutionError("START_NOT_FOUND", "The selected access point was not found");
      if (!matchesFilter(known, context)) {
        throw new AccessFilterResolutionError("START_OUTSIDE_FILTER", "The selected access point is outside the trailhead filter");
      }
      if (!accessPointIsEligible(known, request.includeUncertainAccess)) {
        throw new AccessFilterResolutionError("START_INELIGIBLE", "The selected access point is excluded by the access policy");
      }
      starts = [known];
    } else {
      starts = [...eligible]
        .sort((left, right) => candidateRank(left, right, request.includeUncertainAccess))
        .slice(0, MAXIMUM_AUTOMATIC_STARTS);
    }

    const candidates = new Map<string, ScoredCandidate>();
    const truncationReasons = new Set<string>();
    const shortfallReasons = new Set<string>();
    let expandedStates = 0;
    let candidateCount = 0;
    let graphQueryCount = 0;
    let maximumLoadedDirectedEdges = 0;
    let loadedDirectedEdges = 0;
    let searchedAccessPointCount = 0;
    const totalLanes = Math.max(1, starts.length * request.routeTypes.length);
    const laneStateLimit = Math.max(1, Math.floor(context.budget.maximumExpandedStates / totalLanes));
    const laneCandidateLimit = Math.max(1, Math.floor(context.budget.maximumRawCandidates / totalLanes));
    const laneDeadline = Math.max(1, Math.floor(
      Math.max(1, context.budget.deadlineMs - RESPONSE_HEADROOM_MILLISECONDS) / totalLanes,
    ));
    const routeCapMeters = request.distanceMiles.max * METERS_PER_MILE * 1.25;

    const reachableByStart = new Map<string, InducedGraph>();
    for (const start of starts) {
      if (now() - startedAt >= context.budget.deadlineMs - RESPONSE_HEADROOM_MILLISECONDS) {
        truncationReasons.add("deadline");
        break;
      }
      const remainingDirectedEdges = context.budget.maximumDirectedEdges - loadedDirectedEdges;
      if (remainingDirectedEdges <= 0) {
        truncationReasons.add("maximum-directed-edges");
        break;
      }
      const reachable = await context.repository.getReachableGraph({
        startNodeId: start.nodeId,
        maximumDistanceMeters: routeCapMeters,
        maximumDirectedEdges: remainingDirectedEdges,
        includeUncertainAccess: request.includeUncertainAccess,
        coverage: context.accessFilter.coverage,
        signal: context.signal,
      });
      graphQueryCount += 1;
      searchedAccessPointCount += 1;
      loadedDirectedEdges += reachable.graph.edges.length;
      maximumLoadedDirectedEdges = Math.max(maximumLoadedDirectedEdges, reachable.graph.edges.length);
      if (reachable.truncated) truncationReasons.add("maximum-directed-edges");
      reachableByStart.set(start.id, reachable.graph);
    }

    for (const routeType of request.routeTypes) {
      for (const start of starts) {
        if (now() - startedAt >= context.budget.deadlineMs - RESPONSE_HEADROOM_MILLISECONDS) {
          truncationReasons.add("deadline");
          break;
        }
        const reachable = reachableByStart.get(start.id);
        if (!reachable) continue;
        const laneRequest = internalRequest(request, start.id, routeType, [...coverageBbox]);
        const graph = routeType === "point-to-point"
          ? filterPointToPointEnds(reachable, request, context)
          : reachable;
        const generation = generateInitialCandidates(graph, laneRequest, {
          budget: {
            ...context.budget,
            maximumExpandedStates: laneStateLimit,
            maximumRawCandidates: laneCandidateLimit,
            deadlineMs: laneDeadline,
          },
          signal: context.signal,
          now,
        });
        expandedStates += generation.diagnostics.expandedStates;
        candidateCount += generation.diagnostics.candidateCount;
        for (const reason of generation.diagnostics.truncationReasons) truncationReasons.add(reason);
        for (const candidate of generation.candidates) {
          const scored = scoreCandidate(candidate, laneRequest);
          const existing = candidates.get(scored.id);
          if (!existing || compareScoredCandidates(scored, existing) < 0) candidates.set(scored.id, scored);
        }
      }
    }

    if (eligible.length === 0) shortfallReasons.add("no-eligible-start-access-points");
    if (eligible.length > starts.length) shortfallReasons.add("sampled-access-points");
    const ranked = [...candidates.values()].sort(compareScoredCandidates);
    const exact = selectWithStartDiversity(ranked.filter(({ exact }) => exact), request.limit);
    const nearMisses = selectWithStartDiversity(ranked.filter(({ exact }) => !exact), 3, exact);
    if (exact.length < request.limit) shortfallReasons.add("fewer-exact-routes-than-requested");
    const sourceOptions: GeneratedRouteOptions = {
      sourceFreshness: this.options.sourceFreshness ?? this.options.pack.builtAt,
      sourceConfidence: this.options.sourceConfidence ?? "high",
      fallbackSourceIds: this.options.fallbackSourceIds ?? [`${this.options.pack.id}:manifest`],
    };
    const stale = now() - Date.parse(sourceOptions.sourceFreshness) > 30 * 24 * 60 * 60 * 1_000;
    const truncated = truncationReasons.size > 0 && exact.length < request.limit;
    return {
      version: 2,
      requestId: this.options.requestIdFactory?.(request) ?? `route-request-${stableHash(JSON.stringify(request))}`,
      pack: this.options.pack,
      requested: request.limit,
      resolvedAccessFilter: context.accessFilter.summary,
      exact: exact.map((candidate) => routeV2(candidate, sourceOptions, truncated, stale, context)),
      nearMisses: nearMisses.map((candidate) => ({
        ...routeV2(candidate, sourceOptions, truncated, stale, context),
        violations: candidate.violations,
      })),
      diagnostics: {
        elapsedMs: Math.max(0, now() - startedAt),
        expandedStates,
        candidateCount,
        eligibleAccessPointCount: eligible.length,
        searchedAccessPointCount,
        graphQueryCount,
        maximumLoadedDirectedEdges,
        exhausted: truncationReasons.size > 0,
        truncationReasons: [...truncationReasons].sort(),
        shortfallReasons: [...shortfallReasons].sort(),
      },
    };
  }
}

export function createMultiStartRouteSolver(options: MultiStartRouteSolverOptions): RouteSolverV2 {
  return new DeterministicMultiStartRouteSolver(options);
}
