import type { AccessState } from "@/lib/graph/types";
import type { EdgeMetrics } from "./metrics";
import type { CompiledEdge, Coordinate, NormalizedWay } from "./types";

/** One physical source segment, with the same directed IDs and elevation profile in both builders. */
export function compiledEdgesForSegment(
  way: NormalizedWay,
  segment: number,
  geometry: readonly Coordinate[],
  metrics: EdgeMetrics,
  resolved: { accessState?: AccessState; sourceRefs?: readonly string[] } = {},
): CompiledEdge[] {
  const stablePhysicalId = `${way.id}:${segment}`;
  const forward: CompiledEdge = {
    id: `${stablePhysicalId}:forward`, stablePhysicalId,
    fromNode: way.nodeIds[segment]!, toNode: way.nodeIds[segment + 1]!,
    geometry: [...geometry], ...metrics,
    accessState: resolved.accessState ?? way.accessState,
    edgeClass: way.edgeClass ?? "trail",
    sourceRefs: [...(resolved.sourceRefs ?? way.sourceRefs)],
    flags: [...way.flags, ...(way.name ? [`trail-name:${way.name}`] : [])],
  };
  if (!way.bidirectional) return [forward];
  return [forward, {
    ...forward, id: `${stablePhysicalId}:reverse`,
    fromNode: forward.toNode, toNode: forward.fromNode,
    geometry: [...geometry].reverse(),
    gainM: metrics.lossM, lossM: metrics.gainM,
    elevationProfile: metrics.elevationProfile?.map(({ distanceMeters, elevationMeters }) => ({
      distanceMeters: metrics.lengthM - distanceMeters, elevationMeters,
    })).reverse() ?? null,
  }];
}
