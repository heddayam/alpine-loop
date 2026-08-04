import type { GeneratedRoute } from "@/lib/contracts";

export const ROUTE_PREVIEW_EVENT = "alpine-search:route-preview";

export type ProjectedRouteTrace = {
  id: string;
  path: string;
  routeNumber: number;
  selected: boolean;
  hovered: boolean;
};

type ScreenPoint = { x: number; y: number };
type ProjectCoordinate = (coordinate: [number, number]) => ScreenPoint;

export function projectedRouteTraces(
  routes: GeneratedRoute[],
  selectedRouteId: string | undefined,
  hoveredRouteId: string | undefined,
  project: ProjectCoordinate,
): ProjectedRouteTrace[] {
  const traces = routes.flatMap((route, index) => {
    if (route.geometry.coordinates.length < 2) return [];
    const path = route.geometry.coordinates.map((coordinate, coordinateIndex) => {
      const point = project([coordinate[0], coordinate[1]]);
      return `${coordinateIndex === 0 ? "M" : "L"}${point.x.toFixed(1)} ${point.y.toFixed(1)}`;
    }).join(" ");
    return [{
      id: route.id,
      path,
      routeNumber: index + 1,
      selected: route.id === selectedRouteId,
      hovered: route.id === hoveredRouteId,
    }];
  });
  return traces.sort((left, right) => {
    const weight = (trace: ProjectedRouteTrace) => trace.hovered ? 2 : trace.selected ? 1 : 0;
    return weight(left) - weight(right);
  });
}

export function announceRoutePreview(routeId?: string) {
  window.dispatchEvent(new CustomEvent(ROUTE_PREVIEW_EVENT, { detail: { routeId } }));
}
