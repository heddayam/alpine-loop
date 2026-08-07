import type { AccessPointRemoteness } from "@/lib/contracts";
import { classifyRemoteness } from "@/lib/data/remoteness";
import {
  accessPointIsEligible,
  areaBounds,
  coordinateIsInsideArea,
  type AccessPointCandidate,
  type GraphRepository,
} from "@/lib/graph";
import type { ResolvedAccessFilterContext } from "./types";

export type EligibleAccessPointQuery = {
  repository: GraphRepository;
  accessFilter: ResolvedAccessFilterContext;
  includeUncertainAccess: boolean;
  accessPointRemoteness: readonly AccessPointRemoteness[];
  signal?: AbortSignal;
};

export function accessPointMatchesResolvedFilter(
  candidate: Pick<AccessPointCandidate, "lon" | "lat">,
  accessFilter: ResolvedAccessFilterContext,
): boolean {
  return accessFilter.predicates.every((geometry) =>
    coordinateIsInsideArea([candidate.lon, candidate.lat], geometry));
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
): Promise<{ all: AccessPointCandidate[]; eligible: AccessPointCandidate[] }> {
  const all = await query.repository.getAccessPointCandidates({
    bbox: areaBounds(query.accessFilter.coverage),
    includeUncertainAccess: true,
    signal: query.signal,
  });
  const allowedRemoteness = new Set(query.accessPointRemoteness);
  const eligible = all
    .filter((candidate) => accessPointMatchesResolvedFilter(candidate, query.accessFilter))
    .filter((candidate) => accessPointIsEligible(candidate, query.includeUncertainAccess))
    .filter((candidate) => allowedRemoteness.has(classifyRemoteness(candidate)))
    .sort((left, right) => rankAccessPointCandidates(left, right, query.includeUncertainAccess));
  return { all, eligible };
}
