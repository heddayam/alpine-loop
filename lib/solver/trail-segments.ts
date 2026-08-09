import type { GeneratedTrailSegment, TrailSegmentCondition } from "@/lib/contracts";
import type { ReconstructedDirectedEdge } from "@/lib/graph";

function flagValue(flags: readonly string[], prefix: string): string | undefined {
  return flags.find((flag) => flag.startsWith(prefix))?.slice(prefix.length) || undefined;
}

function conditionFor(flags: readonly string[]): TrailSegmentCondition {
  const highway = flagValue(flags, "osm-highway:");
  const surface = flagValue(flags, "surface:");
  const smoothness = flagValue(flags, "smoothness:");
  const trailVisibility = flagValue(flags, "trail-visibility:");
  const sacScale = flagValue(flags, "sac-scale:");
  const informal = flagValue(flags, "informal:");
  const lifecycle = flags.includes("abandoned:yes")
    ? "abandoned" as const
    : flags.includes("disused:yes")
      ? "disused" as const
      : undefined;
  return {
    ...(highway ? { highway } : {}),
    ...(surface ? { surface } : {}),
    ...(smoothness ? { smoothness } : {}),
    ...(trailVisibility ? { trailVisibility } : {}),
    ...(sacScale ? { sacScale } : {}),
    ...(informal === "yes" ? { informal: true } : informal === "no" ? { informal: false } : {}),
    ...(lifecycle ? { lifecycle } : {}),
  };
}

function sourceFeatureIdFor(flags: readonly string[]): string | undefined {
  return flagValue(flags, "osm-feature:");
}

function segmentKey(edge: ReconstructedDirectedEdge): string {
  const condition = conditionFor(edge.flags);
  const identity = edge.trailName
    ? `name:${edge.trailName}`
    : sourceFeatureIdFor(edge.flags)
      ? `feature:${sourceFeatureIdFor(edge.flags)}`
      : "unnamed";
  return JSON.stringify([identity, edge.accessState, condition]);
}

function appendCoordinates(
  current: GeneratedTrailSegment["geometry"]["coordinates"],
  next: ReconstructedDirectedEdge["coordinates"],
): void {
  const last = current.at(-1);
  const startIndex = last && next[0]?.[0] === last[0] && next[0]?.[1] === last[1] ? 1 : 0;
  for (let index = startIndex; index < next.length; index += 1) {
    const coordinate = next[index];
    if (coordinate) current.push([coordinate[0], coordinate[1]]);
  }
}

/**
 * Groups only consecutive route edges. A named trail stays together across OSM
 * way splits while condition changes form explicit segment boundaries. Unnamed
 * trails use their source feature when available and otherwise fall back to a
 * contiguous run, keeping old packs and synthetic fixtures useful.
 */
export function trailSegmentsForRoute(
  routeId: string,
  edges: readonly ReconstructedDirectedEdge[],
): GeneratedTrailSegment[] {
  const segments: GeneratedTrailSegment[] = [];
  let routeDistanceMeters = 0;
  let previousKey: string | undefined;

  for (const edge of edges) {
    const key = segmentKey(edge);
    const previous = segments.at(-1);
    if (previous && key === previousKey) {
      appendCoordinates(previous.geometry.coordinates, edge.coordinates);
      previous.distanceMeters += edge.lengthMeters;
      previous.endDistanceMeters += edge.lengthMeters;
      previous.sourceIds = [...new Set([...previous.sourceIds, ...edge.sourceIds])].sort();
      if (previous.sourceFeatureId !== sourceFeatureIdFor(edge.flags)) {
        delete previous.sourceFeatureId;
      }
    } else {
      const sourceFeatureId = sourceFeatureIdFor(edge.flags);
      segments.push({
        id: `${routeId}:segment:${segments.length + 1}`,
        geometry: {
          type: "LineString",
          coordinates: edge.coordinates.map(([lon, lat]) => [lon, lat]),
        },
        name: edge.trailName,
        distanceMeters: edge.lengthMeters,
        startDistanceMeters: routeDistanceMeters,
        endDistanceMeters: routeDistanceMeters + edge.lengthMeters,
        accessState: edge.accessState,
        condition: conditionFor(edge.flags),
        ...(sourceFeatureId ? { sourceFeatureId } : {}),
        sourceIds: [...new Set(edge.sourceIds)].sort(),
      });
      previousKey = key;
    }
    routeDistanceMeters += edge.lengthMeters;
  }

  return segments;
}
