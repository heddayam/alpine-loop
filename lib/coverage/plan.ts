import { MAX_ROUTE_DISTANCE_MILES, PREPARATION_BUFFER_MILES } from "@/lib/contracts/routes";
import { assertValidAreaGeometry, areaGeometryBounds, type AreaGeometry } from "@/lib/data/area-geometry";
import { prepareAreaGeometry } from "@/lib/graph/geometry";
import { contentId, intersectCoverage, rectangle, subtractCoverage, unionCoverage } from "./geometry";
import type { SourceRecipe } from "./recipe";
import type { CoverageRegion } from "./types";

export type LocalCoveragePlan = {
  id: string;
  name?: string;
  startGeometry: AreaGeometry;
  geometry: AreaGeometry;
  maximumRouteMiles: typeof MAX_ROUTE_DISTANCE_MILES;
  bufferMiles: number;
};

/** Every point of a closed walk of length L is at most L/2 from its start. */
export function routingEnvelope(startGeometry: AreaGeometry): AreaGeometry {
  const [west, south, east, north] = areaGeometryBounds(startGeometry);
  // Smaller than both the graph's spherical radius and Earth's minimum radius:
  // this overestimates angular distance. Bound longitude at the furthest latitude
  // reachable along the path, so this rectangle contains the whole metric buffer.
  const angle = PREPARATION_BUFFER_MILES * 1609.344 / 6_300_000;
  const latitude = angle * 180 / Math.PI;
  const furthestLatitude = Math.max(Math.abs(south), Math.abs(north)) + latitude;
  if (furthestLatitude >= 90) throw new Error("Start areas whose buffer reaches a pole are not supported");
  const longitude = latitude / Math.cos(furthestLatitude * Math.PI / 180);
  if (west - longitude <= -180 || east + longitude >= 180) throw new Error("Start areas whose buffer crosses the antimeridian are not supported");
  return rectangle([west - longitude, south - latitude, east + longitude, north + latitude]);
}

/** Apply declared hard boundaries, never treating a missing source as a clip. */
export function constrainCoverage(recipe: SourceRecipe, input: AreaGeometry): AreaGeometry {
  let geometry = input;
  if (recipe.supportedArea) {
    const supported = intersectCoverage(geometry, recipe.supportedArea.geometry);
    if (!supported) throw new Error(`No starts within ${recipe.supportedArea.name}`);
    geometry = supported;
  }
  if (subtractCoverage(geometry, unionCoverage(recipe.sources.map(source => source.geometry)))) {
    throw new Error("Sources do not cover the complete 25-mile route buffer. Add an adjacent source or choose an interior start area.");
  }
  for (const exclusion of recipe.exclusions) {
    const remaining = subtractCoverage(geometry, exclusion.geometry);
    if (!remaining) throw new Error("No supported start area remains after exclusions");
    geometry = remaining;
  }
  return geometry;
}

/** Register an actual entrance; this neighborhood never nominates new starts. */
export function entranceNeighborhood([lon, lat]: readonly [number, number], meters = 500): AreaGeometry {
  if (!Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lon) > 180 || Math.abs(lat) > 90 ||
    !Number.isFinite(meters) || meters <= 0) throw new Error("Invalid entrance neighborhood");
  const ring: [number, number][] = [];
  const angle = meters / 6_371_008.8, phi = lat * Math.PI / 180, lambda = lon * Math.PI / 180;
  for (let index = 0; index < 32; index++) {
    const bearing = index * 2 * Math.PI / 32;
    const y = Math.asin(Math.sin(phi) * Math.cos(angle) + Math.cos(phi) * Math.sin(angle) * Math.cos(bearing));
    const x = lambda + Math.atan2(Math.sin(bearing) * Math.sin(angle) * Math.cos(phi), Math.cos(angle) - Math.sin(phi) * Math.sin(y));
    ring.push([x * 180 / Math.PI, y * 180 / Math.PI]);
  }
  ring.push(ring[0]!);
  return {type: "Polygon", coordinates: [ring]};
}

/** Expand only around already admitted outside entrances. Preserve the original
 * core buffer rather than bounding the enlarged start footprint as one region.
 */
export function expandCoveragePlan<T extends LocalCoveragePlan>(plan: T, recipe: SourceRecipe,
  admittedOutsideStarts: Iterable<readonly [number, number]>): T {
  const core = prepareAreaGeometry(plan.startGeometry);
  const starts = [plan.startGeometry], routes = [plan.geometry];
  const admitted: Array<readonly [number, number]> = [];
  for (const coordinate of admittedOutsideStarts) {
    if (core.containsPoint(coordinate)) continue;
    const neighborhood = entranceNeighborhood(coordinate);
    admitted.push(coordinate);
    starts.push(neighborhood);
    routes.push(routingEnvelope(neighborhood));
  }
  if (!admitted.length) return plan;
  const startGeometry = constrainCoverage(recipe, unionCoverage(starts));
  const geometry = constrainCoverage(recipe, unionCoverage(routes));
  const eligible = prepareAreaGeometry(startGeometry);
  if (admitted.some(coordinate => !eligible.containsPoint(coordinate)))
    throw new Error("Admitted entrance falls outside supported coverage");
  return {...plan, startGeometry, geometry};
}

export function planLocalCoverage(recipe: SourceRecipe, input: AreaGeometry): LocalCoveragePlan {
  let startGeometry = assertValidAreaGeometry(input, "Start area");
  const envelope = routingEnvelope(startGeometry);
  if (recipe.supportedArea) {
    const starts = intersectCoverage(startGeometry, recipe.supportedArea.geometry);
    if (!starts) throw new Error(`No starts within ${recipe.supportedArea.name}`);
    startGeometry = starts;
  }
  const geometry = constrainCoverage(recipe, envelope);
  for (const exclusion of recipe.exclusions) {
    const remainingStarts = subtractCoverage(startGeometry, exclusion.geometry);
    if (!remainingStarts) throw new Error("No supported start area remains after exclusions");
    startGeometry = remainingStarts;
  }
  return {
    id: `area-${contentId({ startGeometry, maximumRouteMiles: MAX_ROUTE_DISTANCE_MILES, bufferMiles: PREPARATION_BUFFER_MILES }).slice(0, 32)}`,
    startGeometry, geometry, maximumRouteMiles: MAX_ROUTE_DISTANCE_MILES, bufferMiles: PREPARATION_BUFFER_MILES,
  };
}

/** Public build selection is a stable place name, not a coordinate-derived identity. */
export function planCoverageRegion(region: CoverageRegion): LocalCoveragePlan & {name: string} {
  return {...planLocalCoverage(region.recipe, region.geometry), id:region.id, name:region.name};
}
