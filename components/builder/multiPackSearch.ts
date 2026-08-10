import type { GenerateClosedRoutesResponseV3 } from "@/lib/contracts";
import type { AreaGeometry } from "@/lib/graph";
import type { Bounds } from "./types";

export function unionBounds(bounds: Bounds[]): Bounds {
  if (bounds.length === 0) throw new Error("At least one bounds value is required");

  return bounds.slice(1).reduce<Bounds>(
    ([west, south, east, north], [nextWest, nextSouth, nextEast, nextNorth]) => [
      Math.min(west, nextWest),
      Math.min(south, nextSouth),
      Math.max(east, nextEast),
      Math.max(north, nextNorth),
    ],
    bounds[0]!,
  );
}

export function combineAreaGeometries(geometries: AreaGeometry[]): AreaGeometry | undefined {
  if (geometries.length === 0) return undefined;

  const polygons = geometries.flatMap((geometry) =>
    geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates,
  );

  if (polygons.length === 1) return { type: "Polygon", coordinates: polygons[0]! };
  return { type: "MultiPolygon", coordinates: polygons };
}

export function namespaceResponse(
  packId: string,
  response: GenerateClosedRoutesResponseV3,
): GenerateClosedRoutesResponseV3 {
  const namespaceRoute = <Route extends GenerateClosedRoutesResponseV3["exact"][number]>(route: Route): Route => ({
    ...route,
    id: `${packId}::${route.id}`,
    ...(route.trailSegments
      ? { trailSegments: route.trailSegments.map((segment) => ({ ...segment, id: `${packId}::${segment.id}` })) }
      : {}),
  });

  return {
    ...response,
    exact: response.exact.map(namespaceRoute),
    nearMisses: response.nearMisses.map(namespaceRoute),
  };
}

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

function routeGeometryKey(route: GenerateClosedRoutesResponseV3["exact"][number]): string {
  // Treat a trace as an unordered multiset of undirected segments. This makes
  // overlapping routes compare equal even if another pack emits the same loop
  // from a different start point or in the opposite direction.
  const points = route.geometry.coordinates.map(([lon, lat]) => `${lon.toFixed(6)},${lat.toFixed(6)}`);
  const segments = points.slice(1).map((point, index) => {
    const previous = points[index]!;
    return previous < point ? `${previous}>${point}` : `${point}>${previous}`;
  });
  return segments.sort().join("|");
}

function uniqueStrings(groups: ReadonlyArray<ReadonlyArray<string>>): string[] {
  return [...new Set(groups.flatMap((group) => group))];
}

function stableRequestId(
  inputs: Array<{ packLabel: string; response: GenerateClosedRoutesResponseV3 }>,
  limit: number,
): string {
  const value = JSON.stringify({
    limit,
    inputs: inputs.map(({ packLabel, response }) => ({
      packLabel,
      packId: response.pack.id,
      requestId: response.requestId,
    })),
  });
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `multi-${(hash >>> 0).toString(36).padStart(7, "0")}`;
}

