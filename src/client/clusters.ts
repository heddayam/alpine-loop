import type { Bounds, RouteLocation } from "../model.js";

export function locationsInView(locations: RouteLocation[], bounds: Bounds) {
  const [west, south, east, north] = bounds;
  return locations.filter(({ startPosition: [longitude, latitude] }) =>
    longitude >= west && longitude <= east && latitude >= south && latitude <= north);
}

/** Browse all start places; inspect exactly one hike. A shared place retains every browse choice. */
export function startPoints(locations: RouteLocation[], selectedId: string | null = null) {
  const points = new Map<string, { key: string; position: [number, number]; routes: RouteLocation[] }>();
  for (const route of [...locations].sort((a, b) => a.id.localeCompare(b.id))) {
    if (selectedId && route.id !== selectedId) continue;
    // Routes report their place's position; older saved routes group by exact coordinates.
    const position: [number, number] = [route.startPosition[0], route.startPosition[1]];
    const key = route.startPlace ?? position.join(",");
    let point = points.get(key);
    if (!point) {
      point = { key, position, routes: [] };
      points.set(key, point);
    }
    point.routes.push(route);
  }
  return [...points.values()];
}
