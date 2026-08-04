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
  providerClass,
  provenanceConflicts,
  selectPreferredCandidate,
} from "./provenance.mjs";

export const DEFAULT_MERGE_TOLERANCE_METERS = 12;
export const DEFAULT_RECONCILIATION_OPTIONS = Object.freeze({
  snapToleranceMeters: 20,
  minimumCoverageRatio: 0.9,
  maximumGapMeters: 30,
});

const SPATIAL_INDEX_CELL_DEGREES = 0.01;

function geometryBounds(geometry) {
  return geometry.coordinates.reduce((bounds, [longitude, latitude]) => [
    Math.min(bounds[0], longitude),
    Math.min(bounds[1], latitude),
    Math.max(bounds[2], longitude),
    Math.max(bounds[3], latitude),
  ], [Infinity, Infinity, -Infinity, -Infinity]);
}

function expandedGeometryBounds(geometry, meters = 0) {
  const bounds = geometryBounds(geometry);
  const latitude = (bounds[1] + bounds[3]) / 2;
  const latitudePadding = meters / 111_195.080_233_532_9;
  const longitudePadding = latitudePadding / Math.max(0.1, Math.cos(radians(latitude)));
  return [
    bounds[0] - longitudePadding,
    bounds[1] - latitudePadding,
    bounds[2] + longitudePadding,
    bounds[3] + latitudePadding,
  ];
}

function spatialCellKeys(bounds) {
  const west = Math.floor(bounds[0] / SPATIAL_INDEX_CELL_DEGREES);
  const south = Math.floor(bounds[1] / SPATIAL_INDEX_CELL_DEGREES);
  const east = Math.floor(bounds[2] / SPATIAL_INDEX_CELL_DEGREES);
  const north = Math.floor(bounds[3] / SPATIAL_INDEX_CELL_DEGREES);
  const keys = [];
  for (let x = west; x <= east; x += 1) {
    for (let y = south; y <= north; y += 1) keys.push(`${x}:${y}`);
  }
  return keys;
}

function createSpatialCandidateIndex() {
  const cells = new Map();
  return {
    add(id, geometry) {
      for (const key of spatialCellKeys(expandedGeometryBounds(geometry))) {
        const ids = cells.get(key) ?? new Set();
        ids.add(id);
        cells.set(key, ids);
      }
    },
    query(geometry, paddingMeters = 0) {
      const ids = new Set();
      for (const key of spatialCellKeys(expandedGeometryBounds(geometry, paddingMeters))) {
        for (const id of cells.get(key) ?? []) ids.add(id);
      }
      return [...ids].sort((left, right) => left - right);
    },
  };
}

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

function lineDistances(geometry) {
  const distances = [0];
  for (let index = 1; index < geometry.coordinates.length; index += 1) {
    distances.push(distances.at(-1) + geodesicDistanceMeters(
      geometry.coordinates[index - 1],
      geometry.coordinates[index],
    ));
  }
  return distances;
}

function projectPointToLine(point, geometry) {
  const cumulative = lineDistances(geometry);
  let best;
  for (let index = 1; index < geometry.coordinates.length; index += 1) {
    const start = geometry.coordinates[index - 1];
    const end = geometry.coordinates[index];
    const referenceLatitude = radians((point[1] + start[1] + end[1]) / 3);
    const metersPerDegreeLatitude = 111_195.080_233_532_9;
    const pointX = longitudeDelta(start[0], point[0]) * Math.cos(referenceLatitude) *
      metersPerDegreeLatitude;
    const pointY = (point[1] - start[1]) * metersPerDegreeLatitude;
    const endX = longitudeDelta(start[0], end[0]) * Math.cos(referenceLatitude) *
      metersPerDegreeLatitude;
    const endY = (end[1] - start[1]) * metersPerDegreeLatitude;
    const denominator = endX ** 2 + endY ** 2;
    const fraction = denominator === 0
      ? 0
      : Math.max(0, Math.min(1, (pointX * endX + pointY * endY) / denominator));
    const projected = [
      start[0] + longitudeDelta(start[0], end[0]) * fraction,
      start[1] + (end[1] - start[1]) * fraction,
    ];
    const distanceMeters = geodesicDistanceMeters(point, projected);
    const distanceAlongMeters = cumulative[index - 1] +
      (cumulative[index] - cumulative[index - 1]) * fraction;
    const candidate = { distanceMeters, distanceAlongMeters, projected };
    if (!best || distanceMeters < best.distanceMeters - 1e-9 ||
        (Math.abs(distanceMeters - best.distanceMeters) <= 1e-9 &&
          distanceAlongMeters < best.distanceAlongMeters)) best = candidate;
  }
  return best;
}

