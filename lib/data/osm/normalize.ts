import type { AccessState } from "@/lib/graph/types";
import type { EdgeClass, NormalizedPortalEvidence } from "../types";

const TRAIL_HIGHWAYS = new Set(["path", "bridleway", "steps"]);
const LEGACY_WALKING_CONNECTORS = new Set(["service", "unclassified", "residential", "living_street"]);
const STREET_HIGHWAYS = new Set([
  "motorway", "motorway_link",
  "trunk", "trunk_link",
  "primary", "primary_link",
  "secondary", "secondary_link",
  "tertiary", "tertiary_link",
  "unclassified", "residential", "living_street", "road",
]);
const SIDEWALK_SUBTAGS = new Set(["sidewalk", "crossing", "traffic_island", "access_aisle", "link"]);
const AFFIRMATIVE_MOTOR_ACCESS = new Set([
  "yes", "designated", "permissive", "public", "destination", "customers", "agricultural", "forestry",
]);
const TRAIL_SURFACES = new Set([
  "dirt", "earth", "fine_gravel", "grass", "ground", "mud", "pebblestone", "rock", "sand", "unpaved", "wood",
]);
const INFORMATION_VALUES = new Set(["guidepost", "board", "map"]);

function hasTrailContext(values: Record<string, string>): boolean {
  return values.footway === "trail"
    || values.trail_visibility !== undefined
    || values.sac_scale !== undefined
    || values.informal === "yes"
    || TRAIL_SURFACES.has(values.surface ?? "")
    || /(?:^|\s)(trail|path)(?:\s|$)/i.test(values.name ?? "");
}

export function needsTrailContext(values: Record<string, string>): boolean {
  return (values.highway === "footway" || values.highway === "pedestrian")
    && !SIDEWALK_SUBTAGS.has(values.footway ?? "")
    && !hasTrailContext(values);
}

type ContextualWay = {
  id: string;
  nodeIds: readonly string[];
  values: Record<string, string>;
};

/**
 * Promotes only connected components of otherwise ambiguous footways that
 * actually attach to an explicit trail. Explicit sidewalk/crossing subtags
 * never enter this inference.
 */
export function contextualTrailWayIds(ways: readonly ContextualWay[]): ReadonlySet<string> {
  const explicitTrailNodes = new Set<string>();
  const ambiguousByNode = new Map<string, string[]>();
  const ambiguousById = new Map<string, ContextualWay>();
  for (const way of ways) {
    if (needsTrailContext(way.values)) {
      ambiguousById.set(way.id, way);
      for (const nodeId of new Set(way.nodeIds)) {
        const existing = ambiguousByNode.get(nodeId);
        if (existing) existing.push(way.id);
        else ambiguousByNode.set(nodeId, [way.id]);
      }
      continue;
    }
    if (classifyOsmWay(way.values) === "trail") {
      for (const nodeId of way.nodeIds) explicitTrailNodes.add(nodeId);
    }
  }

  const promoted = new Set<string>();
  const visited = new Set<string>();
  for (const startId of [...ambiguousById.keys()].sort()) {
    if (visited.has(startId)) continue;
    const componentIds: string[] = [];
    const componentNodes = new Set<string>();
    const stack = [startId];
    visited.add(startId);
    while (stack.length > 0) {
      const id = stack.pop()!;
      componentIds.push(id);
      const way = ambiguousById.get(id)!;
      for (const nodeId of way.nodeIds) {
        componentNodes.add(nodeId);
        for (const neighborId of ambiguousByNode.get(nodeId) ?? []) {
          if (visited.has(neighborId)) continue;
          visited.add(neighborId);
          stack.push(neighborId);
        }
      }
    }
    if ([...componentNodes].some((nodeId) => explicitTrailNodes.has(nodeId))) {
      for (const id of componentIds) promoted.add(id);
    }
  }
  return promoted;
}

function hasAffirmativeMotorVehicleEvidence(values: Record<string, string>): boolean {
  const motorAccess = values.motor_vehicle ?? values.vehicle ?? values.access;
  return AFFIRMATIVE_MOTOR_ACCESS.has(motorAccess ?? "");
}

function wasWalkingConnector(values: Record<string, string>): boolean {
  return LEGACY_WALKING_CONNECTORS.has(values.highway ?? "") && (
    ["yes", "designated", "permissive", "public"].includes(values.foot ?? "")
    || /(?:^|\s)(trail|path|walk)(?:\s|$)/i.test(values.name ?? "")
  );
}

/** Classify OSM ways once at the adapter boundary; null means no graph context is retained. */
export function classifyOsmWay(values: Record<string, string>): EdgeClass | null {
  const highway = values.highway ?? "";
  if (wasWalkingConnector(values)) return "trail";
  if (SIDEWALK_SUBTAGS.has(values.footway ?? "")) {
    return "sidewalk";
  }
  if (TRAIL_HIGHWAYS.has(highway)) return "trail";
  if (highway === "track") {
    return hasAffirmativeMotorVehicleEvidence(values) && values.foot === "no" ? "service-road" : "trail";
  }
  if (highway === "footway") return hasTrailContext(values) ? "trail" : "sidewalk";
  if (highway === "pedestrian") return hasTrailContext(values) ? "trail" : "sidewalk";
  if (highway === "service") return "service-road";
  if (STREET_HIGHWAYS.has(highway)) return "street";
  return null;
}

export function osmPortalEvidenceKinds(values: Record<string, string>): NormalizedPortalEvidence["kind"][] {
  const kinds: NormalizedPortalEvidence["kind"][] = [];
  if (values.amenity === "parking") kinds.push("parking");
  if (values.highway === "trailhead" || values.information === "trailhead") kinds.push("trailhead");
  if (INFORMATION_VALUES.has(values.information ?? "") || values.tourism === "information") kinds.push("information");
  if (values.barrier === "gate") kinds.push("gate");
  return kinds;
}

export function osmAccessState(values: Record<string, string>): AccessState {
  const access = values.foot ?? values.access;
  if (["no", "agricultural", "forestry"].includes(access ?? "")) return "prohibited";
  if (["private", "customers", "destination"].includes(access ?? "")) return "private";
  if (["yes", "designated", "permissive", "public"].includes(access ?? "")) return "public";
  return "unknown";
}

export function osmFootDirection(values: Record<string, string>): "forward" | "reverse" | "both" {
  const footOneway = values["oneway:foot"] ?? values.oneway;
  if (footOneway === "-1") return "reverse";
  if (footOneway === "yes" || footOneway === "1" || values["foot:backward"] === "no") return "forward";
  if (values["foot:forward"] === "no" && values["foot:backward"] !== "no") return "reverse";
  return "both";
}

export function osmWayFlags(
  values: Record<string, string>,
  featureId: string,
  direction: ReturnType<typeof osmFootDirection>,
): string[] {
  return [
    `osm-feature:${featureId}`,
    `osm-highway:${values.highway}`,
    ...(direction === "both" ? [] : [direction === "reverse" ? "oneway-reversed" : "oneway"]),
    ...(values.surface ? [`surface:${values.surface}`] : []),
    ...(values.smoothness ? [`smoothness:${values.smoothness}`] : []),
    ...(values.trail_visibility ? [`trail-visibility:${values.trail_visibility}`] : []),
    ...(values.sac_scale ? [`sac-scale:${values.sac_scale}`] : []),
    ...(values.informal ? [`informal:${values.informal}`] : []),
    ...(values.disused === "yes" ? ["disused:yes"] : []),
    ...(values.abandoned === "yes" ? ["abandoned:yes"] : []),
  ];
}
