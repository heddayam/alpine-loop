import { distanceMeters } from "./metrics";
import type { Coordinate, NormalizedAccessPoint, NormalizedNode } from "./types";
import type { AccessPointRemoteness } from "@/lib/contracts";

/**
 * How remote an access point is, measured rather than inferred from tags.
 *
 * Two independent axes, because neither alone answers "is this a mountain
 * trailhead":
 *
 *  - `populationWithinRadiusM` (GHS-POP) says whether people live here. It is
 *    the discriminator that actually separates a neighbourhood park entrance
 *    from a backcountry trailhead, and unlike OSM `landuse=residential` its
 *    coverage does not fall apart in the rural US.
 *  - `localReliefM` says whether the terrain is mountainous. Population alone
 *    would happily call farmland and desert flats "remote".
 *
 * Only the raw measurements are persisted. Classification lives here as a pure
 * function so thresholds can be retuned without recompiling every pack.
 */

export const POPULATION_RADIUS_M = 1_000;
export const RELIEF_RADIUS_M = 2_000;

/**
 * Calibrated against measured GHS-POP values in the Santa Cruz Mountains pack
 * area (people within 1 km): Big Basin 0.1, Castle Rock 14, Saratoga foothills
 * 3,336, downtown San Jose 20,095.
 */
export const POPULATION_REMOTE_MAX = 100;
export const POPULATION_RURAL_MAX = 2_500;

export type RemotenessClass = AccessPointRemoteness;

export type RemotenessMeasurement = {
  populationWithinRadius: number | null;
  localReliefM: number | null;
};

export function classifyRemoteness(measurement: RemotenessMeasurement): RemotenessClass {
  const population = measurement.populationWithinRadius;
  if (population === null) return "unknown";
  if (population < POPULATION_REMOTE_MAX) return "remote";
  if (population < POPULATION_RURAL_MAX) return "rural";
  return "populated";
}

/**
 * A 0..1 convenience ranking where 1 is most remote. Population dominates and
 * relief only breaks ties, so a flat unpopulated area still outranks a hilly
 * suburb. Null population yields null: an unmeasured point must not be ranked
 * as though it were empty.
 */
export function remotenessScore(measurement: RemotenessMeasurement): number | null {
  const { populationWithinRadius: population, localReliefM: relief } = measurement;
  if (population === null) return null;
  // log10 keeps the enormous dynamic range (0.1 to 20,000 people) usable.
  const populationTerm = 1 - Math.min(1, Math.log10(1 + Math.max(0, population)) / Math.log10(1 + POPULATION_RURAL_MAX));
  const reliefTerm = relief === null ? 0 : Math.min(1, relief / 500);
  const score = 0.8 * populationTerm + 0.2 * reliefTerm;
  return Math.round(Math.min(1, Math.max(0, score)) * 1000) / 1000;
}

function cellKey(lon: number, lat: number, cellDegrees: number): string {
  return `${Math.floor(lon / cellDegrees)}:${Math.floor(lat / cellDegrees)}`;
}

/**
 * Elevation range among network nodes within `radiusM` of each access point.
 *
 * Absolute elevation is regionally meaningless (a 300 m Cascades trailhead
 * against a 2,000 m Colorado one), so this measures local relief instead. Nodes
 * are bucketed into a coarse grid first because packs carry hundreds of
 * thousands of them.
 */
export function computeLocalRelief(
  nodes: readonly NormalizedNode[],
  accessPoints: readonly NormalizedAccessPoint[],
  radiusM: number = RELIEF_RADIUS_M,
): Map<string, number | null> {
  const cellDegrees = Math.max(radiusM / 111_320, 1e-6);
  const buckets = new Map<string, NormalizedNode[]>();
  for (const node of nodes) {
    if (node.elevationM === null) continue;
    const key = cellKey(node.lon, node.lat, cellDegrees);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(node);
    else buckets.set(key, [node]);
  }
  const nodeById = new Map(nodes.map((node) => [node.id, node]));

  const result = new Map<string, number | null>();
  for (const point of accessPoints) {
    const anchor = nodeById.get(point.nodeId);
    if (!anchor) {
      result.set(point.id, null);
      continue;
    }
    const origin: Coordinate = [anchor.lon, anchor.lat];
    const centreColumn = Math.floor(anchor.lon / cellDegrees);
    const centreRow = Math.floor(anchor.lat / cellDegrees);
    let minimum = Number.POSITIVE_INFINITY;
    let maximum = Number.NEGATIVE_INFINITY;
    for (let column = centreColumn - 1; column <= centreColumn + 1; column += 1) {
      for (let row = centreRow - 1; row <= centreRow + 1; row += 1) {
        for (const node of buckets.get(`${column}:${row}`) ?? []) {
          if (distanceMeters(origin, [node.lon, node.lat]) > radiusM) continue;
          const elevation = node.elevationM!;
          if (elevation < minimum) minimum = elevation;
          if (elevation > maximum) maximum = elevation;
        }
      }
    }
    result.set(point.id, Number.isFinite(minimum) && Number.isFinite(maximum) ? maximum - minimum : null);
  }
  return result;
}
