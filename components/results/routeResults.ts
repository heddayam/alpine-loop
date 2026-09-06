import type { GeneratedClosedRouteV3, GenerateClosedRoutesResponseV3, RouteJobResultsPage } from "@/lib/contracts";
import type { RouteResults } from "./types";

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

export function collectQuickResults(
  inputs: Array<{ label: string; response: GenerateClosedRoutesResponseV3 }>,
  limit: number,
): Extract<RouteResults, { kind: "quick" }> {
  if (inputs.length === 0) throw new Error("At least one response is required");
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error("Limit must be an integer from 1 through 20");

  const groups = inputs.map(({ label, response }) => {
    const namespaceRoute = <T extends GeneratedClosedRouteV3>(route: T): T & { regionLabel: string } => ({
      ...route,
      id: `${response.pack.id}::${route.id}`,
      regionLabel: label,
      ...(route.trailSegments ? {
        trailSegments: route.trailSegments.map((segment) => ({ ...segment, id: `${response.pack.id}::${segment.id}` })),
      } : {}),
    });
    return { exact: response.exact.map(namespaceRoute), nearMisses: response.nearMisses.map(namespaceRoute) };
  });
  const seen = new Set<string>();
  return {
    kind: "quick",
    requested: limit,
    exact: roundRobinUnique(groups.map(({ exact }) => exact), limit, routeGeometryKey, seen),
    nearMisses: roundRobinUnique(groups.map(({ nearMisses }) => nearMisses), limit, routeGeometryKey, seen),
    searches: inputs.map(({ label, response: { requestId, pack, resolvedAccessFilter, diagnostics } }) => ({
      label, requestId, pack, resolvedAccessFilter, diagnostics,
    })),
  };
}

export function savedRouteResults(
  page: RouteJobResultsPage,
  regionLabel: string,
): Extract<RouteResults, { kind: "saved" }> {
  return {
    kind: "saved",
    job: page.job,
    nextCursor: page.nextCursor,
    exact: page.results.filter((result) => result.matchType === "exact")
      .map(({ route }) => ({ ...route, regionLabel })),
    nearMisses: page.results.filter((result) => result.matchType === "near-miss")
      .map(({ route }) => ({ ...route, regionLabel })),
  };
}
