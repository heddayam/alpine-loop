import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { AccessState } from "@/lib/graph/types";
import type {
  EdgeClass,
  NormalizedNode,
  NormalizedPortalEvidence,
  NormalizedTopology,
  NormalizedWay,
} from "../types";

const featureSchema = z.object({
  type: z.literal("Feature"),
  id: z.union([z.string(), z.number()]).optional(),
  properties: z.record(z.string(), z.unknown()).default({}),
  geometry: z.discriminatedUnion("type", [
    z.object({ type: z.literal("Point"), coordinates: z.tuple([z.number().finite(), z.number().finite()]) }).strict(),
    z.object({ type: z.literal("LineString"), coordinates: z.array(z.tuple([z.number().finite(), z.number().finite()])).min(2) }).strict(),
  ]),
}).passthrough();

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

export function osmWayIsHikingRelevant(values: Record<string, string>): boolean {
  return classifyOsmWay(values) !== null;
}

export function osmPortalEvidenceKinds(values: Record<string, string>): NormalizedPortalEvidence["kind"][] {
  const kinds: NormalizedPortalEvidence["kind"][] = [];
  if (values.amenity === "parking") kinds.push("parking");
  if (values.highway === "trailhead" || values.information === "trailhead") kinds.push("trailhead");
  if (INFORMATION_VALUES.has(values.information ?? "") || values.tourism === "information") kinds.push("information");
  if (values.barrier === "gate") kinds.push("gate");
  return kinds;
}

function tags(properties: Record<string, unknown>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(properties)) {
    if (typeof value === "string") result[key] = value;
    else if (typeof value === "number" || typeof value === "boolean") result[key] = String(value);
  }
  return result;
}

export function osmAccessState(values: Record<string, string>): AccessState {
  const access = values.foot ?? values.access;
  if (["no", "agricultural", "forestry"].includes(access ?? "")) return "prohibited";
  if (["private", "customers", "destination"].includes(access ?? "")) return "private";
  if (["yes", "designated", "permissive", "public"].includes(access ?? "")) return "public";
  return "unknown";
}

function coordinateKey([lon, lat]: readonly [number, number]): string {
  return `${lon.toFixed(7)},${lat.toFixed(7)}`;
}

function nodeIdForCoordinate(coordinate: readonly [number, number]): string {
  return `osm-coordinate-${createHash("sha1").update(coordinateKey(coordinate)).digest("hex").slice(0, 20)}`;
}

function externalId(feature: z.infer<typeof featureSchema>, fallback: string): string {
  const properties = tags(feature.properties);
  return properties["@id"] ?? properties.id ?? String(feature.id ?? fallback);
}

export function osmFootDirection(values: Record<string, string>): "forward" | "reverse" | "both" {
  const footOneway = values["oneway:foot"] ?? values.oneway;
  if (footOneway === "-1") return "reverse";
  if (footOneway === "yes" || footOneway === "1" || values["foot:backward"] === "no") return "forward";
  if (values["foot:forward"] === "no" && values["foot:backward"] !== "no") return "reverse";
  return "both";
}

export function normalizeOsmFeatures(
  features: ReadonlyArray<z.infer<typeof featureSchema>>,
  sourceId: string,
): NormalizedTopology {
  const nodes = new Map<string, NormalizedNode>();
  const ways: NormalizedWay[] = [];
  const portalEvidence: NormalizedPortalEvidence[] = [];
  let rejectedWayCount = 0;

  const ensureNode = (coordinate: readonly [number, number]): NormalizedNode => {
    const key = coordinateKey(coordinate);
    const existing = nodes.get(key);
    if (existing) return existing;
    const id = nodeIdForCoordinate(coordinate);
    const node: NormalizedNode = {
      id,
      externalId: id,
      lon: coordinate[0],
      lat: coordinate[1],
      elevationM: null,
      flags: [],
      sourceRefs: [sourceId],
    };
    nodes.set(key, node);
    return node;
  };

  features.forEach((feature, featureIndex) => {
    const values = tags(feature.properties);
    const featureExternalId = externalId(feature, `feature-${featureIndex}`);
    if (feature.geometry.type === "LineString") {
      const coordinates = feature.geometry.coordinates.map((coordinate) => coordinate as readonly [number, number]);
      const evidenceKinds = osmPortalEvidenceKinds(values);
      const evidenceNodes = evidenceKinds.length > 0 ? coordinates.map(ensureNode) : [];
      for (const kind of evidenceKinds) {
        portalEvidence.push({
          id: `osm-evidence-${kind}-${featureExternalId.replace("/", "-")}`,
          externalId: featureExternalId,
          kind,
          name: values.name ?? null,
          nodeIds: evidenceNodes.map(({ id }) => id),
          coordinates,
          accessState: osmAccessState(values),
          sourceRefs: [sourceId],
        });
      }
      const edgeClass = classifyOsmWay(values);
      if (!edgeClass) {
        rejectedWayCount += 1;
        return;
      }
      let directedCoordinates = coordinates;
      const wayDirection = osmFootDirection(values);
      if (wayDirection === "reverse") directedCoordinates = [...coordinates].reverse();
      const wayNodes = directedCoordinates.map(ensureNode);
      ways.push({
        id: `osm-${featureExternalId.replace("/", "-")}`,
        externalId: featureExternalId,
        nodeIds: wayNodes.map(({ id }) => id),
        coordinates: directedCoordinates,
        name: values.name ?? null,
        accessState: osmAccessState(values),
        bidirectional: wayDirection === "both",
        edgeClass,
        sourceRefs: [sourceId],
        flags: [
          `osm-highway:${values.highway}`,
          ...(wayDirection === "both" ? [] : [wayDirection === "reverse" ? "oneway-reversed" : "oneway"]),
          ...(values.surface ? [`surface:${values.surface}`] : []),
          ...(values.sac_scale ? [`sac-scale:${values.sac_scale}`] : []),
        ],
      });
      return;
    }

    const coordinate = feature.geometry.coordinates as readonly [number, number];
    const kinds = osmPortalEvidenceKinds(values);
    if (kinds.length === 0) return;
    const node = ensureNode(coordinate);
    for (const kind of kinds) {
      portalEvidence.push({
        id: `osm-evidence-${kind}-${featureExternalId.replace("/", "-")}`,
        externalId: featureExternalId,
        kind,
        name: values.name ?? null,
        nodeIds: [node.id],
        coordinates: [coordinate],
        accessState: osmAccessState(values),
        sourceRefs: [sourceId],
      });
    }
  });

  if (ways.length === 0) throw new Error("OSM extraction produced no supported ways");
  return { nodes: [...nodes.values()], ways, accessPoints: [], portalEvidence, rejectedWayCount };
}

export async function readOsmGeoJsonSequence(filePath: string): Promise<z.infer<typeof featureSchema>[]> {
  const contents = await readFile(filePath, "utf8");
  const records = contents
    .split(/\r?\n/)
    .map((line) => line.replace(/^\x1e/, "").trim())
    .filter(Boolean);
  if (records.length === 0) throw new Error(`OSM GeoJSON sequence is empty: ${filePath}`);
  return records.map((record, index) => {
    try {
      return featureSchema.parse(JSON.parse(record));
    } catch (error) {
      throw new Error(`Invalid OSM GeoJSON feature at line ${index + 1}`, { cause: error });
    }
  });
}
