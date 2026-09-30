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
const MOTOR_MODES = ["motorcar", "motor_vehicle", "vehicle", "access"] as const;
const PERMISSION_KEYS = ["foot", ...MOTOR_MODES];
export const OSM_ARRIVAL_NODE_HIGHWAYS = ["turning_circle"] as const;
export const OSM_PERMISSION_CONTEXT_KEYS = [
  ...PERMISSION_KEYS.flatMap(mode => [mode, `${mode}:conditional`, ...["forward", "backward"].flatMap(direction =>
    [`${mode}:${direction}`, `${mode}:${direction}:conditional`])]),
  ...["oneway", "oneway:foot", "oneway:motorcar", "oneway:motor_vehicle", "oneway:vehicle"].flatMap(key => [key, `${key}:conditional`]),
];
const PERMISSION_CONTEXT_KEYS = new Set(OSM_PERMISSION_CONTEXT_KEYS);
const MOTOR_PERMISSION_CONTEXT_KEYS = OSM_PERMISSION_CONTEXT_KEYS.filter(key => key !== "foot" && !key.startsWith("foot:") && !key.startsWith("oneway"));
const FOOT_NODE_PERMISSION_KEYS = OSM_PERMISSION_CONTEXT_KEYS.filter(key => key === "access" || key.startsWith("access:") || key === "foot" || key.startsWith("foot:") || key === "oneway:foot:conditional");

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
  // An area boundary asserts a place, not a linear walk around its perimeter.
  if (values.area === "yes" && (TRAIL_HIGHWAYS.has(highway) || highway === "footway" || highway === "pedestrian"
    || highway === "track" || WALKING_ROADS.has(highway))) return "sidewalk";
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
  // Generic oneway certifies vehicle direction. On pedestrian ways its foot
  // meaning is ambiguous; retain that uncertainty rather than invent a ban.
  const oneway = values["oneway:foot"];
  let forward = oneway !== "-1";
  let backward = oneway !== "yes" && oneway !== "1";
  if (values["foot:forward"] === "no") forward = false;
  if (values["foot:backward"] === "no") backward = false;
  return { forward, backward };
}

function footState(values: Record<string, string>, direction?: "forward" | "backward"): AccessState {
  const keys = ["foot", "access"].flatMap(mode => direction ? [`${mode}:${direction}`, mode] : [mode]);
  const index = keys.findIndex(key => values[key] !== undefined);
  const conditional = keys.slice(0, index < 0 ? keys.length : index + 1)
    .map(key => `${key}:conditional`).find(key => values[key] !== undefined);
  return accessState(index < 0 ? undefined : values[keys[index]!],
    conditional ? values[conditional] : values["oneway:foot:conditional"]);
}

function directionalStates(values: Record<string, string>): readonly [AccessState, AccessState] {
  const allowed = footDirections(values);
  const pedestrian = TRAIL_HIGHWAYS.has(values.highway ?? "") || values.highway === "footway" || values.highway === "pedestrian";
  return (["forward", "backward"] as const).map(direction => {
    let state = allowed[direction] ? footState(values, direction) : "prohibited";
    if (state !== "public" || !pedestrian || values["oneway:foot"] !== undefined
      || values[`foot:${direction}`] !== undefined || values[`foot:${direction}:conditional`] !== undefined) return state;
    const opposite = direction === "forward" ? values.oneway === "-1" : ["yes", "1"].includes(values.oneway ?? "");
    if (opposite || values["oneway:conditional"] !== undefined || ["reversible", "alternating"].includes(values.oneway ?? "")) state = "unknown";
    return state;
  }) as [AccessState, AccessState];
}

export function osmAccessState(values: Record<string, string>): AccessState {
  // The common field expresses the best available movement. Oriented flags
  // below retain stricter directions so neither compiler nor proof invents one.
  const states = directionalStates(values);
  return ACCESS_ORDER[Math.min(...states.map(state => ACCESS_ORDER.indexOf(state)))]!;
}

export function osmMotorAccessState(values: Record<string, string>): AccessState {
  const keys = MOTOR_MODES;
  const index = keys.findIndex((key) => values[key] !== undefined);
  const key = keys[index];
  const conditional = keys.slice(0, index < 0 ? keys.length : index + 1)
    .map((key) => `${key}:conditional`).find((key) => values[key] !== undefined);
  return accessState(key ? values[key] : undefined, conditional ? values[conditional] : undefined);
}

