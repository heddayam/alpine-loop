import type { Bounds, RouteLocation } from "../model.js";

export function locationsInView(locations: RouteLocation[], bounds: Bounds) {
  const [west, south, east, north] = bounds;
  return locations.filter(({ startPosition: [longitude, latitude] }) =>
    longitude >= west && longitude <= east && latitude >= south && latitude <= north);
}

/** Browse all starts; inspect exactly one hike. Shared coordinates retain every browse choice. */
export function startPoints(locations: RouteLocation[], selectedId: string | null = null) {
  const points = new Map<string, { key: string; position: [number, number]; routes: RouteLocation[] }>();
  for (const route of [...locations].sort((a, b) => a.id.localeCompare(b.id))) {
    if (selectedId && route.id !== selectedId) continue;
    const position: [number, number] = [route.startPosition[0], route.startPosition[1]];
    const key = position.join(",");
    let point = points.get(key);
    if (!point) {
      point = { key, position, routes: [] };
      points.set(key, point);
    }
    point.routes.push(route);
  }
  return [...points.values()];
}
