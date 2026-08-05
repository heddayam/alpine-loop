import { areaGeometrySchema, type NamedArea } from "@/lib/contracts";
import type { CompiledEdge, Coordinate } from "./types";

export type AreaGeometry = NamedArea["geometry"];
export type Bbox = [west: number, south: number, east: number, north: number];

const EPSILON = 1e-10;

function coordinatesEqual(first: Coordinate, second: Coordinate): boolean {
  return Math.abs(first[0] - second[0]) <= EPSILON && Math.abs(first[1] - second[1]) <= EPSILON;
}

function signedArea(ring: readonly Coordinate[]): number {
  let area = 0;
  for (let index = 0; index < ring.length - 1; index += 1) {
    area += ring[index]![0] * ring[index + 1]![1] - ring[index + 1]![0] * ring[index]![1];
  }
  return area / 2;
}

function orientation(first: Coordinate, second: Coordinate, third: Coordinate): number {
  return (second[0] - first[0]) * (third[1] - first[1])
    - (second[1] - first[1]) * (third[0] - first[0]);
}

function pointOnSegment(point: Coordinate, first: Coordinate, second: Coordinate): boolean {
  return Math.abs(orientation(first, second, point)) <= EPSILON
    && point[0] >= Math.min(first[0], second[0]) - EPSILON
    && point[0] <= Math.max(first[0], second[0]) + EPSILON
    && point[1] >= Math.min(first[1], second[1]) - EPSILON
    && point[1] <= Math.max(first[1], second[1]) + EPSILON;
}

function segmentsProperlyIntersect(
  firstStart: Coordinate,
  firstEnd: Coordinate,
  secondStart: Coordinate,
  secondEnd: Coordinate,
): boolean {
  const firstA = orientation(firstStart, firstEnd, secondStart);
  const firstB = orientation(firstStart, firstEnd, secondEnd);
  const secondA = orientation(secondStart, secondEnd, firstStart);
  const secondB = orientation(secondStart, secondEnd, firstEnd);
  return ((firstA > EPSILON && firstB < -EPSILON) || (firstA < -EPSILON && firstB > EPSILON))
    && ((secondA > EPSILON && secondB < -EPSILON) || (secondA < -EPSILON && secondB > EPSILON));
}

function assertValidRing(ring: readonly Coordinate[], label: string): void {
  if (Math.abs(signedArea(ring)) <= EPSILON) throw new Error(`${label} has zero area`);
  for (let index = 0; index < ring.length - 1; index += 1) {
    if (coordinatesEqual(ring[index]!, ring[index + 1]!)) throw new Error(`${label} has a duplicate consecutive coordinate`);
  }
  const segmentCount = ring.length - 1;
  for (let first = 0; first < segmentCount; first += 1) {
    for (let second = first + 1; second < segmentCount; second += 1) {
      if (second === first + 1 || (first === 0 && second === segmentCount - 1)) continue;
      if (segmentsProperlyIntersect(ring[first]!, ring[first + 1]!, ring[second]!, ring[second + 1]!)) {
        throw new Error(`${label} self-intersects`);
      }
    }
  }
}

export function assertValidAreaGeometry(input: unknown, label = "Area geometry"): AreaGeometry {
  const geometry = areaGeometrySchema.parse(input);
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  polygons.forEach((polygon, polygonIndex) => polygon.forEach((ring, ringIndex) => {
    assertValidRing(ring, `${label} polygon ${polygonIndex} ring ${ringIndex}`);
  }));
  return geometry;
}

export function areaGeometryBounds(geometry: AreaGeometry): Bbox {
  const rings = geometry.type === "Polygon" ? geometry.coordinates : geometry.coordinates.flat();
  const coordinates = rings.flat();
  return [
    Math.min(...coordinates.map(([lon]) => lon)),
    Math.min(...coordinates.map(([, lat]) => lat)),
    Math.max(...coordinates.map(([lon]) => lon)),
    Math.max(...coordinates.map(([, lat]) => lat)),
  ];
}

function pointInRing(point: Coordinate, ring: readonly Coordinate[]): "inside" | "outside" | "boundary" {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index, index += 1) {
    const currentPoint = ring[index]!;
    const previousPoint = ring[previous]!;
    if (pointOnSegment(point, previousPoint, currentPoint)) return "boundary";
    if ((currentPoint[1] > point[1]) !== (previousPoint[1] > point[1])) {
      const crossingLon = (previousPoint[0] - currentPoint[0]) * (point[1] - currentPoint[1])
        / (previousPoint[1] - currentPoint[1]) + currentPoint[0];
      if (point[0] < crossingLon) inside = !inside;
    }
  }
  return inside ? "inside" : "outside";
}

function pointInPolygon(point: Coordinate, polygon: readonly (readonly Coordinate[])[]): boolean {
  const exterior = pointInRing(point, polygon[0]!);
  if (exterior === "outside") return false;
  if (exterior === "boundary") return true;
  for (const hole of polygon.slice(1)) {
    const position = pointInRing(point, hole);
    if (position === "inside") return false;
    if (position === "boundary") return true;
  }
  return true;
}

export function pointInArea(point: Coordinate, geometry: AreaGeometry): boolean {
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  return polygons.some((polygon) => pointInPolygon(point, polygon));
}

function segmentIntersectionParameter(
  start: Coordinate,
  end: Coordinate,
  boundaryStart: Coordinate,
  boundaryEnd: Coordinate,
): number | null {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const bx = boundaryEnd[0] - boundaryStart[0];
  const by = boundaryEnd[1] - boundaryStart[1];
  const denominator = dx * by - dy * bx;
  if (Math.abs(denominator) <= EPSILON) return null;
  const offsetX = boundaryStart[0] - start[0];
  const offsetY = boundaryStart[1] - start[1];
  const t = (offsetX * by - offsetY * bx) / denominator;
  const u = (offsetX * dy - offsetY * dx) / denominator;
  return t >= -EPSILON && t <= 1 + EPSILON && u >= -EPSILON && u <= 1 + EPSILON
    ? Math.max(0, Math.min(1, t))
    : null;
}

function segmentInsideArea(start: Coordinate, end: Coordinate, geometry: AreaGeometry): boolean {
  if (!pointInArea(start, geometry) || !pointInArea(end, geometry)) return false;
  const rings = geometry.type === "Polygon" ? geometry.coordinates : geometry.coordinates.flat();
  const parameters = [0, 1];
  for (const ring of rings) {
    for (let index = 0; index < ring.length - 1; index += 1) {
      const parameter = segmentIntersectionParameter(start, end, ring[index]!, ring[index + 1]!);
      if (parameter !== null) parameters.push(parameter);
    }
  }
  parameters.sort((first, second) => first - second);
  const distinct = parameters.filter((value, index) => index === 0 || Math.abs(value - parameters[index - 1]!) > EPSILON);
  for (let index = 0; index < distinct.length - 1; index += 1) {
    const midpoint = (distinct[index]! + distinct[index + 1]!) / 2;
    if (!pointInArea([
      start[0] + (end[0] - start[0]) * midpoint,
      start[1] + (end[1] - start[1]) * midpoint,
    ], geometry)) return false;
  }
  return true;
}

export function edgeInsideCoverage(edge: Pick<CompiledEdge, "geometry">, geometry: AreaGeometry): boolean {
  return edge.geometry.every((coordinate, index) => index === 0
    || segmentInsideArea(edge.geometry[index - 1]!, coordinate, geometry));
}
