import { areaGeometrySchema, type NamedArea } from "@/lib/contracts";
import {
  areaBounds,
  coordinateIsInsideArea,
  lineIsInsideArea,
} from "@/lib/graph/geometry";
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
  return [...areaBounds(geometry)];
}

export function pointInArea(point: Coordinate, geometry: AreaGeometry): boolean {
  return coordinateIsInsideArea(point, geometry);
}

export function edgeInsideCoverage(edge: Pick<CompiledEdge, "geometry">, geometry: AreaGeometry): boolean {
  return lineIsInsideArea(edge.geometry, geometry);
}
