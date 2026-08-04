import type { AccessState } from "@/lib/graph/types";
import type { OfficialAccessResolution } from "./types";

const RESTRICTED = new Set<AccessState>(["closed", "prohibited", "private"]);

/** Mirrors the pack policy without weakening an existing restriction. */
export function resolveAccessEvidence(
  osmState: AccessState,
  officialStates: readonly AccessState[],
): OfficialAccessResolution {
  const restrictions = new Set(officialStates.filter((state) => RESTRICTED.has(state)));
  const hasPermission = officialStates.includes("public");
  if (restrictions.size > 1 || (restrictions.size > 0 && hasPermission)) {
    return { state: "unknown", conflict: true, winningTier: "unknown" };
  }
  const [restriction] = restrictions;
  if (restriction) return { state: restriction, conflict: false, winningTier: "official-restriction" };
  if (hasPermission) return { state: "public", conflict: false, winningTier: "official-permission" };
  if (osmState !== "unknown") return { state: osmState, conflict: false, winningTier: "osm" };
  return { state: "unknown", conflict: false, winningTier: "unknown" };
}
