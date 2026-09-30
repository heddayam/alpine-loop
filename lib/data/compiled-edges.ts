import type { AccessState } from "@/lib/graph/types";
import type { EdgeMetrics } from "./metrics";
import type { CompiledEdge, Coordinate, NormalizedWay } from "./types";

const FOOT_ACCESS_ORDER: readonly AccessState[] = ["public", "unknown", "private", "prohibited", "closed"];

function flagAccessState(accessState: AccessState, flags: readonly string[], prefix: string): AccessState {
  let rank = FOOT_ACCESS_ORDER.indexOf(accessState);
  for (const flag of flags) {
    if (!flag.startsWith(prefix)) continue;
    const stateRank = FOOT_ACCESS_ORDER.indexOf(flag.slice(prefix.length) as AccessState);
    if (stateRank < 0) throw new Error(`Unsupported foot passage state: ${flag}`);
    rank = Math.max(rank, stateRank);
  }
  return FOOT_ACCESS_ORDER[rank]!;
}

/** Oriented flags are relative to normalized node order, after any source reversal. */
export function footWayDirectionAccessState(
  accessState: AccessState,
  wayFlags: readonly string[],
  direction: "forward" | "backward",
): AccessState {
  return flagAccessState(accessState, wayFlags, `foot-${direction}-access:`);
}

/** Actual endpoint crossings constrain movement in either direction, including departures at a gate. */
export function footSegmentAccessState(
  accessState: AccessState,
  nodeFlags: readonly (readonly string[])[],
): AccessState {
  for (const flags of nodeFlags) accessState = flagAccessState(accessState, flags, "foot-access:");
  return accessState;
}

/** One physical source segment, with the same directed IDs and elevation profile in both builders. */
export function compiledEdgesForSegment(
  way: NormalizedWay,
  segment: number,
  geometry: readonly Coordinate[],
  metrics: EdgeMetrics,
  resolved: { accessState?: AccessState; sourceRefs?: readonly string[]; nodeFlags?: readonly (readonly string[])[] } = {},
): CompiledEdge[] {
  const stablePhysicalId = `${way.id}:${segment}`;
  const accessState = resolved.accessState ?? way.accessState;
  const segmentAccess = (direction: "forward" | "backward") => footSegmentAccessState(
    footWayDirectionAccessState(accessState, way.flags, direction), resolved.nodeFlags ?? []);
  const forward: CompiledEdge = {
    id: `${stablePhysicalId}:forward`, stablePhysicalId,
    fromNode: way.nodeIds[segment]!, toNode: way.nodeIds[segment + 1]!,
    geometry: [...geometry], ...metrics,
    accessState: segmentAccess("forward"),
    edgeClass: way.edgeClass ?? "trail",
    sourceRefs: [...(resolved.sourceRefs ?? way.sourceRefs)],
    flags: [...way.flags, ...(way.name ? [`trail-name:${way.name}`] : [])],
  };
  if (!way.bidirectional) return [forward];
  return [forward, {
    ...forward, id: `${stablePhysicalId}:reverse`,
    accessState: segmentAccess("backward"),
    fromNode: forward.toNode, toNode: forward.fromNode,
    geometry: [...geometry].reverse(),
    gainM: metrics.lossM, lossM: metrics.gainM,
    elevationProfile: metrics.elevationProfile?.map(({ distanceMeters, elevationMeters }) => ({
      distanceMeters: metrics.lengthM - distanceMeters, elevationMeters,
    })).reverse() ?? null,
  }];
}
