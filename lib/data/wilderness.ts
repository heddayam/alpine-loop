import { distanceMeters } from "./metrics";
import type { BuildingCentroid } from "./osm/buildings";
import type { Coordinate, NormalizedAccessPoint, NormalizedNode } from "./types";

/**
 * Whether an access point is somewhere people live.
 *
 * The product only ever wants wilderness starts, so this is one measurement and
 * one rule rather than a taxonomy the user picks from. Buildings within a short
 * walk are the most direct evidence available: they come out of the OSM extract
 * the pack already builds from, and unlike a wide-area population figure they
 * describe the immediate surroundings, which is what "is this in a
 * neighbourhood" actually asks.
 *
 * A wide-area population count could not make this distinction. Fall Creek Fire
 * Road and the Henry Cowell nature centre sit in near-identical population
 * fields because Felton is inside the radius, but one has 9 buildings within
 * 500 m and the other has 28.
 */
export const BUILDING_RADIUS_M = 500;

/**
 * Above this many buildings within `BUILDING_RADIUS_M`, the start is in a town
 * or a neighbourhood. Deliberately permissive: it keeps park gateways that sit
 * near a small settlement and only rejects genuinely built-up surroundings.
 */
export const MAXIMUM_NEARBY_BUILDINGS = 50;

export function accessPointIsWildEnough(
  candidate: { nearbyBuildingCount: number },
): boolean {
  return candidate.nearbyBuildingCount < MAXIMUM_NEARBY_BUILDINGS;
}

function cellKey(lon: number, lat: number, cellDegrees: number): string {
  return `${Math.floor(lon / cellDegrees)}:${Math.floor(lat / cellDegrees)}`;
}

/**
 * Buildings within `radiusM` of each access point.
 *
 * Centroids are bucketed into a grid one radius wide first, so each access
 * point only scans the nine cells that can contain a match; packs carry
 * hundreds of thousands of buildings.
 */
export function countNearbyBuildings(
  buildings: readonly BuildingCentroid[],
  accessPoints: readonly NormalizedAccessPoint[],
  nodes: readonly NormalizedNode[],
  radiusM: number = BUILDING_RADIUS_M,
): Map<string, number> {
  const cellDegrees = Math.max(radiusM / 111_320, 1e-6);
  const buckets = new Map<string, BuildingCentroid[]>();
  for (const building of buildings) {
    const key = cellKey(building[0], building[1], cellDegrees);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(building);
    else buckets.set(key, [building]);
  }
  const nodeById = new Map(nodes.map((node) => [node.id, node]));

  const result = new Map<string, number>();
  for (const point of accessPoints) {
    const anchor = nodeById.get(point.nodeId);
    if (!anchor) {
      result.set(point.id, 0);
      continue;
    }
    const origin: Coordinate = [anchor.lon, anchor.lat];
    const centreColumn = Math.floor(anchor.lon / cellDegrees);
    const centreRow = Math.floor(anchor.lat / cellDegrees);
    let count = 0;
    for (let column = centreColumn - 1; column <= centreColumn + 1; column += 1) {
      for (let row = centreRow - 1; row <= centreRow + 1; row += 1) {
        for (const building of buckets.get(`${column}:${row}`) ?? []) {
          if (distanceMeters(origin, building) <= radiusM) count += 1;
        }
      }
    }
    result.set(point.id, count);
  }
  return result;
}
