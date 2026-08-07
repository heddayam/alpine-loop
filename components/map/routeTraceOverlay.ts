export const ROUTE_PREVIEW_EVENT = "alpine-loop:route-preview";

export function announceRoutePreview(routeId?: string) {
  window.dispatchEvent(new CustomEvent(ROUTE_PREVIEW_EVENT, { detail: { routeId } }));
}
