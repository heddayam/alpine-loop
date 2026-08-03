import { createSegmentId, validateTrailSegment } from "../model.mjs";
import { orientLineString } from "../spatial/geometry.mjs";
import { geodesicDistanceMeters, geodesicLineLengthMeters } from "../spatial/length.mjs";
import {
  deduplicateSourceRefs,
  normalizeSegmentCandidates,
  normalizeSegmentText,
} from "./segments.mjs";
import {
  buildSegmentProvenance,
  provenanceConflicts,
  selectPreferredCandidate,
} from "./provenance.mjs";

export const DEFAULT_MERGE_TOLERANCE_METERS = 12;

function radians(value) {
  return value * Math.PI / 180;
}

function longitudeDelta(left, right) {
  let delta = right - left;
  if (delta > 180) delta -= 360;
  if (delta < -180) delta += 360;
  return delta;
}

function pointToSegmentDistanceMeters(point, start, end) {
  const referenceLatitude = radians((point[1] + start[1] + end[1]) / 3);
  const metersPerDegreeLatitude = 111_195.080_233_532_9;
  const x = longitudeDelta(start[0], point[0]) * Math.cos(referenceLatitude) * metersPerDegreeLatitude;
  const y = (point[1] - start[1]) * metersPerDegreeLatitude;
  const endX = longitudeDelta(start[0], end[0]) * Math.cos(referenceLatitude) * metersPerDegreeLatitude;
  const endY = (end[1] - start[1]) * metersPerDegreeLatitude;
  const denominator = endX ** 2 + endY ** 2;
  if (denominator === 0) return Math.hypot(x, y);
  const projection = Math.max(0, Math.min(1, (x * endX + y * endY) / denominator));
  return Math.hypot(x - projection * endX, y - projection * endY);
}

function pointToLineDistanceMeters(point, geometry) {
  let nearest = Infinity;
  for (let index = 1; index < geometry.coordinates.length; index += 1) {
    nearest = Math.min(nearest, pointToSegmentDistanceMeters(
      point,
      geometry.coordinates[index - 1],
      geometry.coordinates[index],
    ));
  }
  return nearest;
}

/** Symmetric vertex-to-line Hausdorff distance for trail-sized LineStrings. */
export function geometryProximityMeters(left, right) {
  let maximum = 0;
  for (const point of left.coordinates) {
    maximum = Math.max(maximum, pointToLineDistanceMeters(point, right));
  }
  for (const point of right.coordinates) {
    maximum = Math.max(maximum, pointToLineDistanceMeters(point, left));
  }
  return maximum;
}

function endpointAlignmentMeters(left, right) {
  const leftStart = left.coordinates[0];
  const leftEnd = left.coordinates.at(-1);
  const rightStart = right.coordinates[0];
  const rightEnd = right.coordinates.at(-1);
  return Math.min(
    Math.max(
      geodesicDistanceMeters(leftStart, rightStart),
      geodesicDistanceMeters(leftEnd, rightEnd),
    ),
    Math.max(
      geodesicDistanceMeters(leftStart, rightEnd),
      geodesicDistanceMeters(leftEnd, rightStart),
    ),
  );
}

function exactGeometry(left, right) {
  const forward = JSON.stringify(left.coordinates);
  const reverse = JSON.stringify([...left.coordinates].reverse());
  const candidate = JSON.stringify(right.coordinates);
  return candidate === forward || candidate === reverse;
}

function matchingText(left, right, field) {
  const a = normalizeSegmentText(left[field]);
  const b = normalizeSegmentText(right[field]);
  if (!a || !b) return undefined;
  return a === b;
}

function descriptiveEvidenceCompatible(left, right) {
  const nameMatches = matchingText(left, right, "name");
  const managerMatches = matchingText(left, right, "manager");
  if (nameMatches === true || managerMatches === true) return true;
  if (nameMatches === false || managerMatches === false) return false;
  // Missing names/managers must not make otherwise duplicate unnamed graph
  // edges unmergeable.
  return true;
}

export function segmentsCanMerge(
  left,
  right,
  { toleranceMeters = DEFAULT_MERGE_TOLERANCE_METERS } = {},
) {
  if (!Number.isFinite(toleranceMeters) || toleranceMeters < 0) {
    throw new TypeError("toleranceMeters must be a non-negative finite number");
  }
  if (exactGeometry(left.geometry, right.geometry)) return true;
  if (!descriptiveEvidenceCompatible(left, right)) return false;
  return endpointAlignmentMeters(left.geometry, right.geometry) <= toleranceMeters &&
    geometryProximityMeters(left.geometry, right.geometry) <= toleranceMeters;
}

