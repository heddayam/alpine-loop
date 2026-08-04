import type { GraphEdge, GraphNode } from "./types";

export type BoundingBox = readonly [west: number, south: number, east: number, north: number];

export function coordinateIsInsideBbox(
  coordinate: readonly [number, number],
  [west, south, east, north]: BoundingBox,
): boolean {
  const [lon, lat] = coordinate;
  return Number.isFinite(lon) && Number.isFinite(lat) && lon >= west && lon <= east && lat >= south && lat <= north;
}

export function nodeIsInsideBbox(node: GraphNode, bbox: BoundingBox): boolean {
  return coordinateIsInsideBbox([node.lon, node.lat], bbox);
}

export function edgeIsInsideBbox(edge: GraphEdge, bbox: BoundingBox): boolean {
  return edge.coordinates.length >= 2 && edge.coordinates.every((coordinate) => coordinateIsInsideBbox(coordinate, bbox));
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

export function lineLengthMeters(coordinates: ReadonlyArray<readonly [number, number]>): number {
  let length = 0;
  for (let index = 1; index < coordinates.length; index += 1) {
    length += distanceMetersBetween(coordinates[index - 1], coordinates[index]);
  }
  return length;
}