/** Source direction and mode specificity are resolved before node-order normalization. */
function motorDirectionState(values: Record<string, string>, direction: "forward" | "backward", includeOneway = true): AccessState {
  const keys = MOTOR_MODES.flatMap(mode => [`${mode}:${direction}`, mode]);
  const baseIndex = keys.findIndex(key => values[key] !== undefined);
  const conditionalKey = keys.slice(0, baseIndex < 0 ? keys.length : baseIndex + 1)
    .map(key => `${key}:conditional`).find(key => values[key] !== undefined);
  let state = accessState(baseIndex < 0 ? undefined : values[keys[baseIndex]!], conditionalKey ? values[conditionalKey] : undefined);
  if (!includeOneway) return state;
  const onewayKeys = ["oneway:motorcar", "oneway:motor_vehicle", "oneway:vehicle", "oneway"];
  const onewayIndex = onewayKeys.findIndex(key => values[key] !== undefined);
  const oneway = onewayIndex < 0 ? undefined : values[onewayKeys[onewayIndex]!];
  if ((direction === "forward" && oneway === "-1") || (direction === "backward" && ["yes", "1"].includes(oneway ?? "")))
    return ACCESS_ORDER[Math.max(ACCESS_ORDER.indexOf(state), ACCESS_ORDER.indexOf("prohibited"))]!;
  const conditional = onewayKeys.slice(0, onewayIndex < 0 ? onewayKeys.length : onewayIndex + 1)
    .some(key => values[`${key}:conditional`] !== undefined);
  if (state === "public" && (conditional || ["reversible", "alternating"].includes(oneway ?? ""))) state = "unknown";
  return state;
}

export function osmFootDirection(values: Record<string, string>): "forward" | "reverse" | "both" {
  const { forward, backward } = footDirections(values);
  if (forward && backward) return "both";
  return backward ? "reverse" : "forward";
}

function permissionFlags(values: Record<string, string>, includeUnknownMotor = true): string[] {
  const motorFact = MOTOR_PERMISSION_CONTEXT_KEYS
    .some((key) => values[key] !== undefined);
  const flags = includeUnknownMotor || motorFact ? [`motor-access:${osmMotorAccessState(values)}`] : [];
  for (const key of OSM_PERMISSION_CONTEXT_KEYS)
    if (values[key] !== undefined) flags.push(`osm-${key}:${values[key]}`);
  return flags;
}

/** Object access (a private information board or parking POI) is not a crossing rule. */
export function osmNodeFlags(values: Record<string, string>): string[] {
  // Most referenced geometry nodes have no tags or crossing facts at all.
  if (Object.keys(values).length === 0) return [];
  const barrier = values.barrier && values.barrier !== "no";
  const trailhead = values.highway === "trailhead" || values.information === "trailhead";
  const object = INFORMATION_VALUES.has(values.information ?? "") || values.tourism === "information"
    || values.amenity === "parking" || Boolean(values.building && values.building !== "no");
  const footRule = FOOT_NODE_PERMISSION_KEYS
    .some((key) => values[key] !== undefined);
  // Node directional tags have no incident-way orientation. Retain a known
  // restriction at the crossing rather than guessing which turns it controls.
  const nodeAccess = ACCESS_ORDER[Math.max(...[footState(values), footState(values, "forward"), footState(values, "backward")]
    .map(state => ACCESS_ORDER.indexOf(state)))]!;
  const nodeMotor = ACCESS_ORDER[Math.max(...[osmMotorAccessState(values), motorDirectionState(values, "forward", false), motorDirectionState(values, "backward", false)]
    .map(state => ACCESS_ORDER.indexOf(state)))]!;
  const permissions = permissionFlags(values, false);
  const motorRule = permissions.some(flag => flag.startsWith("motor-access:"));
  return [
    ...(values.highway === "turning_circle" ? ["arrival-place:turning-circle"] : []),
    ...(barrier ? [`barrier:${values.barrier}`] : []),
    ...(footRule && (barrier || trailhead || !object) ? [`foot-access:${nodeAccess}`] : []),
    ...permissions.filter(flag => !flag.startsWith("motor-access:")),
    ...(motorRule && (barrier || trailhead || !object) ? [`motor-access:${nodeMotor}`] : []),
  ];
}

export function hasOsmNodeContext(values: Record<string, string>): boolean {
  return OSM_ARRIVAL_NODE_HIGHWAYS.some(highway => values.highway === highway) || values.barrier !== undefined || Object.keys(values).some((key) =>
    PERMISSION_CONTEXT_KEYS.has(key)
    || key.endsWith(":conditional"));
}

/** A place assertion's own foot rule is separate from car/parking certainty. */
export function osmEvidenceFlags(values: Record<string,string>): string[] {
  const declared=Object.keys(values).some(key=>key==="access"||key.startsWith("access:")||key==="foot"||key.startsWith("foot:"));
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
  const motorStates = [motorDirectionState(values, "forward"), motorDirectionState(values, "backward")];
  if (direction === "reverse") motorStates.reverse();
  const hasDirectionalMotor = motorStates.some(state => state !== osmMotorAccessState(values));
  const hasDirectionalAccess = ["foot", "access"].flatMap(mode => ["forward", "backward"].flatMap(direction => [`${mode}:${direction}`, `${mode}:${direction}:conditional`]))
    .some(key => values[key] !== undefined) || oriented[0] !== oriented[1];
  return [
    `osm-feature:${featureId}`,
    `osm-highway:${values.highway}`,
    ...permissionFlags(values),
    ...(hasDirectionalMotor ? [`motor-forward-access:${motorStates[0]}`, `motor-backward-access:${motorStates[1]}`] : []),
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
