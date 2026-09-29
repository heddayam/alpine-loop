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

function edgeCrossesRay(point: Position, start: Position, end: Position): boolean {
  return (start[1] > point[1]) !== (end[1] > point[1]) &&
    point[0] < ((end[0] - start[0]) * (point[1] - start[1])) / (end[1] - start[1]) + start[0];
}

function pointRingRelation(point: Position, ring: ReadonlyArray<Position>): "outside" | "inside" | "boundary" {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
    const start = ring[previous];
    const end = ring[index];
    if (coordinateIsOnSegment(point, start, end)) return "boundary";
    if (edgeCrossesRay(point, start, end)) {
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
    appendBoundaryParameters(start, direction, directionLength, ring[index - 1], ring[index], parameters);
  }
  return parameters;
}

function appendBoundaryParameters(
  start: Position, direction: Position, directionLength: number,
  boundaryStart: Position, boundaryEnd: Position, parameters: number[],
): void {
  const boundaryDirection = subtract(boundaryEnd, boundaryStart);
  const denominator = cross(direction, boundaryDirection);
  const offset = subtract(boundaryStart, start);
  if (Math.abs(denominator) <= GEOMETRY_EPSILON) {
    if (Math.abs(cross(offset, direction)) > GEOMETRY_EPSILON || directionLength <= GEOMETRY_EPSILON) return;
    for (const point of [boundaryStart, boundaryEnd]) {
      const pointOffset = subtract(point, start);
      const value = (pointOffset[0] * direction[0] + pointOffset[1] * direction[1]) / directionLength;
      if (value > 0 && value < 1) parameters.push(value);
    }
    return;
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

function* segmentInteriorPoints(start: Position, end: Position, geometry: AreaGeometry): Generator<Position> {
  const parameters = [
    0,
    1,
    ...boundaryRings(geometry).flatMap((ring) => segmentBoundaryParameters(start, end, ring)),
  ];
  yield* interiorPoints(start, end, parameters);
}

function* interiorPoints(start: Position, end: Position, parameters: number[]): Generator<Position> {
  parameters.sort((left, right) => left - right);
  for (let index = 1; index < parameters.length; index += 1) {
    const from = parameters[index - 1];
    const to = parameters[index];
    if (to - from <= GEOMETRY_EPSILON) continue;
    const middle = (from + to) / 2;
    const point: Position = [
      start[0] + (end[0] - start[0]) * middle,
      start[1] + (end[1] - start[1]) * middle,
    ];
    yield point;
  }
}

export function segmentIsInsideArea(start: Position, end: Position, geometry: AreaGeometry): boolean {
  if (!coordinateIsInsideArea(start, geometry) || !coordinateIsInsideArea(end, geometry)) return false;
  for (const point of segmentInteriorPoints(start, end, geometry)) {
    if (!coordinateIsInsideArea(point, geometry)) return false;
  }
  return true;
}

/** Positive-length contact with installed coverage, including a segment whose endpoints are outside. */
export function segmentIntersectsArea(start: Position, end: Position, geometry: AreaGeometry): boolean {
  if (Math.abs(start[0] - end[0]) <= GEOMETRY_EPSILON && Math.abs(start[1] - end[1]) <= GEOMETRY_EPSILON) return false;
  for (const point of segmentInteriorPoints(start, end, geometry)) {
    if (coordinateIsInsideArea(point, geometry)) return true;
  }
  return false;
}

export function lineIsInsideArea(coordinates: ReadonlyArray<Position>, geometry: AreaGeometry): boolean {
  if (coordinates.length < 2) return false;
  for (let index = 1; index < coordinates.length; index += 1) {
    if (!segmentIsInsideArea(coordinates[index - 1], coordinates[index], geometry)) return false;
  }
  return true;
}

type BoundaryEdge = {
  start: Position;
  end: Position;
  south: number;
  north: number;
  explicit: boolean;
};
type BoundaryIndex = {
  south: number;
  north: number;
  from: number;
  to: number;
  children?: readonly [BoundaryIndex, BoundaryIndex];
};

function indexRing(ring: ReadonlyArray<Position>) {
  // Copy coordinates: preparation is a snapshot, with no global/query-result cache.
  const points = ring.map(([x, y]): Position => [x, y]);
  const edges: BoundaryEdge[] = points.map((end, index) => {
    const start = points[(index + points.length - 1) % points.length];
    const dx = end[0] - start[0], dy = end[1] - start[1];
    const squaredLength = dx * dx + dy * dy;
    // The exact predicates use cross/dot tolerances, not a coordinate tolerance.
    // Include both their perpendicular/endpoint allowance and parameter extension.
    const padding = GEOMETRY_EPSILON + Math.max(
      squaredLength <= GEOMETRY_EPSILON ? GEOMETRY_EPSILON : 2 * GEOMETRY_EPSILON / Math.sqrt(squaredLength),
      GEOMETRY_EPSILON * Math.abs(dy),
    );
    return { start, end, south: Math.min(start[1], end[1]) - padding,
      north: Math.max(start[1], end[1]) + padding, explicit: index > 0 };
  }).sort((a, b) => (a.south + a.north) - (b.south + b.north));
  const build = (from: number, to: number): BoundaryIndex => {
    if (to - from > 8) {
      const middle = (from + to) >>> 1;
      const left = build(from, middle), right = build(middle, to);
      return { from, to, south: Math.min(left.south, right.south),
        north: Math.max(left.north, right.north), children: [left, right] };
    }
    let south = Infinity, north = -Infinity;
    for (let i = from; i < to; i++) {
      south = Math.min(south, edges[i].south);
      north = Math.max(north, edges[i].north);
    }
    return { from, to, south, north };
  };
  const root = build(0, edges.length);
  return (south: number, north: number, visit: (edge: BoundaryEdge) => boolean): boolean => {
    const query = (node: BoundaryIndex): boolean => {
      if (node.south > north || node.north < south) return false;
      if (node.children) return query(node.children[0]) || query(node.children[1]);
      for (let i = node.from; i < node.to; i++) {
        const edge = edges[i];
        if (edge.south <= north && edge.north >= south && visit(edge)) return true;
      }
      return false;
    };
    return query(root);
  };
}

/**
 * Prepare once for repeated checks, retaining the one-shot predicates' boundary rules.
 * Static y-interval indexing follows JTS IndexedPointInAreaLocator / SortedPackedIntervalRTree:
 * https://locationtech.github.io/jts/javadoc/org/locationtech/jts/algorithm/locate/IndexedPointInAreaLocator.html
 */
export function prepareAreaGeometry(geometry: AreaGeometry): {
  containsPoint(point: Position): boolean;
  containsSegment(start: Position, end: Position): boolean;
} {
  const polygons = (geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates)
    .map((rings) => rings.map((ring) => indexRing(ring as unknown as Position[])));
  const relation = (point: Position, query: ReturnType<typeof indexRing>) => {
    let inside = false;
    const boundary = query(point[1], point[1], ({start, end}) => {
      if (coordinateIsOnSegment(point, start, end)) return true;
      if (edgeCrossesRay(point, start, end)) inside = !inside;
      return false;
    });
    return boundary ? "boundary" : inside ? "inside" : "outside";
  };
  const containsPoint = (point: Position): boolean => {
    if (!Number.isFinite(point[0]) || !Number.isFinite(point[1])) return false;
    return polygons.some((rings) => {
      const outer = rings[0] ? relation(point, rings[0]) : "outside";
      if (outer === "outside") return false;
      if (outer === "boundary") return true;
      for (let i = 1; i < rings.length; i++) {
        const hole = relation(point, rings[i]);
        if (hole === "boundary") return true;
        if (hole === "inside") return false;
      }
      return true;
    });
  };
  return {
    containsPoint,
    containsSegment(start, end) {
      if (!containsPoint(start) || !containsPoint(end)) return false;
      const direction = subtract(end, start);
      const squaredLength = direction[0] ** 2 + direction[1] ** 2;
      // Near-parallel edges can contribute projections within 2*epsilon/length.
      // Nonparallel intersections allow epsilon beyond each segment's endpoints.
      const padding = GEOMETRY_EPSILON + Math.max(
        squaredLength <= GEOMETRY_EPSILON ? 0 : 2 * GEOMETRY_EPSILON / Math.sqrt(squaredLength),
        GEOMETRY_EPSILON * Math.abs(direction[1]),
      );
      const south = Math.min(start[1], end[1]) - padding;
      const north = Math.max(start[1], end[1]) + padding;
      const parameters = [0, 1];
      for (const rings of polygons) for (const query of rings) {
        query(south, north, (edge) => {
          if (edge.explicit) appendBoundaryParameters(start, direction, squaredLength, edge.start, edge.end, parameters);
          return false;
        });
      }
      for (const point of interiorPoints(start, end, parameters)) {
        if (!containsPoint(point)) return false;
      }
      return true;
    },
  };
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