function interpolatePosition(start, end, fraction) {
  return [
    start[0] + longitudeDelta(start[0], end[0]) * fraction,
    start[1] + (end[1] - start[1]) * fraction,
  ];
}

function positionAtDistance(geometry, cumulative, distanceMeters) {
  if (distanceMeters <= 0) return [...geometry.coordinates[0]];
  if (distanceMeters >= cumulative.at(-1)) return [...geometry.coordinates.at(-1)];
  let index = 1;
  while (cumulative[index] < distanceMeters) index += 1;
  const span = cumulative[index] - cumulative[index - 1];
  return interpolatePosition(
    geometry.coordinates[index - 1],
    geometry.coordinates[index],
    span === 0 ? 0 : (distanceMeters - cumulative[index - 1]) / span,
  );
}

function sliceLine(geometry, startDistance, endDistance) {
  const cumulative = lineDistances(geometry);
  const low = Math.min(startDistance, endDistance);
  const high = Math.max(startDistance, endDistance);
  const coordinates = [positionAtDistance(geometry, cumulative, low)];
  for (let index = 1; index < geometry.coordinates.length - 1; index += 1) {
    if (cumulative[index] > low + 1e-6 && cumulative[index] < high - 1e-6) {
      coordinates.push([...geometry.coordinates[index]]);
    }
  }
  coordinates.push(positionAtDistance(geometry, cumulative, high));
  return {
    type: "LineString",
    coordinates: startDistance <= endDistance ? coordinates : coordinates.reverse(),
  };
}

function osmCandidate(candidate) {
  return candidate.sourceRefs.some(({ provider }) => providerClass(provider) === "osm");
}

function osmTopologyCandidate(candidate) {
  return osmCandidate(candidate) ||
    candidate.fieldProvenance?.fromNodeId?.topologyProvider === "osm" ||
    candidate.fieldProvenance?.toNodeId?.topologyProvider === "osm";
}

function reconciledTopologyCandidate(candidate) {
  return candidate.fieldProvenance?.geometry?.transformation === "split-and-snap-to-osm-edge";
}

function topologyEdgeKey(candidate) {
  return [candidate.fromNodeId, candidate.toNodeId].sort().join("\u0000");
}

function sourceKey(candidate) {
  return candidate.sourceRefs.map(({ provider, sourceId }) => `${provider}:${sourceId}`)
    .sort().join("|");
}

function reconciliationSettings(options = {}) {
  const settings = { ...DEFAULT_RECONCILIATION_OPTIONS, ...options };
  for (const field of ["snapToleranceMeters", "maximumGapMeters"]) {
    if (!Number.isFinite(settings[field]) || settings[field] < 0) {
      throw new TypeError(`${field} must be a non-negative finite number`);
    }
  }
  if (!Number.isFinite(settings.minimumCoverageRatio) ||
      settings.minimumCoverageRatio < 0 || settings.minimumCoverageRatio > 1) {
    throw new TypeError("minimumCoverageRatio must be between zero and one");
  }
  return settings;
}

function compatibleForReconciliation(agency, osm) {
  const agencyName = normalizeSegmentText(agency.name);
  const osmName = normalizeSegmentText(osm.name);
  return !agencyName || !osmName || agencyName === osmName;
}

