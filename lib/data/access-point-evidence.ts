import { reconcileAccess } from "./access";
import type { OfficialAccessJoin } from "./authorities";
import type { NormalizedAccessPoint, NormalizedTopology } from "./types";

export type AccessPointEvidenceResult = {
  topology: NormalizedTopology;
  promotedPublicCount: number;
  restrictedCount: number;
  conflictedCount: number;
};

/**
 * Applies official trail access at a snapped network node to otherwise unknown
 * trailheads. Parking is deliberately excluded: permission to use a trail is
 * not permission to use an independently mapped parking facility. Explicit
 * OSM permissions and restrictions also remain untouched.
 */
export function applyOfficialWayEvidenceToAccessPoints(
  topology: NormalizedTopology,
  joins: readonly OfficialAccessJoin[],
): AccessPointEvidenceResult {
  const joinsByWay = new Map<string, OfficialAccessJoin[]>();
  for (const join of joins) {
    joinsByWay.set(join.targetExternalId, [...(joinsByWay.get(join.targetExternalId) ?? []), join]);
  }
  const joinsByNode = new Map<string, OfficialAccessJoin[]>();
  for (const way of topology.ways) {
    const wayJoins = joinsByWay.get(way.externalId) ?? [];
    if (wayJoins.length === 0) continue;
    for (const nodeId of way.nodeIds) {
      joinsByNode.set(nodeId, [...(joinsByNode.get(nodeId) ?? []), ...wayJoins]);
    }
  }

  let promotedPublicCount = 0;
  let restrictedCount = 0;
  let conflictedCount = 0;
  const accessPoints = topology.accessPoints.map((point): NormalizedAccessPoint => {
    if (point.kind !== "trailhead" || point.accessState !== "unknown") return point;
    const connected = joinsByNode.get(point.nodeId) ?? [];
    if (connected.length === 0) return point;
    const resolution = reconcileAccess("unknown", connected.map(({ evidence }) => evidence.accessState));
    if (resolution.conflict) {
      conflictedCount += 1;
      return point;
    }
    if (resolution.state === "unknown") return point;
    if (resolution.state === "public") promotedPublicCount += 1;
    else restrictedCount += 1;
    const confidence = connected.some(({ evidence }) => evidence.confidence === "high")
      ? "high"
      : connected.some(({ evidence }) => evidence.confidence === "medium") ? "medium" : point.confidence;
    return {
      ...point,
      accessState: resolution.state,
      confidence,
      sourceRefs: [...new Set([...point.sourceRefs, ...connected.map(({ sourceId }) => sourceId)])].sort(),
    };
  });
  return {
    topology: { ...topology, accessPoints },
    promotedPublicCount,
    restrictedCount,
    conflictedCount,
  };
}