function candidateSortKey(candidate) {
  const sources = candidate.sourceRefs
    .map(({ provider, sourceId }) => `${provider.toLowerCase()}:${sourceId.toLowerCase()}`)
    .sort()
    .join("|");
  return `${sources}\u0000${candidate.id}\u0000${JSON.stringify(candidate.geometry.coordinates)}`;
}

function clusterCandidates(candidates, options) {
  const groups = [];
  for (const candidate of [...candidates].sort((left, right) =>
    candidateSortKey(left).localeCompare(candidateSortKey(right)))) {
    const group = groups.find((members) =>
      members.every((member) => segmentsCanMerge(member, candidate, options)));
    if (group) group.push(candidate);
    else groups.push([candidate]);
  }
  return groups;
}

function orientedDisplayGeometry(candidate, requestedStart) {
  if (!candidate.displayGeometry) return undefined;
  return orientLineString(candidate.displayGeometry, requestedStart);
}

function selectedValue(candidates, field) {
  return selectPreferredCandidate(candidates, field)?.[field];
}

export function mergeSegmentGroup(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new TypeError("candidates must contain at least one segment");
  }
  const geometryCandidate = selectPreferredCandidate(candidates, "geometry");
  const topologyCandidate = selectPreferredCandidate(candidates, "fromNodeId") ?? geometryCandidate;
  const requestedStart = topologyCandidate.geometry.coordinates[0];
  const geometry = orientLineString(geometryCandidate.geometry, requestedStart);
  const displayGeometry = geometryCandidate.displayGeometry
    ? orientedDisplayGeometry(geometryCandidate, requestedStart)
    : undefined;
  const sourceRefs = deduplicateSourceRefs(candidates.flatMap(({ sourceRefs }) => sourceRefs));
  const segment = {
    id: createSegmentId(sourceRefs, geometry),
    fromNodeId: topologyCandidate.fromNodeId,
    toNodeId: topologyCandidate.toNodeId,
    geometry,
    ...(displayGeometry ? { displayGeometry } : {}),
    ...Object.fromEntries(["name", "manager", "surface"].flatMap((field) => {
      const value = selectedValue(candidates, field);
      return value === undefined ? [] : [[field, value]];
    })),
    hiking: selectedValue(candidates, "hiking") ?? "unknown",
    access: selectedValue(candidates, "access") ?? "unknown",
    status: selectedValue(candidates, "status") ?? "unknown",
    lengthMeters: geodesicLineLengthMeters(geometry),
    ...Object.fromEntries([
      "ascentForwardMeters",
      "descentForwardMeters",
      "minElevationMeters",
      "maxElevationMeters",
      "maxGradePct",
    ].flatMap((field) => {
      const value = selectedValue(candidates, field);
      return value === undefined ? [] : [[field, value]];
    })),
    sourceRefs,
  };
  validateTrailSegment(segment);
  const provenance = buildSegmentProvenance(candidates, segment);
  return { segment, provenance, conflicts: provenanceConflicts(segment.id, provenance) };
}

/**
 * Merge provisional agency and OSM segments deterministically. Provenance and
 * QA conflicts are sidecars so output segments retain the canonical contract.
 */
export function mergeTrailSegments(inputCandidates, options = {}) {
  const candidates = normalizeSegmentCandidates(inputCandidates);
  const merged = clusterCandidates(candidates, options).map(mergeSegmentGroup)
    .sort((left, right) => left.segment.id.localeCompare(right.segment.id));
  const segments = merged.map(({ segment }) => segment);
  const provenance = Object.fromEntries(merged.map((entry) => [
    entry.segment.id,
    entry.provenance,
  ]));
  const conflicts = merged.flatMap(({ conflicts: groupConflicts }) => groupConflicts)
    .sort((left, right) => left.segmentId.localeCompare(right.segmentId) ||
      left.field.localeCompare(right.field));
  return {
    segments,
    provenance,
    conflicts,
    issues: conflicts,
    qa: { mergeConflicts: conflicts },
  };
}

export const mergeSegments = mergeTrailSegments;
export const mergeNormalizedSegments = mergeTrailSegments;
