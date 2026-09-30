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
  if (SIDEWALK_SUBTAGS.has(values.footway ?? "")) return "sidewalk";
  if (wasWalkingConnector(values)) return "trail";
  if (TRAIL_HIGHWAYS.has(highway)) return "trail";
  if (highway === "track") {
    return hasAffirmativeMotorVehicleEvidence(values) && values.foot === "no" ? "service-road" : "trail";
  }
  if (highway === "footway" || highway === "pedestrian") return "trail";
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
    ...((values.highway === "footway" || values.highway === "pedestrian")
      && !SIDEWALK_SUBTAGS.has(values.footway ?? "") && !hasTrailContext(values) ? ["possible-walking-link"] : []),
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
