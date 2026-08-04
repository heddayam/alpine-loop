import type { Coordinate, NormalizedTopology } from "../types";
import { attachOfficialEvidence } from "./join";
import type { OfficialAccessJoin, OfficialAccessJoinFeature } from "./types";

const EARTH_RADIUS_M = 6_371_008.8;
const RADIANS_PER_DEGREE = Math.PI / 180;
const DEFAULT_TOLERANCE_M = 28;
const DEFAULT_AMBIGUITY_M = 0.5;
const DEFAULT_MAX_SEGMENT_ANGLE_DEGREES = 45;
const INTERSECTION_EPSILON_M = 0.01;

type Point = readonly [x: number, y: number];
type Segment = readonly [start: Point, end: Point];
type IndexedSegment = { wayIndex: number; segmentIndex: number; segment: Segment };
type MatchCandidate = { featureIndex: number; wayIndex: number; distanceM: number };

export type OfficialAccessSpatialMatchOptions = {
  /** Maximum separation between aligned authority and OSM segments. */
  toleranceM?: number;
  /** Nearest-feature distances this close are treated as an unresolved tie. */
  ambiguityM?: number;
  /** Spatial grid cell width. Defaults to twice the match tolerance. */
  gridCellSizeM?: number;
  /** Rejects crossings and other segments whose undirected headings differ more than this. */
  maxSegmentAngleDegrees?: number;
};

export type OfficialAccessSpatialMatchResult = {
  joins: OfficialAccessJoin[];
  ambiguousOsmWayCount: number;
  unmatchedAuthorityFeatureCount: number;
};

function positiveOption(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved <= 0) throw new Error(`${name} must be a positive finite number`);
  return resolved;
}

function nonNegativeOption(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved < 0) throw new Error(`${name} must be a non-negative finite number`);
  return resolved;
}

function coordinateLines(feature: OfficialAccessJoinFeature): Coordinate[][] {
  const lines = feature.geometry.type === "LineString"
    ? [feature.geometry.coordinates as number[][]]
    : feature.geometry.coordinates as number[][][];
  return lines.map((line, lineIndex) => {
    if (line.length < 2) throw new Error(`Authority feature ${feature.authorityFeatureId} line ${lineIndex} has fewer than two coordinates`);
    return line.map((coordinate, coordinateIndex) => {
      if (coordinate.length < 2 || !Number.isFinite(coordinate[0]) || !Number.isFinite(coordinate[1])) {
        throw new Error(`Authority feature ${feature.authorityFeatureId} has an invalid coordinate at ${lineIndex}:${coordinateIndex}`);
      }
      return [coordinate[0], coordinate[1]] as const;
    });
  });
}

function referenceLatitude(
  topology: NormalizedTopology,
  featureLines: readonly Coordinate[][][],
): number {
  let minimum = Infinity;
  let maximum = -Infinity;
  const consider = ([lon, lat]: Coordinate) => {
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) throw new Error("Spatial matching received a non-finite coordinate");
    minimum = Math.min(minimum, lat);
    maximum = Math.max(maximum, lat);
  };
  for (const way of topology.ways) for (const coordinate of way.coordinates) consider(coordinate);
  for (const lines of featureLines) for (const line of lines) for (const coordinate of line) consider(coordinate);
  return Number.isFinite(minimum) ? (minimum + maximum) / 2 : 0;
}

function projector(referenceLatitudeDegrees: number): (coordinate: Coordinate) => Point {
  const longitudeScale = EARTH_RADIUS_M * RADIANS_PER_DEGREE * Math.cos(referenceLatitudeDegrees * RADIANS_PER_DEGREE);
  const latitudeScale = EARTH_RADIUS_M * RADIANS_PER_DEGREE;
  return ([lon, lat]) => [lon * longitudeScale, lat * latitudeScale];
}

function segments(coordinates: readonly Coordinate[], project: (coordinate: Coordinate) => Point): Segment[] {
  const result: Segment[] = [];
  for (let index = 1; index < coordinates.length; index += 1) {
    const segment = [project(coordinates[index - 1]), project(coordinates[index])] as const;
    if (segment[0][0] !== segment[1][0] || segment[0][1] !== segment[1][1]) result.push(segment);
  }
  return result;
}

