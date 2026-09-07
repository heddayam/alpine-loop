import type { GeneratedClosedRouteV3, SearchRoute, CloseSearchRoute } from "@/lib/contracts";

function roundRobinUnique<T>(
  groups: ReadonlyArray<ReadonlyArray<T>>,
  limit: number,
  keyFor: (item: T) => string,
  seen = new Set<string>(),
): T[] {
  const combined: T[] = [];
  const longestGroup = Math.max(0, ...groups.map(({ length }) => length));
  for (let offset = 0; combined.length < limit && offset < longestGroup; offset += 1) {
    for (const group of groups) {
      const item = group[offset];
      if (item === undefined) continue;
      const key = keyFor(item);
      if (seen.has(key)) continue;
      seen.add(key);
      combined.push(item);
      if (combined.length === limit) break;
    }
  }
  return combined;
}

function routeGeometryKey(route: GeneratedClosedRouteV3): string {
  // Preserve the current diversity policy: rotated and reversed traces share
  // a footprint even when overlapping datasets assign different route IDs.
  const points = route.geometry.coordinates.map(([lon, lat]) => `${lon.toFixed(6)},${lat.toFixed(6)}`);
  const segments = points.slice(1).map((point, index) => {
    const previous = points[index]!;
    return previous < point ? `${previous}>${point}` : `${point}>${previous}`;
  });
  return segments.sort().join("|");
}

export function combineRoutes(groups: Array<{ exact: SearchRoute[]; nearMisses: CloseSearchRoute[] }>, limit: number) {
  const seen = new Set<string>();
  const exact = roundRobinUnique(groups.map(({ exact }) => exact), limit, routeGeometryKey, seen);
  return {
    exact,
    nearMisses: roundRobinUnique(groups.map(({ nearMisses }) => nearMisses), limit - exact.length, routeGeometryKey, seen),
  };
}