export function combineQuickResponses(
  inputs: Array<{ packLabel: string; response: GenerateClosedRoutesResponseV3 }>,
  limit: number,
): GenerateClosedRoutesResponseV3 {
  if (inputs.length === 0) throw new Error("At least one response is required");
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error("Limit must be an integer from 1 through 20");

  const namespaced = inputs.map(({ packLabel, response }) => ({
    packLabel,
    response: namespaceResponse(response.pack.id, response),
  }));
  const responses = namespaced.map(({ response }) => response);
  const diagnostics = responses.map((response) => response.diagnostics);
  const sum = (select: (item: GenerateClosedRoutesResponseV3["diagnostics"]) => number) =>
    diagnostics.reduce((total, item) => total + select(item), 0);
  const firstExactTimes = diagnostics.flatMap(({ timeToFirstExactMs }) =>
    timeToFirstExactMs === undefined ? [] : [timeToFirstExactMs],
  );
  const seenGeometries = new Set<string>();
  const exact = roundRobinUnique(responses.map(({ exact }) => exact), limit, routeGeometryKey, seenGeometries);
  const nearMisses = roundRobinUnique(responses.map(({ nearMisses }) => nearMisses), limit, routeGeometryKey, seenGeometries);

  return {
    version: 3,
    requestId: stableRequestId(inputs, limit),
    pack: responses[0]!.pack,
    requested: limit,
    resolvedAccessFilter: {
      mode: responses[0]!.resolvedAccessFilter.mode,
      label: inputs.length === 1
        ? inputs[0]!.response.resolvedAccessFilter.label
        : `Multiple regions: ${inputs.map(({ packLabel }) => packLabel).join(", ")}`,
    },
    exact,
    nearMisses,
    diagnostics: {
      elapsedMs: sum(({ elapsedMs }) => elapsedMs),
      expandedStates: sum(({ expandedStates }) => expandedStates),
      candidateCount: sum(({ candidateCount }) => candidateCount),
      eligibleAccessPointCount: sum(({ eligibleAccessPointCount }) => eligibleAccessPointCount),
      searchedAccessPointCount: sum(({ searchedAccessPointCount }) => searchedAccessPointCount),
      graphQueryCount: sum(({ graphQueryCount }) => graphQueryCount),
      maximumLoadedDirectedEdges: Math.max(...diagnostics.map(({ maximumLoadedDirectedEdges }) => maximumLoadedDirectedEdges)),
      exhausted: diagnostics.every(({ exhausted }) => exhausted),
      truncationReasons: uniqueStrings(diagnostics.map(({ truncationReasons }) => truncationReasons)),
      shortfallReasons: uniqueStrings(diagnostics.map(({ shortfallReasons }) => shortfallReasons)),
      noCycleAccessPointCount: sum(({ noCycleAccessPointCount }) => noCycleAccessPointCount),
      feasibleAccessPointCount: sum(({ feasibleAccessPointCount }) => feasibleAccessPointCount),
      attachmentGroupCount: sum(({ attachmentGroupCount }) => attachmentGroupCount),
      probedAttachmentGroupCount: sum(({ probedAttachmentGroupCount }) => probedAttachmentGroupCount),
      deeplySearchedAttachmentGroupCount: sum(({ deeplySearchedAttachmentGroupCount }) => deeplySearchedAttachmentGroupCount),
      loadedTopologyNetworkCount: sum(({ loadedTopologyNetworkCount }) => loadedTopologyNetworkCount),
      cycleBlockCount: sum(({ cycleBlockCount }) => cycleBlockCount),
      cyclePrimitiveCount: sum(({ cyclePrimitiveCount }) => cyclePrimitiveCount),
      composedCandidateCount: sum(({ composedCandidateCount }) => composedCandidateCount),
      repairedCandidateCount: sum(({ repairedCandidateCount }) => repairedCandidateCount),
      directedValidationRejectionCount: sum(({ directedValidationRejectionCount }) => directedValidationRejectionCount),
      expandedAssemblyStates: sum(({ expandedAssemblyStates }) => expandedAssemblyStates),
      ...(firstExactTimes.length > 0 ? { timeToFirstExactMs: Math.min(...firstExactTimes) } : {}),
      hardTruncationReasons: uniqueStrings(diagnostics.map(({ hardTruncationReasons }) => hardTruncationReasons)),
      nonBudgetShortfallReasons: uniqueStrings(diagnostics.map(({ nonBudgetShortfallReasons }) => nonBudgetShortfallReasons)),
    },
  };
}

export function reconcileSelectedPackIds(
  urlCandidates: readonly string[],
  availablePackIds: readonly string[],
  fallbackPackId?: string,
  allowEmpty = false,
): string[] {
  const orderedAvailable = [...new Set(availablePackIds)];
  if (orderedAvailable.length === 0) throw new Error("At least one available pack is required");

  const candidates = new Set(urlCandidates);
  const selected = orderedAvailable.filter((packId) => candidates.has(packId));
  if (selected.length > 0) return selected;
  if (allowEmpty) return [];
  if (fallbackPackId && orderedAvailable.includes(fallbackPackId)) return [fallbackPackId];
  return [orderedAvailable[0]!];
}
