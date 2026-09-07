import type { GeneratedClosedRouteV3 } from "@/lib/contracts";

/** A saved route's real starting coordinate, independent of the installed pack. */
export function routeStart(route: Pick<GeneratedClosedRouteV3, "geometry" | "startAccessPoint">) {
  const point = route.startAccessPoint;
  const coordinate = route.geometry.coordinates[0] ?? [point.lon, point.lat];
  const coordinates: [number, number] = [coordinate[0], coordinate[1]];
  return { key: JSON.stringify([point.id, ...coordinates]), name: point.name, coordinates };
}
