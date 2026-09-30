import type { AccessState } from "@/lib/graph/types";
import type { EdgeClass, NormalizedPortalEvidence } from "../types";

const TRAIL_HIGHWAYS = new Set(["path", "bridleway", "steps"]);
const WALKING_ROADS = new Set(["service", "unclassified", "residential", "living_street"]);
const STREET_HIGHWAYS = new Set([
  "motorway", "motorway_link",
  "trunk", "trunk_link",
  "primary", "primary_link",
  "secondary", "secondary_link",
  "tertiary", "tertiary_link",
  "unclassified", "residential", "living_street", "road",
]);
const SIDEWALK_SUBTAGS = new Set(["sidewalk", "crossing", "traffic_island", "access_aisle", "link"]);
const PUBLIC_ACCESS = new Set(["yes", "designated", "permissive", "public"]);
const PURPOSE_ACCESS = new Set(["customers", "destination", "delivery", "agricultural", "forestry"]);
const INFORMATION_VALUES = new Set(["guidepost", "board", "map"]);
const ACCESS_ORDER: readonly AccessState[] = ["public", "unknown", "private", "prohibited", "closed"];

function hasTrailContext(values: Record<string, string>): boolean {
  return values.footway === "trail"
    || values.trail_visibility !== undefined
    || values.sac_scale !== undefined
    || values.informal === "yes";
}

function isWalkingRoad(values: Record<string, string>): boolean {
  return WALKING_ROADS.has(values.highway ?? "") && PUBLIC_ACCESS.has(values.foot ?? "");
}

