import type { NormalizedAccessEvidence } from "./adapters";
import { snapAccessPointsToTopology } from "./access-point-snap";
import type { NormalizedAccessPoint, NormalizedTopology } from "./types";

const DEFAULT_MAX_DISTANCE_M = 200;

export type AddOfficialAccessPointsResult = {
  topology: NormalizedTopology;
  addedCount: number;
  rejectedCount: number;
  deduplicatedCount: number;
  addedAccessPointIds: string[];
  rejectedAccessPointIds: string[];
  deduplicatedAccessPointIds: string[];
};

function encodedEvidenceKey(evidence: Pick<NormalizedAccessEvidence, "sourceId" | "externalId">): string {
  return `${encodeURIComponent(evidence.sourceId)}:${encodeURIComponent(evidence.externalId)}`;
}

export function officialAccessPointId(
  evidence: Pick<NormalizedAccessEvidence, "sourceId" | "externalId">,
): string {
  return `official-access:${encodedEvidenceKey(evidence)}`;
}

function officialCoordinateNodeId(
  evidence: Pick<NormalizedAccessEvidence, "sourceId" | "externalId">,
): string {
  return `official-access-coordinate:${encodedEvidenceKey(evidence)}`;
}

function validateEvidence(evidence: NormalizedAccessEvidence, index: number): void {
  if (!evidence.sourceId.trim() || !evidence.externalId.trim()) {
    throw new Error(`Official access evidence ${index} must have non-empty source and external IDs`);
  }
  if (!evidence.name.trim()) throw new Error(`Official access evidence ${index} must have a non-empty name`);
  if (!Number.isFinite(evidence.lon) || evidence.lon < -180 || evidence.lon > 180
    || !Number.isFinite(evidence.lat) || evidence.lat < -90 || evidence.lat > 90) {
    throw new Error(`Official access evidence ${index} has invalid coordinates`);
  }
}

function isNamed(point: NormalizedAccessPoint): boolean {
  return point.name.trim().length > 0 && !point.name.startsWith("OSM ");
}

/**
 * Adds authority entrance points without inventing connector edges. Each point
 * is represented at its source coordinate only long enough to reuse the normal
 * conservative node snap; rejected coordinate nodes are not retained.
 */
export function addOfficialAccessPointsToTopology(
  topology: NormalizedTopology,
  evidence: readonly NormalizedAccessEvidence[],
  maxDistanceM = DEFAULT_MAX_DISTANCE_M,
): AddOfficialAccessPointsResult {
  if (!Number.isFinite(maxDistanceM) || maxDistanceM <= 0) {
    throw new Error("Official access-point snap distance must be a positive finite number");
  }

  const evidenceKeys = new Set<string>();
  evidence.forEach((item, index) => {
    validateEvidence(item, index);
    const key = encodedEvidenceKey(item);
    if (evidenceKeys.has(key)) throw new Error(`Duplicate official access evidence ${item.sourceId} / ${item.externalId}`);
    evidenceKeys.add(key);
  });
  const orderedEvidence = [...evidence].sort((first, second) =>
    encodedEvidenceKey(first).localeCompare(encodedEvidenceKey(second)));
  const existingById = new Map(topology.accessPoints.map((point) => [point.id, point]));
  const candidatePoints: NormalizedAccessPoint[] = [];
  const coordinateNodes = [];
  const alreadyPresentIds: string[] = [];
  const inputNodeIds = new Set(topology.nodes.map(({ id }) => id));

  for (const item of orderedEvidence) {
    const id = officialAccessPointId(item);
    const existing = existingById.get(id);
    if (existing) {
      if (existing.externalId !== item.externalId || !existing.sourceRefs.includes(item.sourceId)) {
        throw new Error(`Official access point ID ${id} collides with an unrelated existing point`);
      }
      alreadyPresentIds.push(id);
      continue;
    }
    const nodeId = officialCoordinateNodeId(item);
    if (inputNodeIds.has(nodeId)) throw new Error(`Official access coordinate node ID ${nodeId} already exists`);
    coordinateNodes.push({
      id: nodeId,
      externalId: nodeId,
      lon: item.lon,
      lat: item.lat,
      elevationM: null,
      flags: ["official-access-coordinate"],
      sourceRefs: [item.sourceId],
    });
    candidatePoints.push({
      id,
      externalId: item.externalId,
      nodeId,
      name: item.name,
      kind: "trailhead",
      accessState: item.accessState,
      confidence: item.confidence,
      parkingEvidence: null,
      sourceRefs: [item.sourceId],
    });
  }

  const snapped = snapAccessPointsToTopology({
    ...topology,
    nodes: [...topology.nodes, ...coordinateNodes],
    accessPoints: candidatePoints,
  }, maxDistanceM);
  const rejectedSet = new Set(snapped.rejectedAccessPointIds);
  const officialIds = new Set(candidatePoints.map(({ id }) => id));
  const acceptedOfficial = snapped.topology.accessPoints.filter(({ id }) => officialIds.has(id));
  const acceptedOfficialByNode = new Map<string, NormalizedAccessPoint[]>();
  for (const point of acceptedOfficial) {
    acceptedOfficialByNode.set(point.nodeId, [...(acceptedOfficialByNode.get(point.nodeId) ?? []), point]);
  }

  const removedIds: string[] = [];
  const retainedExisting = topology.accessPoints.filter((point) => {
    const colliding = acceptedOfficialByNode.get(point.nodeId) ?? [];
    if (colliding.length === 0) return true;
    if (colliding.some(isNamed)) {
      removedIds.push(point.id);
      return false;
    }
    return true;
  });

  // Distinct authority records remain distinct even when a coarse trail graph
  // snaps them to the same node; only exact duplicate evidence is invalid.
  const retainedOfficial = acceptedOfficial;
  const finalAccessPoints = [...retainedExisting, ...retainedOfficial].sort((first, second) => first.id.localeCompare(second.id));
  const addedAccessPointIds = retainedOfficial.map(({ id }) => id).sort();
  const rejectedAccessPointIds = candidatePoints.filter(({ id }) => rejectedSet.has(id)).map(({ id }) => id).sort();
  const deduplicatedAccessPointIds = [...new Set([...alreadyPresentIds, ...removedIds])].sort();

  return {
    topology: { ...topology, accessPoints: finalAccessPoints },
    addedCount: addedAccessPointIds.length,
    rejectedCount: rejectedAccessPointIds.length,
    deduplicatedCount: deduplicatedAccessPointIds.length,
    addedAccessPointIds,
    rejectedAccessPointIds,
    deduplicatedAccessPointIds,
  };
}