function gridKey(x: number, y: number): string {
  return `${x}:${y}`;
}

function cellRange(segment: Segment, cellSizeM: number, paddingM = 0): [number, number, number, number] {
  const minimumX = Math.min(segment[0][0], segment[1][0]) - paddingM;
  const maximumX = Math.max(segment[0][0], segment[1][0]) + paddingM;
  const minimumY = Math.min(segment[0][1], segment[1][1]) - paddingM;
  const maximumY = Math.max(segment[0][1], segment[1][1]) + paddingM;
  return [
    Math.floor(minimumX / cellSizeM),
    Math.floor(maximumX / cellSizeM),
    Math.floor(minimumY / cellSizeM),
    Math.floor(maximumY / cellSizeM),
  ];
}

function directionDifferenceDegrees(first: Segment, second: Segment): number {
  const firstX = first[1][0] - first[0][0];
  const firstY = first[1][1] - first[0][1];
  const secondX = second[1][0] - second[0][0];
  const secondY = second[1][1] - second[0][1];
  const denominator = Math.hypot(firstX, firstY) * Math.hypot(secondX, secondY);
  const cosine = Math.min(1, Math.max(0, Math.abs((firstX * secondX + firstY * secondY) / denominator)));
  return Math.acos(cosine) / RADIANS_PER_DEGREE;
}

function pointToSegmentDistance(point: Point, segment: Segment): number {
  const deltaX = segment[1][0] - segment[0][0];
  const deltaY = segment[1][1] - segment[0][1];
  const lengthSquared = deltaX * deltaX + deltaY * deltaY;
  const projection = ((point[0] - segment[0][0]) * deltaX + (point[1] - segment[0][1]) * deltaY) / lengthSquared;
  const position = Math.min(1, Math.max(0, projection));
  return Math.hypot(point[0] - (segment[0][0] + position * deltaX), point[1] - (segment[0][1] + position * deltaY));
}

function orientation(first: Point, second: Point, third: Point): number {
  return (second[0] - first[0]) * (third[1] - first[1]) - (second[1] - first[1]) * (third[0] - first[0]);
}

function pointOnSegment(point: Point, segment: Segment): boolean {
  return point[0] >= Math.min(segment[0][0], segment[1][0])
    && point[0] <= Math.max(segment[0][0], segment[1][0])
    && point[1] >= Math.min(segment[0][1], segment[1][1])
    && point[1] <= Math.max(segment[0][1], segment[1][1]);
}

function segmentsIntersect(first: Segment, second: Segment): boolean {
  const a = orientation(first[0], first[1], second[0]);
  const b = orientation(first[0], first[1], second[1]);
  const c = orientation(second[0], second[1], first[0]);
  const d = orientation(second[0], second[1], first[1]);
  if (((a < 0 && b > 0) || (a > 0 && b < 0)) && ((c < 0 && d > 0) || (c > 0 && d < 0))) return true;
  return (a === 0 && pointOnSegment(second[0], first))
    || (b === 0 && pointOnSegment(second[1], first))
    || (c === 0 && pointOnSegment(first[0], second))
    || (d === 0 && pointOnSegment(first[1], second));
}

function segmentDistance(first: Segment, second: Segment): number {
  if (segmentsIntersect(first, second)) return 0;
  return Math.min(
    pointToSegmentDistance(first[0], second),
    pointToSegmentDistance(first[1], second),
    pointToSegmentDistance(second[0], first),
    pointToSegmentDistance(second[1], first),
  );
}

function segmentLength(segment: Segment): number {
  return Math.hypot(segment[1][0] - segment[0][0], segment[1][1] - segment[0][1]);
}

