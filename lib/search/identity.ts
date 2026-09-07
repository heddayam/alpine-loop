import type { GeneratedClosedRouteV3 } from "@/lib/contracts";

export function namespacedId(packId: string, id: string): string {
  return `${packId}::${id}`;
}

export function splitNamespacedId(id: string): [string, string] {
  const separator = id.indexOf("::");
  if (separator < 1 || separator === id.length - 2) throw new Error("Invalid geographic identifier");
  return [id.slice(0, separator), id.slice(separator + 2)];
}

export function namespaceRoute<T extends GeneratedClosedRouteV3>(route: T, packId: string, regionLabel: string): T & { regionLabel: string } {
  return {
    ...route,
    id: namespacedId(packId, route.id),
    startAccessPoint: { ...route.startAccessPoint, id: namespacedId(packId, route.startAccessPoint.id) },
    regionLabel,
    ...(route.trailSegments ? {
      trailSegments: route.trailSegments.map((segment) => ({ ...segment, id: namespacedId(packId, segment.id) })),
    } : {}),
  };
}
