import type { AccessState, GraphAccessPoint, GraphEdge } from "./types";

const NEVER_TRAVERSABLE = new Set<AccessState>(["private", "closed", "prohibited"]);
const NON_PEDESTRIAN_FLAGS = new Set(["non-pedestrian", "pedestrian:no", "foot:no", "legal:no"]);

export function accessStateIsAllowed(accessState: AccessState, includeUncertainAccess: boolean): boolean {
  if (NEVER_TRAVERSABLE.has(accessState)) return false;
  return accessState === "public" || (accessState === "unknown" && includeUncertainAccess);
}

export function edgeIsTraversable(edge: GraphEdge, includeUncertainAccess: boolean): boolean {
  return (
    accessStateIsAllowed(edge.accessState, includeUncertainAccess) &&
    !edge.flags.some((flag) => NON_PEDESTRIAN_FLAGS.has(flag.toLowerCase()))
  );
}

export function accessPointIsEligible(
  accessPoint: GraphAccessPoint,
  includeUncertainAccess: boolean,
): boolean {
  return accessStateIsAllowed(accessPoint.accessState, includeUncertainAccess);
}
