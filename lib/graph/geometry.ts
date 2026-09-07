import type { MultiPolygon, Polygon } from "geojson";
import type { GraphEdge } from "./types";

export type BoundingBox = readonly [west: number, south: number, east: number, north: number];

export function coordinateIsInsideBbox(
  coordinate: readonly [number, number],
  [west, south, east, north]: BoundingBox,
): boolean {
  const [lon, lat] = coordinate;
  return Number.isFinite(lon) && Number.isFinite(lat) && lon >= west && lon <= east && lat >= south && lat <= north;
}

export function edgeIsInsideBbox(edge: GraphEdge, bbox: BoundingBox): boolean {
  return edge.coordinates.length >= 2 && edge.coordinates.every((coordinate) => coordinateIsInsideBbox(coordinate, bbox));
}

export type AreaGeometry = Polygon | MultiPolygon;
type Position = readonly [number, number];
const GEOMETRY_EPSILON = 1e-10;

function cross(left: Position, right: Position): number {
  return left[0] * right[1] - left[1] * right[0];
}

function subtract(left: Position, right: Position): Position {
  return [left[0] - right[0], left[1] - right[1]];
}

function coordinateIsOnSegment(point: Position, start: Position, end: Position): boolean {
  const segment = subtract(end, start);
  const offset = subtract(point, start);
  const squaredLength = segment[0] ** 2 + segment[1] ** 2;
  if (squaredLength <= GEOMETRY_EPSILON) {
    return Math.abs(offset[0]) <= GEOMETRY_EPSILON && Math.abs(offset[1]) <= GEOMETRY_EPSILON;
  }
  if (Math.abs(cross(segment, offset)) > GEOMETRY_EPSILON) return false;
  const dot = offset[0] * segment[0] + offset[1] * segment[1];
  if (dot < -GEOMETRY_EPSILON) return false;
  return dot <= squaredLength + GEOMETRY_EPSILON;
}

function pointRingRelation(point: Position, ring: ReadonlyArray<Position>): "outside" | "inside" | "boundary" {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
    const start = ring[previous];
    const end = ring[index];
    if (coordinateIsOnSegment(point, start, end)) return "boundary";
    if (
      (start[1] > point[1]) !== (end[1] > point[1]) &&
      point[0] < ((end[0] - start[0]) * (point[1] - start[1])) / (end[1] - start[1]) + start[0]
    ) {
      inside = !inside;
    }
  }
  return inside ? "inside" : "outside";
}

function pointIsInsidePolygon(point: Position, rings: ReadonlyArray<ReadonlyArray<Position>>): boolean {
  const outer = rings[0] ? pointRingRelation(point, rings[0]) : "outside";
  if (outer === "outside") return false;
  if (outer === "boundary") return true;
  for (const hole of rings.slice(1)) {
    const relation = pointRingRelation(point, hole);
    if (relation === "boundary") return true;
    if (relation === "inside") return false;
  }
  return true;
}

export function coordinateIsInsideArea(coordinate: Position, geometry: AreaGeometry): boolean {
  if (!Number.isFinite(coordinate[0]) || !Number.isFinite(coordinate[1])) return false;
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  return polygons.some((rings) => pointIsInsidePolygon(coordinate, rings as unknown as Position[][]));
}

export function areaBounds(geometry: AreaGeometry): BoundingBox {
  let west = Number.POSITIVE_INFINITY;
  let south = Number.POSITIVE_INFINITY;
  let east = Number.NEGATIVE_INFINITY;
  let north = Number.NEGATIVE_INFINITY;
  for (const ring of boundaryRings(geometry)) {
    for (const [lon, lat] of ring) {
      west = Math.min(west, lon);
      south = Math.min(south, lat);
      east = Math.max(east, lon);
      north = Math.max(north, lat);
    }
  }
  if (!Number.isFinite(west)) throw new Error("Area geometry has no coordinates");
  return [west, south, east, north];
}

function boundaryRings(geometry: AreaGeometry): ReadonlyArray<ReadonlyArray<Position>> {
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  return polygons.flatMap((rings) => rings as unknown as Position[][]);
}