function alignedOverlapRange(first: Segment, second: Segment): readonly [startM: number, endM: number] {
  const firstLength = segmentLength(first);
  const directionX = (first[1][0] - first[0][0]) / firstLength;
  const directionY = (first[1][1] - first[0][1]) / firstLength;
  const projection = (point: Point) => (point[0] - first[0][0]) * directionX + (point[1] - first[0][1]) * directionY;
  const secondStart = projection(second[0]);
  const secondEnd = projection(second[1]);
  return [Math.max(0, Math.min(secondStart, secondEnd)), Math.min(firstLength, Math.max(secondStart, secondEnd))];
}

function hasMeaningfulAlignment(first: Segment, second: Segment, toleranceM: number): boolean {
  const [overlapStartM, overlapEndM] = alignedOverlapRange(first, second);
  const requiredOverlapM = Math.min(5, Math.min(segmentLength(first), segmentLength(second)) * 0.25);
  if (overlapEndM - overlapStartM < requiredOverlapM) return false;
  const firstLength = segmentLength(first);
  const directionX = (first[1][0] - first[0][0]) / firstLength;
  const directionY = (first[1][1] - first[0][1]) / firstLength;
  const pointAt = (distanceM: number): Point => [
    first[0][0] + directionX * distanceM,
    first[0][1] + directionY * distanceM,
  ];
  return pointToSegmentDistance(pointAt(overlapStartM), second) <= toleranceM
    && pointToSegmentDistance(pointAt(overlapEndM), second) <= toleranceM;
}

function featureKey(feature: OfficialAccessJoinFeature): string {
  return `${feature.sourceId}\u0000${feature.authorityFeatureId}`;
}

function joinOrder(first: OfficialAccessJoin, second: OfficialAccessJoin): number {
  return first.sourceId.localeCompare(second.sourceId)
    || first.authorityFeatureId.localeCompare(second.authorityFeatureId)
    || first.targetExternalId.localeCompare(second.targetExternalId);
}

/**
 * Matches official trail geometry to nearby, directionally aligned OSM ways.
 * Candidate discovery is segment-grid based; competing authority features are
 * resolved independently for each authority source and exact/near ties are not
 * applied.
 */
