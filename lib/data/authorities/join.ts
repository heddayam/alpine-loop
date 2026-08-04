import type { OfficialAccessJoin, OfficialAccessJoinFeature } from "./types";

/**
 * Produces compiler-compatible evidence while retaining the authority's stable
 * feature ID in a required companion audit record.
 */
export function attachOfficialEvidence(
  feature: OfficialAccessJoinFeature,
  targetExternalId: string,
  match: Pick<OfficialAccessJoin, "matchMethod" | "distanceM">,
): OfficialAccessJoin {
  if (!targetExternalId.trim()) throw new Error("Official evidence join has no target external ID");
  if (!Number.isFinite(match.distanceM) || match.distanceM < 0) throw new Error("Official evidence join has invalid distance");
  return {
    sourceId: feature.sourceId,
    authorityFeatureId: feature.authorityFeatureId,
    targetExternalId,
    ...match,
    evidence: { ...feature.evidence, externalId: targetExternalId },
  };
}