/** Classify OSM ways once at the adapter boundary; null means no graph context is retained. */
export function classifyOsmWay(values: Record<string, string>): EdgeClass | null {
  const highway = values.highway ?? "";
  if (SIDEWALK_SUBTAGS.has(values.footway ?? "")) return "sidewalk";
  if (values.area === "yes" && (TRAIL_HIGHWAYS.has(highway) || highway === "footway" || highway === "pedestrian")) return "sidewalk";
  // Routing can retain an explicitly walkable road without changing its source role.
  if (isWalkingRoad(values)) return "trail";
  if (TRAIL_HIGHWAYS.has(highway)) return "trail";
  if (highway === "track") return "trail";
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

function accessState(access: string | undefined, conditional: string | undefined): AccessState {
  if (access === "closed") return "closed";
  if (["no", "agricultural", "forestry"].includes(access ?? "")) return "prohibited";
  if (access === "private" || PURPOSE_ACCESS.has(access ?? "")) return "private";
  // A conditional rule is retained verbatim; it cannot certify public passage.
  return PUBLIC_ACCESS.has(access ?? "") && !conditional ? "public" : "unknown";
}

function footDirections(values: Record<string, string>): { forward: boolean; backward: boolean } {
  // Ordinary road and track oneway describes vehicles. Only pedestrian ways
  // inherit the generic tag when no foot-specific direction has been supplied.
  const pedestrian = TRAIL_HIGHWAYS.has(values.highway ?? "")
    || values.highway === "footway" || values.highway === "pedestrian";
  const oneway = values["oneway:foot"] ?? (pedestrian ? values.oneway : undefined);
  let forward = oneway !== "-1";
  let backward = oneway !== "yes" && oneway !== "1";
  if (values["foot:forward"] === "no") forward = false;
  if (values["foot:backward"] === "no") backward = false;
  return { forward, backward };
}

function footState(values: Record<string, string>, direction?: "forward" | "backward"): AccessState {
  const directional = direction ? `foot:${direction}` : undefined;
  return accessState((directional ? values[directional] : undefined) ?? values.foot ?? values.access,
    (directional ? values[`${directional}:conditional`] : undefined)
      ?? values["foot:conditional"] ?? values["oneway:foot:conditional"]
      ?? (values.foot === undefined && (!directional || values[directional] === undefined) ? values["access:conditional"] : undefined));
}

function directionalStates(values: Record<string, string>): readonly [AccessState, AccessState] {
  const allowed = footDirections(values);
  return [allowed.forward ? footState(values, "forward") : "prohibited",
    allowed.backward ? footState(values, "backward") : "prohibited"];
}

export function osmAccessState(values: Record<string, string>): AccessState {
  // The common field expresses the best available movement. Oriented flags
  // below retain stricter directions so neither compiler nor proof invents one.
  const states = directionalStates(values);
  return ACCESS_ORDER[Math.min(...states.map(state => ACCESS_ORDER.indexOf(state)))]!;
}

export function osmMotorAccessState(values: Record<string, string>): AccessState {
  const keys = ["motorcar", "motor_vehicle", "vehicle", "access"];
  const index = keys.findIndex((key) => values[key] !== undefined);
  const key = keys[index];
  const conditional = keys.slice(0, index < 0 ? keys.length : index + 1)
    .map((key) => `${key}:conditional`).find((key) => values[key] !== undefined);
  return accessState(key ? values[key] : undefined, conditional ? values[conditional] : undefined);
}

export function osmFootDirection(values: Record<string, string>): "forward" | "reverse" | "both" {
  const { forward, backward } = footDirections(values);
  if (forward && backward) return "both";
  return backward ? "reverse" : "forward";
}

function permissionFlags(values: Record<string, string>, includeUnknownMotor = true): string[] {
  const motorFact = ["access", "motorcar", "motor_vehicle", "vehicle", "access:conditional", "motorcar:conditional", "motor_vehicle:conditional", "vehicle:conditional"]
    .some((key) => values[key] !== undefined);
  const flags = includeUnknownMotor || motorFact ? [`motor-access:${osmMotorAccessState(values)}`] : [];
  for (const key of ["access", "foot", "motorcar", "motor_vehicle", "vehicle", "foot:forward", "foot:backward", "oneway", "oneway:foot"])
    if (values[key] !== undefined) flags.push(`osm-${key}:${values[key]}`);
  for (const key of ["access:conditional", "foot:conditional", "foot:forward:conditional", "foot:backward:conditional", "motorcar:conditional", "motor_vehicle:conditional", "vehicle:conditional", "oneway:foot:conditional"])
    if (values[key] !== undefined) flags.push(`osm-${key}:${values[key]}`);
  return flags;
}

/** Object access (a private information board or parking POI) is not a crossing rule. */
export function osmNodeFlags(values: Record<string, string>): string[] {
  const barrier = values.barrier && values.barrier !== "no";
  const trailhead = values.highway === "trailhead" || values.information === "trailhead";
  const object = INFORMATION_VALUES.has(values.information ?? "") || values.tourism === "information"
    || values.amenity === "parking" || Boolean(values.building && values.building !== "no");
  const footRule = ["foot", "access", "foot:conditional", "access:conditional", "foot:forward", "foot:backward", "foot:forward:conditional", "foot:backward:conditional", "oneway:foot:conditional"]
    .some((key) => values[key] !== undefined);
  // Node directional tags have no incident-way orientation. Retain a known
  // restriction at the crossing rather than guessing which turns it controls.
  const nodeAccess = ACCESS_ORDER[Math.max(...[footState(values), footState(values, "forward"), footState(values, "backward")]
    .map(state => ACCESS_ORDER.indexOf(state)))]!;
  return [
    ...(barrier ? [`barrier:${values.barrier}`] : []),
    ...(footRule && (barrier || trailhead || !object) ? [`foot-access:${nodeAccess}`] : []),
    ...permissionFlags(values, false),
  ];
}

export function hasOsmNodeContext(values: Record<string, string>): boolean {
  return values.barrier !== undefined || Object.keys(values).some((key) =>
    ["access", "foot", "motorcar", "motor_vehicle", "vehicle", "foot:forward", "foot:backward", "oneway:foot"].includes(key)
    || key.endsWith(":conditional"));
}

/** A place assertion's own foot rule is separate from car/parking certainty. */
export function osmEvidenceFlags(values: Record<string,string>): string[] {
  const declared=Object.keys(values).some(key=>key==="access"||key==="foot"||key.startsWith("foot:")||key==="access:conditional");
  const state=ACCESS_ORDER[Math.max(...[footState(values),footState(values,"forward"),footState(values,"backward")]
    .map(value=>ACCESS_ORDER.indexOf(value)))]!;
  return [...(declared?[`foot-access:${state}`]:[]),...permissionFlags(values,false)];
}

export function osmWayFlags(
  values: Record<string, string>,
  featureId: string,
  direction: ReturnType<typeof osmFootDirection>,
): string[] {
  const footStates = directionalStates(values);
  const oriented = direction === "reverse" ? [...footStates].reverse() : footStates;
  const hasDirectionalAccess = ["foot:forward", "foot:backward", "foot:forward:conditional", "foot:backward:conditional"]
    .some(key => values[key] !== undefined);
  return [
    `osm-feature:${featureId}`,
    `osm-highway:${values.highway}`,
    ...permissionFlags(values),
    ...(hasDirectionalAccess ? [`foot-forward-access:${oriented[0]}`, `foot-backward-access:${oriented[1]}`] : []),
    ...(values.area ? [`area:${values.area}`] : []),
    ...((values.highway === "footway" || values.highway === "pedestrian")
      && !SIDEWALK_SUBTAGS.has(values.footway ?? "") && !hasTrailContext(values) ? ["possible-walking-link"] : []),
    ...(direction === "both" ? [] : [direction === "reverse" ? "oneway-reversed" : "oneway"]),
    ...(!footDirections(values).forward && !footDirections(values).backward ? ["foot-direction:none"] : []),
    ...(values.surface ? [`surface:${values.surface}`] : []),
    ...(values.smoothness ? [`smoothness:${values.smoothness}`] : []),
    ...(values.trail_visibility ? [`trail-visibility:${values.trail_visibility}`] : []),
    ...(values.sac_scale ? [`sac-scale:${values.sac_scale}`] : []),
    ...(values.informal ? [`informal:${values.informal}`] : []),
    ...(values.disused === "yes" ? ["disused:yes"] : []),
    ...(values.abandoned === "yes" ? ["abandoned:yes"] : []),
  ];
}