export function matchOfficialAccessToOsmWithReport(
  topology: NormalizedTopology,
  officialFeatures: readonly OfficialAccessJoinFeature[],
  options: OfficialAccessSpatialMatchOptions = {},
): OfficialAccessSpatialMatchResult {
  const toleranceM = positiveOption(options.toleranceM, DEFAULT_TOLERANCE_M, "toleranceM");
  const ambiguityM = nonNegativeOption(options.ambiguityM, DEFAULT_AMBIGUITY_M, "ambiguityM");
  const cellSizeM = positiveOption(options.gridCellSizeM, toleranceM * 2, "gridCellSizeM");
  const maximumAngle = positiveOption(
    options.maxSegmentAngleDegrees,
    DEFAULT_MAX_SEGMENT_ANGLE_DEGREES,
    "maxSegmentAngleDegrees",
  );
  if (maximumAngle > 90) throw new Error("maxSegmentAngleDegrees must not exceed 90");

  const orderedFeatures = [...officialFeatures].sort((first, second) => featureKey(first).localeCompare(featureKey(second)));
  const keys = orderedFeatures.map(featureKey);
  if (new Set(keys).size !== keys.length) throw new Error("Official access features must have unique source and authority feature IDs");
  const featureLines = orderedFeatures.map(coordinateLines);
  if (topology.ways.length === 0 || orderedFeatures.length === 0) {
    return { joins: [], ambiguousOsmWayCount: 0, unmatchedAuthorityFeatureCount: orderedFeatures.length };
  }

  const orderedWays = [...topology.ways].sort((first, second) => first.externalId.localeCompare(second.externalId) || first.id.localeCompare(second.id));
  const project = projector(referenceLatitude(topology, featureLines));
  const grid = new Map<string, IndexedSegment[]>();
  orderedWays.forEach((way, wayIndex) => {
    if (!way.externalId.trim()) throw new Error(`Topology way ${way.id} has no external ID`);
    if (way.coordinates.length < 2) throw new Error(`Topology way ${way.externalId} has fewer than two coordinates`);
    for (const [segmentIndex, segment] of segments(way.coordinates, project).entries()) {
      const [minimumX, maximumX, minimumY, maximumY] = cellRange(segment, cellSizeM);
      for (let x = minimumX; x <= maximumX; x += 1) {
        for (let y = minimumY; y <= maximumY; y += 1) {
          const key = gridKey(x, y);
          const bucket = grid.get(key) ?? [];
          bucket.push({ wayIndex, segmentIndex, segment });
          grid.set(key, bucket);
        }
      }
    }
  });

  const candidates: MatchCandidate[] = [];
  orderedFeatures.forEach((feature, featureIndex) => {
    const distances = new Map<number, number>();
    for (const line of featureLines[featureIndex]) {
      for (const authoritySegment of segments(line, project)) {
        const comparedSegments = new Set<string>();
        const [minimumX, maximumX, minimumY, maximumY] = cellRange(authoritySegment, cellSizeM, toleranceM);
        for (let x = minimumX; x <= maximumX; x += 1) {
          for (let y = minimumY; y <= maximumY; y += 1) {
            const bucket = grid.get(gridKey(x, y)) ?? [];
            bucket.forEach((indexedSegment) => {
              const comparisonKey = `${indexedSegment.wayIndex}:${indexedSegment.segmentIndex}`;
              if (comparedSegments.has(comparisonKey)) return;
              comparedSegments.add(comparisonKey);
              if (directionDifferenceDegrees(authoritySegment, indexedSegment.segment) > maximumAngle) return;
              if (!hasMeaningfulAlignment(authoritySegment, indexedSegment.segment, toleranceM)) return;
              const distanceM = segmentDistance(authoritySegment, indexedSegment.segment);
              if (distanceM > toleranceM) return;
              distances.set(indexedSegment.wayIndex, Math.min(distances.get(indexedSegment.wayIndex) ?? Infinity, distanceM));
            });
          }
        }
      }
    }
    for (const [wayIndex, distanceM] of distances) candidates.push({ featureIndex, wayIndex, distanceM });
  });

  const candidatesBySourceAndWay = new Map<string, MatchCandidate[]>();
  for (const candidate of candidates) {
    const sourceId = orderedFeatures[candidate.featureIndex].sourceId;
    const key = `${sourceId}\u0000${candidate.wayIndex}`;
    const values = candidatesBySourceAndWay.get(key) ?? [];
    values.push(candidate);
    candidatesBySourceAndWay.set(key, values);
  }

  const matchedFeatureIndexes = new Set<number>();
  const joins: OfficialAccessJoin[] = [];
  let ambiguousOsmWayCount = 0;
  for (const values of candidatesBySourceAndWay.values()) {
    values.sort((first, second) => first.distanceM - second.distanceM
      || featureKey(orderedFeatures[first.featureIndex]).localeCompare(featureKey(orderedFeatures[second.featureIndex])));
    const nearest = values[0];
    const runnerUp = values[1];
    if (runnerUp && runnerUp.distanceM - nearest.distanceM <= ambiguityM) {
      ambiguousOsmWayCount += 1;
      continue;
    }
    const feature = orderedFeatures[nearest.featureIndex];
    const way = orderedWays[nearest.wayIndex];
    matchedFeatureIndexes.add(nearest.featureIndex);
    joins.push(attachOfficialEvidence(feature, way.externalId, {
      matchMethod: nearest.distanceM <= INTERSECTION_EPSILON_M ? "spatial-intersection" : "nearest-within-tolerance",
      distanceM: nearest.distanceM,
    }));
  }

  joins.sort(joinOrder);
  return {
    joins,
    ambiguousOsmWayCount,
    unmatchedAuthorityFeatureCount: orderedFeatures.length - matchedFeatureIndexes.size,
  };
}

export function matchOfficialAccessToOsm(
  topology: NormalizedTopology,
  officialFeatures: readonly OfficialAccessJoinFeature[],
  options: OfficialAccessSpatialMatchOptions = {},
): OfficialAccessJoin[] {
  return matchOfficialAccessToOsmWithReport(topology, officialFeatures, options).joins;
}