function matchOsmEdge(agency, osm, settings) {
  if (!compatibleForReconciliation(agency, osm)) return undefined;
  const start = projectPointToLine(osm.geometry.coordinates[0], agency.geometry);
  const end = projectPointToLine(osm.geometry.coordinates.at(-1), agency.geometry);
  if (start.distanceMeters > settings.snapToleranceMeters ||
      end.distanceMeters > settings.snapToleranceMeters ||
      Math.abs(start.distanceAlongMeters - end.distanceAlongMeters) < 0.01) return undefined;
  const midpoint = [
    (osm.geometry.coordinates[0][0] + osm.geometry.coordinates.at(-1)[0]) / 2,
    (osm.geometry.coordinates[0][1] + osm.geometry.coordinates.at(-1)[1]) / 2,
  ];
  if (pointToLineDistanceMeters(midpoint, agency.geometry) > settings.snapToleranceMeters) {
    return undefined;
  }
  return {
    osm,
    startDistance: start.distanceAlongMeters,
    endDistance: end.distanceAlongMeters,
    low: Math.min(start.distanceAlongMeters, end.distanceAlongMeters),
    high: Math.max(start.distanceAlongMeters, end.distanceAlongMeters),
  };
}

function continuousCoverage(matches, totalLength, settings) {
  if (matches.length === 0 || totalLength === 0) return false;
  const intervals = matches.map(({ low, high }) => [low, high])
    .sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  let covered = 0;
  let end = intervals[0][0];
  if (end > settings.maximumGapMeters) return false;
  for (const [low, high] of intervals) {
    if (low > end + settings.maximumGapMeters) return false;
    if (high > end) {
      covered += high - Math.max(low, end);
      end = high;
    }
  }
  return totalLength - end <= settings.maximumGapMeters &&
    covered / totalLength >= settings.minimumCoverageRatio;
}

function duplicateIntervals(matches) {
  const sorted = [...matches].sort((left, right) =>
    left.low - right.low || left.high - right.high || sourceKey(left.osm).localeCompare(sourceKey(right.osm)));
  return sorted.some((match, index) => index > 0 &&
    Math.abs(match.low - sorted[index - 1].low) < 0.5 &&
    Math.abs(match.high - sorted[index - 1].high) < 0.5);
}

function reconciledAgencyCandidate(agency, match) {
  const forward = match.startDistance <= match.endDistance;
  const fromCoordinate = match.osm.geometry.coordinates[0];
  const toCoordinate = match.osm.geometry.coordinates.at(-1);
  const sliced = sliceLine(agency.geometry, match.startDistance, match.endDistance);
  sliced.coordinates[0] = [...fromCoordinate];
  sliced.coordinates[sliced.coordinates.length - 1] = [...toCoordinate];
  return {
    ...agency,
    id: undefined,
    fromNodeId: match.osm.fromNodeId,
    toNodeId: match.osm.toNodeId,
    geometry: sliced,
    fieldProvenance: {
      ...agency.fieldProvenance,
      geometry: {
        ...(agency.fieldProvenance?.geometry ?? {}),
        transformation: "split-and-snap-to-osm-edge",
        osmSourceIds: match.osm.sourceRefs.map(({ sourceId }) => sourceId).sort(),
        sourceDirection: forward ? "forward" : "reverse",
      },
      fromNodeId: { topologyProvider: "osm", value: match.osm.fromNodeId },
      toNodeId: { topologyProvider: "osm", value: match.osm.toNodeId },
    },
  };
}

/**
 * Split a fully covered agency line at nearby OSM edge boundaries and reuse
 * the OSM node IDs. Partial or ambiguous matches are retained unchanged and
 * reported; the pipeline never silently drops unmatched official geometry.
 */
