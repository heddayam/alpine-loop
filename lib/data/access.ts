import type { AccessState } from "@/lib/graph/types";

const RESTRICTIVE_STATES = new Set<AccessState>(["closed", "prohibited", "private"]);

export type AccessResolution = {
  state: AccessState;
  conflict: boolean;
  source: "official-restriction" | "official-permission" | "osm" | "none";
};

export function reconcileAccess(osmState: AccessState, officialStates: readonly AccessState[]): AccessResolution {
  const restrictions = officialStates.filter((state) => RESTRICTIVE_STATES.has(state));
  const hasPermission = officialStates.includes("public");
  const uniqueRestrictions = new Set(restrictions);
  const conflict = (hasPermission && restrictions.length > 0) || uniqueRestrictions.size > 1;

  if (conflict) {
    return { state: "unknown", conflict: true, source: "none" };
  }
  if (restrictions.includes("closed")) {
    return { state: "closed", conflict: false, source: "official-restriction" };
  }
  if (restrictions.includes("prohibited")) {
    return { state: "prohibited", conflict: false, source: "official-restriction" };
  }
  if (restrictions.includes("private")) {
    return { state: "private", conflict: false, source: "official-restriction" };
  }
  if (hasPermission) {
    return { state: "public", conflict: false, source: "official-permission" };
  }
  if (osmState !== "unknown") {
    return { state: osmState, conflict: false, source: "osm" };
  }
  return { state: "unknown", conflict: false, source: "none" };
}
