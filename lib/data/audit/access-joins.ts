import type { OfficialAccessJoin, OfficialAccessJoinFeature } from "../authorities";

export type OfficialAccessJoinAudit = {
  authorityFeatureCount: number;
  appliedJoinCount: number;
  unmatchedAuthorityFeatureIds: string[];
  errors: string[];
  warnings: string[];
};

const key = (sourceId: string, authorityFeatureId: string) => `${sourceId}:${authorityFeatureId}`;

/** Audits the companion provenance that must travel with joined evidence. */
export function auditOfficialAccessJoins(
  features: readonly OfficialAccessJoinFeature[],
  joins: readonly OfficialAccessJoin[],
  knownTargetExternalIds: ReadonlySet<string>,
): OfficialAccessJoinAudit {
  const errors: string[] = [];
  const warnings: string[] = [];
  const authorityKeys = new Set<string>();
  for (const feature of features) {
    const featureKey = key(feature.sourceId, feature.authorityFeatureId);
    if (authorityKeys.has(featureKey)) errors.push(`Duplicate authority feature ${featureKey}`);
    authorityKeys.add(featureKey);
  }
  const joinedKeys = new Set<string>();
  for (const join of joins) {
    const joinKey = key(join.sourceId, join.authorityFeatureId);
    if (!authorityKeys.has(joinKey)) errors.push(`Join references unknown authority feature ${joinKey}`);
    if (!knownTargetExternalIds.has(join.targetExternalId)) errors.push(`Join ${joinKey} references unknown topology feature ${join.targetExternalId}`);
    if (join.evidence.sourceId !== join.sourceId || join.evidence.externalId !== join.targetExternalId) {
      errors.push(`Join ${joinKey} evidence does not preserve its source/target identity`);
    }
    if (!Number.isFinite(join.distanceM) || join.distanceM < 0) errors.push(`Join ${joinKey} has invalid match distance`);
    joinedKeys.add(joinKey);
  }
  const unmatchedAuthorityFeatureIds = [...authorityKeys].filter((featureKey) => !joinedKeys.has(featureKey));
  if (unmatchedAuthorityFeatureIds.length) warnings.push(`${unmatchedAuthorityFeatureIds.length} authority features were not matched to topology`);
  return {
    authorityFeatureCount: features.length,
    appliedJoinCount: joins.length,
    unmatchedAuthorityFeatureIds,
    errors,
    warnings,
  };
}