export function reconcileAgencyGeometryWithOsmTopology(inputCandidates, options = {}) {
  const settings = reconciliationSettings(options);
  const candidates = normalizeSegmentCandidates(inputCandidates);
  const osm = candidates.filter(osmCandidate);
  const osmIndex = createSpatialCandidateIndex();
  osm.forEach((candidate, index) => osmIndex.add(index, candidate.geometry));
  const output = [...osm];
  const issues = [];
  let reconciledAgencySegments = 0;
  let emittedAgencyEdges = 0;

  for (const agency of candidates.filter((candidate) => !osmCandidate(candidate))) {
    const matches = osmIndex.query(agency.geometry, settings.snapToleranceMeters)
      .flatMap((index) => {
      const candidate = osm[index];
      const match = matchOsmEdge(agency, candidate, settings);
      return match ? [match] : [];
    });
    const totalLength = geodesicLineLengthMeters(agency.geometry);
    if (duplicateIntervals(matches)) {
      issues.push({
        type: "ambiguous-topology-reconciliation",
        sourceIds: agency.sourceRefs.map(({ sourceId }) => sourceId).sort(),
        resolution: "retained-unsplit-official-geometry",
        explanation: "duplicate nearby OSM intervals made a deterministic split unsafe",
      });
      output.push(agency);
      continue;
    }
    if (!continuousCoverage(matches, totalLength, settings)) {
      output.push(agency);
      continue;
    }
    matches.sort((left, right) => left.low - right.low ||
      sourceKey(left.osm).localeCompare(sourceKey(right.osm)));
    output.push(...matches.map((match) => reconciledAgencyCandidate(agency, match)));
    reconciledAgencySegments += 1;
    emittedAgencyEdges += matches.length;
  }

  return {
    candidates: output,
    issues: issues.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
    stats: { reconciledAgencySegments, emittedAgencyEdges },
  };
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
  if (osmTopologyCandidate(left) && osmTopologyCandidate(right)) {
    if (topologyEdgeKey(left) !== topologyEdgeKey(right)) return false;
    // Reconciliation has already bounded and reviewed geometry deviation.
    // The shared canonical OSM edge is stronger duplicate evidence than the
    // tighter generic merge tolerance used for unsnapped source lines.
    if (reconciledTopologyCandidate(left) || reconciledTopologyCandidate(right)) {
      return descriptiveEvidenceCompatible(left, right);
    }
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
  const index = createSpatialCandidateIndex();
  const toleranceMeters = options.toleranceMeters ?? DEFAULT_MERGE_TOLERANCE_METERS;
  for (const candidate of [...candidates].sort((left, right) =>
    candidateSortKey(left).localeCompare(candidateSortKey(right)))) {
    const matchingIndex = index.query(candidate.geometry, toleranceMeters).find((groupIndex) =>
      groups[groupIndex].every((member) => segmentsCanMerge(member, candidate, options)));
    const group = matchingIndex === undefined ? undefined : groups[matchingIndex];
    if (group) {
      group.push(candidate);
      index.add(matchingIndex, candidate.geometry);
    } else {
      const groupIndex = groups.length;
      groups.push([candidate]);
      index.add(groupIndex, candidate.geometry);
    }
  }
  return groups;
}

function orientedDisplayGeometry(candidate, requestedStart) {
  if (!candidate.displayGeometry) return undefined;
  return orientLineString(candidate.displayGeometry, requestedStart);
}

function alignGeometryEndpoints(geometry, topologyGeometry) {
  const coordinates = geometry.coordinates.map((position) => [...position]);
  coordinates[0] = [...topologyGeometry.coordinates[0]];
  coordinates[coordinates.length - 1] = [...topologyGeometry.coordinates.at(-1)];
  return { ...geometry, coordinates };
}

function selectProvenanceSource(entries, candidate) {
  const identities = new Set(candidate.sourceRefs.map(({ provider, sourceId }) =>
    `${provider.toLowerCase()}\u0000${sourceId.toLowerCase()}`));
  return entries.map((entry) => ({
    ...entry,
    selected: identities.has(`${entry.provider.toLowerCase()}\u0000${entry.sourceId.toLowerCase()}`),
  }));
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
  const geometry = alignGeometryEndpoints(
    orientLineString(geometryCandidate.geometry, requestedStart),
    topologyCandidate.geometry,
  );
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
  provenance.geometry = selectProvenanceSource(provenance.geometry ?? [], geometryCandidate);
  provenance.fromNodeId = selectProvenanceSource(
    provenance.fromNodeId ?? [],
    topologyCandidate,
  );
  provenance.toNodeId = selectProvenanceSource(
    provenance.toNodeId ?? [],
    topologyCandidate,
  );
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