function segmentBoundaryParameters(start: Position, end: Position, ring: ReadonlyArray<Position>): number[] {
  const parameters: number[] = [];
  const direction = subtract(end, start);
  const directionLength = direction[0] ** 2 + direction[1] ** 2;
  for (let index = 1; index < ring.length; index += 1) {
    const boundaryStart = ring[index - 1];
    const boundaryEnd = ring[index];
    const boundaryDirection = subtract(boundaryEnd, boundaryStart);
    const denominator = cross(direction, boundaryDirection);
    const offset = subtract(boundaryStart, start);
    if (Math.abs(denominator) <= GEOMETRY_EPSILON) {
      if (Math.abs(cross(offset, direction)) > GEOMETRY_EPSILON || directionLength <= GEOMETRY_EPSILON) continue;
      for (const point of [boundaryStart, boundaryEnd]) {
        const pointOffset = subtract(point, start);
        const value = (pointOffset[0] * direction[0] + pointOffset[1] * direction[1]) / directionLength;
        if (value > 0 && value < 1) parameters.push(value);
      }
      continue;
    }
    const alongRoute = cross(offset, boundaryDirection) / denominator;
    const alongBoundary = cross(offset, direction) / denominator;
    if (
      alongRoute >= -GEOMETRY_EPSILON && alongRoute <= 1 + GEOMETRY_EPSILON &&
      alongBoundary >= -GEOMETRY_EPSILON && alongBoundary <= 1 + GEOMETRY_EPSILON
    ) {
      parameters.push(Math.min(1, Math.max(0, alongRoute)));
    }
  }
  return parameters;
}

export function segmentIsInsideArea(start: Position, end: Position, geometry: AreaGeometry): boolean {
  if (!coordinateIsInsideArea(start, geometry) || !coordinateIsInsideArea(end, geometry)) return false;
  const parameters = [
    0,
    1,
    ...boundaryRings(geometry).flatMap((ring) => segmentBoundaryParameters(start, end, ring)),
  ].sort((left, right) => left - right);
  for (let index = 1; index < parameters.length; index += 1) {
    const from = parameters[index - 1];
    const to = parameters[index];
    if (to - from <= GEOMETRY_EPSILON) continue;
    const middle = (from + to) / 2;
    const point: Position = [
      start[0] + (end[0] - start[0]) * middle,
      start[1] + (end[1] - start[1]) * middle,
    ];
    if (!coordinateIsInsideArea(point, geometry)) return false;
  }
  return true;
}

export function lineIsInsideArea(coordinates: ReadonlyArray<Position>, geometry: AreaGeometry): boolean {
  if (coordinates.length < 2) return false;
  for (let index = 1; index < coordinates.length; index += 1) {
    if (!segmentIsInsideArea(coordinates[index - 1], coordinates[index], geometry)) return false;
  }
  return true;
}

const EARTH_RADIUS_METERS = 6_371_008.8;

export function distanceMetersBetween(
  [fromLon, fromLat]: readonly [number, number],
  [toLon, toLat]: readonly [number, number],
): number {
  const toRadians = Math.PI / 180;
  const phi1 = fromLat * toRadians;
  const phi2 = toLat * toRadians;
  const deltaPhi = (toLat - fromLat) * toRadians;
  const deltaLambda = (toLon - fromLon) * toRadians;
  const sinPhi = Math.sin(deltaPhi / 2);
  const sinLambda = Math.sin(deltaLambda / 2);
  const a = sinPhi * sinPhi + Math.cos(phi1) * Math.cos(phi2) * sinLambda * sinLambda;
  return 2 * EARTH_RADIUS_METERS * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function distanceMetersToSegment(point: Position, start: Position, end: Position): number {
  const latitudeRadians = point[1] * Math.PI / 180;
  const metersPerLongitudeDegree = Math.PI * EARTH_RADIUS_METERS / 180 * Math.cos(latitudeRadians);
  const metersPerLatitudeDegree = Math.PI * EARTH_RADIUS_METERS / 180;
  const startX = (start[0] - point[0]) * metersPerLongitudeDegree;
  const startY = (start[1] - point[1]) * metersPerLatitudeDegree;
  const endX = (end[0] - point[0]) * metersPerLongitudeDegree;
  const endY = (end[1] - point[1]) * metersPerLatitudeDegree;
  const segmentX = endX - startX;
  const segmentY = endY - startY;
  const squaredLength = segmentX ** 2 + segmentY ** 2;
  if (squaredLength === 0) return Math.hypot(startX, startY);
  const parameter = Math.max(0, Math.min(1, -(startX * segmentX + startY * segmentY) / squaredLength));
  return Math.hypot(startX + parameter * segmentX, startY + parameter * segmentY);
}

/** Returns zero inside an area, otherwise the nearest boundary distance. */
export function distanceMetersToArea(coordinate: Position, geometry: AreaGeometry): number {
  if (coordinateIsInsideArea(coordinate, geometry)) return 0;
  let nearest = Number.POSITIVE_INFINITY;
  for (const ring of boundaryRings(geometry)) {
    for (let index = 1; index < ring.length; index += 1) {
      nearest = Math.min(nearest, distanceMetersToSegment(coordinate, ring[index - 1], ring[index]));
    }
  }
  return nearest;
}

export function lineLengthMeters(coordinates: ReadonlyArray<readonly [number, number]>): number {
  let length = 0;
  for (let index = 1; index < coordinates.length; index += 1) {
    length += distanceMetersBetween(coordinates[index - 1], coordinates[index]);
  }
  return length;
}
