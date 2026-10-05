import type { RouteLocation } from "../model.js";

/** World-pixel cells make grouping independent of input order and map panning. */
export function clusterLocations(
  locations: RouteLocation[],
  project: (location: RouteLocation) => { x: number; y: number },
  cellSize = 52,
) {
  const cells = new Map<string, RouteLocation[]>();
  for (const location of [...locations].sort((a, b) =>
    a.id.localeCompare(b.id),
  )) {
    const point = project(location);
    const key = `${Math.floor(point.x / cellSize)}:${Math.floor(point.y / cellSize)}`;
    const cell = cells.get(key) ?? [];
    cell.push(location);
    cells.set(key, cell);
  }
  return [...cells.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, routes]) => ({
      key,
      routes,
      coincident: routes.every(
        (route) =>
          route.startPosition[0] === routes[0]!.startPosition[0] &&
          route.startPosition[1] === routes[0]!.startPosition[1],
      ),
      position: [
        routes.reduce((sum, route) => sum + route.startPosition[0], 0) /
          routes.length,
        routes.reduce((sum, route) => sum + route.startPosition[1], 0) /
          routes.length,
      ] as [number, number],
    }));
}
