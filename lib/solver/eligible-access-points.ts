import { accessPointIsWildEnough } from "@/lib/data/wilderness";
import {
  accessPointIsEligible,
  areaBounds,
  coordinateIsInsideArea,
  distanceMetersToArea,
  type AccessPointCandidate,
  type GraphRepository,
} from "@/lib/graph";
import type { ResolvedAccessFilterContext } from "./types";

export type EligibleAccessPointQuery = {
  repository: GraphRepository;
  accessFilter: ResolvedAccessFilterContext;
  includeUncertainAccess: boolean;
  startAccessPointId?: string;
  signal?: AbortSignal;
};

/**
 * Reviewed named regions represent destinations such as parks, preserves, and
 * wilderness areas. Their usable trailheads commonly sit just outside the
 * legal boundary, so named-region searches admit trail portals in a bounded
 * approach band. Drawn areas and drive-time contours remain exact.
 */
export const PORTAL_NAMED_REGION_TOLERANCE_M = 500;

/**
 * A start with no reachable cycle can never produce a closed route, so the
 * solver already discards it after loading its topology. Rejecting it here
 * keeps it off the map and out of preview counts as well.
 *
 * The measurement comes from the `inclusive` profile, which is the permissive
 * superset of `known`: a start that fails it fails under every access setting.
 * `null` means the pack predates closed-route topology and is kept.
 */
export function accessPointCanStartClosedRoute(
  candidate: Pick<AccessPointCandidate, "canReachCycle">,
): boolean {
  return candidate.canReachCycle !== false;
}

export function accessPointMatchesResolvedFilter(
  candidate: Pick<AccessPointCandidate, "lon" | "lat" | "trailComponentId">,
  accessFilter: ResolvedAccessFilterContext,
): boolean {
  const namedRegionPredicateIndex = accessFilter.namedRegionPredicateIndex ?? -1;
  return accessFilter.predicates.every((geometry, index) => {
    const coordinate = [candidate.lon, candidate.lat] as const;
    if (coordinateIsInsideArea(coordinate, geometry)) return true;
    return candidate.trailComponentId !== undefined
      && index === namedRegionPredicateIndex
      && distanceMetersToArea(coordinate, geometry) <= PORTAL_NAMED_REGION_TOLERANCE_M;
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
   * Passed the geometry, access, and remoteness filters but not yet the
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
    const bounds=areaBounds(geometry);
    const dy=index===query.accessFilter.namedRegionPredicateIndex ? PORTAL_NAMED_REGION_TOLERANCE_M/110_000 : 0;
    const dx=dy/Math.max(0.00001,Math.cos(Math.min(90,Math.max(Math.abs(bounds[1]),Math.abs(bounds[3]))+dy)*Math.PI/180));
    bbox[0]=Math.max(bbox[0],bounds[0]-dx);bbox[1]=Math.max(bbox[1],bounds[1]-dy);
    bbox[2]=Math.min(bbox[2],bounds[2]+dx);bbox[3]=Math.min(bbox[3],bounds[3]+dy);
  });
  const all = bbox[0]>bbox[2] || bbox[1]>bbox[3] ? [] : await query.repository.getAccessPointCandidates({
    bbox,
    includeUncertainAccess: true,
    signal: query.signal,
  });
  // Preserve the distinction between a missing selected start and one outside
  // the filter without loading every other start in the installed graph.
  if (query.startAccessPointId && !all.some(point=>point.id===query.startAccessPointId)) {
    const selected = await query.repository.getAccessPointCandidates({bbox:coverageBounds,accessPointId:query.startAccessPointId,includeUncertainAccess:true,signal:query.signal});
    const point=selected.find(point=>point.id===query.startAccessPointId);
    if(point)all.push(point);
  }
  const matchedFilters = all
    .filter((candidate) => accessPointMatchesResolvedFilter(candidate, query.accessFilter))
    .filter((candidate) => accessPointIsEligible(candidate, query.includeUncertainAccess))
    .filter(accessPointIsWildEnough)
    .sort((left, right) => rankAccessPointCandidates(left, right, query.includeUncertainAccess));
  const eligible = matchedFilters.filter(accessPointCanStartClosedRoute);
  // Reported rather than discarded: it is the only thing that explains an empty
  // result in a compact drawn area.
  return { all, eligible, matchedFilters, noCycleExcluded: matchedFilters.length - eligible.length };
}
