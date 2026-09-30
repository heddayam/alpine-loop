import {
  accessPointIsEligible,
  areaBounds,
  coordinateIsInsideArea,
  type AccessPointCandidate,
  type BoundingBox,
  type GraphRepository,
} from "@/lib/graph";
import type { ResolvedAccessFilterContext } from "./types";

export type EligibleAccessPointQuery = {
  repository: GraphRepository;
  accessFilter: ResolvedAccessFilterContext;
  includeUncertainAccess: boolean;
  startAccessPointId?: string;
  /** Rendering/fetch bound only; never changes membership or owner choice. */
  viewportBbox?: BoundingBox;
  signal?: AbortSignal;
};

/**
 * Repositories set this hint from the requested profile of the owning graph.
 * A false hint safely excludes a start; a finite hint does not prove a route.
 * Missing hints remain conservative for in-memory/legacy fixture repositories.
 */
export function accessPointCanStartClosedRoute(
  candidate: Pick<AccessPointCandidate, "canReachCycle">,
): boolean {
  return candidate.canReachCycle !== false;
}

export function accessPointMatchesResolvedFilter(
  candidate: Pick<AccessPointCandidate, "lon" | "lat" | "regionIds">,
  accessFilter: ResolvedAccessFilterContext,
): boolean {
  const namedRegionPredicateIndex = accessFilter.namedRegionPredicateIndex ?? -1;
  const namedRegionIds = accessFilter.namedRegionIds;
  if ((namedRegionPredicateIndex >= 0 || (namedRegionIds?.length ?? 0) > 0)
    && !candidate.regionIds?.some(id => namedRegionIds?.includes(id))) return false;
  return accessFilter.predicates.every((geometry, index) => {
    // Named membership is authoritative; circles/core outlines are display data.
    return index === namedRegionPredicateIndex
      || coordinateIsInsideArea([candidate.lon, candidate.lat], geometry);
  });
}

export function rankAccessPointCandidates(
  left: AccessPointCandidate,
  right: AccessPointCandidate,
  includeUnknown: boolean,
): number {
  const confidence = { high: 0, medium: 1, low: 2 };
  const portalRanking = left.trailComponentId !== undefined || right.trailComponentId !== undefined;
  if (portalRanking) {
    return (right.reachableTrailKm ?? 0) - (left.reachableTrailKm ?? 0)
      || (left.parkingDistanceM ?? Number.POSITIVE_INFINITY) - (right.parkingDistanceM ?? Number.POSITIVE_INFINITY)
      || confidence[left.confidence] - confidence[right.confidence]
      || left.id.localeCompare(right.id);
  }
  return right.knownConnectivity - left.knownConnectivity
    || right.knownOutDegree - left.knownOutDegree
    || (includeUnknown ? right.inclusiveConnectivity - left.inclusiveConnectivity : 0)
    || (includeUnknown ? right.inclusiveOutDegree - left.inclusiveOutDegree : 0)
    || confidence[left.confidence] - confidence[right.confidence]
    || left.id.localeCompare(right.id);
}

export async function listEligibleAccessPointCandidates(
  query: EligibleAccessPointQuery,
): Promise<{
  all: AccessPointCandidate[];
  /** Passed every filter, including closed-route reachability. */
  eligible: AccessPointCandidate[];
  /**
   * Passed the membership, geometry, and access filters but not yet the
   * closed-route filter. An explicitly chosen start is checked against this so
   * a no-cycle selection reports the honest reason instead of being blamed on
   * the access-point area settings.
   */
  matchedFilters: AccessPointCandidate[];
  noCycleExcluded: number;
}> {
  const coverageBounds = areaBounds(query.accessFilter.coverage);
  const bbox = [...coverageBounds] as [number,number,number,number];
  query.accessFilter.predicates.forEach((geometry,index) => {
    if (index === query.accessFilter.namedRegionPredicateIndex) return;
    const bounds=areaBounds(geometry);
    bbox[0]=Math.max(bbox[0],bounds[0]);bbox[1]=Math.max(bbox[1],bounds[1]);
    bbox[2]=Math.min(bbox[2],bounds[2]);bbox[3]=Math.min(bbox[3],bounds[3]);
  });
  if (query.viewportBbox) {
    bbox[0]=Math.max(bbox[0],query.viewportBbox[0]);bbox[1]=Math.max(bbox[1],query.viewportBbox[1]);
    bbox[2]=Math.min(bbox[2],query.viewportBbox[2]);bbox[3]=Math.min(bbox[3],query.viewportBbox[3]);
  }
  const all = bbox[0]>bbox[2] || bbox[1]>bbox[3] ? [] : await query.repository.getAccessPointCandidates({
    bbox,
    includeUncertainAccess: query.includeUncertainAccess,
    signal: query.signal,
  });
  let ineligibleExplicitStart: string | undefined;
  // Preserve the distinction between a missing selected start and one outside
  // the filter without loading every other start in the installed graph.
  if (query.startAccessPointId && !all.some(point=>point.id===query.startAccessPointId)) {
    const selected = await query.repository.getAccessPointCandidates({bbox:coverageBounds,accessPointId:query.startAccessPointId,includeUncertainAccess:query.includeUncertainAccess,signal:query.signal});
    const point=selected.find(point=>point.id===query.startAccessPointId);
    if(point)all.push(point);
    else if (!query.includeUncertainAccess) {
      // An inclusive fallback is diagnostic only: never let it replace the
      // requested-profile owner or enter the eligible/matched sets.
      const inclusive = await query.repository.getAccessPointCandidates({bbox:coverageBounds,accessPointId:query.startAccessPointId,includeUncertainAccess:true,signal:query.signal});
      const fallback = inclusive.find(point=>point.id===query.startAccessPointId);
      if (fallback) { all.push(fallback); ineligibleExplicitStart = fallback.id; }
    }
  }
  const matchedFilters = all
    .filter((candidate) => accessPointMatchesResolvedFilter(candidate, query.accessFilter))
    .filter((candidate) => accessPointIsEligible(candidate, query.includeUncertainAccess))
    .filter((candidate) => candidate.id !== ineligibleExplicitStart)
    .sort((left, right) => rankAccessPointCandidates(left, right, query.includeUncertainAccess));
  const eligible = matchedFilters.filter(candidate => {
    const minimumStem = query.includeUncertainAccess ? candidate.inclusiveMinimumStemMeters : candidate.knownMinimumStemMeters;
    return minimumStem === undefined ? accessPointCanStartClosedRoute(candidate) : minimumStem !== null;
  });
  // Reported rather than discarded: it is the only thing that explains an empty
  // result in a compact drawn area.
  return { all, eligible, matchedFilters, noCycleExcluded: matchedFilters.length - eligible.length };
}
