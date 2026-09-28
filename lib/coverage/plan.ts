import { MAX_ROUTE_DISTANCE_MILES, PREPARATION_BUFFER_MILES } from "@/lib/contracts/routes";
import { assertValidAreaGeometry, areaGeometryBounds, type AreaGeometry } from "@/lib/data/area-geometry";
import { contentId, rectangle, subtractCoverage, unionCoverage } from "./geometry";
import type { SourceRecipe } from "./recipe";

export type LocalCoveragePlan = {
  id: string;
  startGeometry: AreaGeometry;
  geometry: AreaGeometry;
  maximumRouteMiles: typeof MAX_ROUTE_DISTANCE_MILES;
  bufferMiles: number;
};

/** Every point of a closed walk of length L is at most L/2 from its start. */
export function planLocalCoverage(recipe: SourceRecipe, input: AreaGeometry): LocalCoveragePlan {
  let startGeometry = assertValidAreaGeometry(input, "Start area");
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
  let geometry = rectangle([west - longitude, south - latitude, east + longitude, north + latitude]);
  if (subtractCoverage(geometry, unionCoverage(recipe.sources.map(source => source.geometry)))) {
    throw new Error("Sources do not cover the complete 25-mile route buffer. Add an adjacent source or choose an interior start area.");
  }
  for (const exclusion of recipe.exclusions) {
    const remainingStarts = subtractCoverage(startGeometry, exclusion.geometry);
    const remainingRoutes = subtractCoverage(geometry, exclusion.geometry);
    if (!remainingStarts || !remainingRoutes) throw new Error("No supported start area remains after exclusions");
    startGeometry = remainingStarts;
    geometry = remainingRoutes;
  }
  return {
    id: `area-${contentId({ startGeometry, maximumRouteMiles: MAX_ROUTE_DISTANCE_MILES, bufferMiles: PREPARATION_BUFFER_MILES }).slice(0, 32)}`,
    startGeometry, geometry, maximumRouteMiles: MAX_ROUTE_DISTANCE_MILES, bufferMiles: PREPARATION_BUFFER_MILES,
  };
}
