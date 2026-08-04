import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { AccessState } from "@/lib/graph/types";
import type { NormalizedAccessPoint, NormalizedNode, NormalizedTopology, NormalizedWay } from "../types";

const featureSchema = z.object({
  type: z.literal("Feature"),
  id: z.union([z.string(), z.number()]).optional(),
  properties: z.record(z.string(), z.unknown()).default({}),
  geometry: z.discriminatedUnion("type", [
    z.object({ type: z.literal("Point"), coordinates: z.tuple([z.number().finite(), z.number().finite()]) }).strict(),
    z.object({ type: z.literal("LineString"), coordinates: z.array(z.tuple([z.number().finite(), z.number().finite()])).min(2) }).strict(),
  ]),
}).passthrough();

const PEDESTRIAN_HIGHWAYS = new Set([
  "path", "footway", "track", "pedestrian", "steps", "bridleway",
]);
const ROAD_CONNECTORS = new Set(["service", "unclassified", "residential", "living_street"]);

export function osmWayIsHikingRelevant(values: Record<string, string>): boolean {
  const highway = values.highway ?? "";
  if (PEDESTRIAN_HIGHWAYS.has(highway)) return true;
  if (!ROAD_CONNECTORS.has(highway)) return false;
  return ["yes", "designated", "permissive", "public"].includes(values.foot ?? "")
    || /(?:^|\s)(trail|path|walk)(?:\s|$)/i.test(values.name ?? "");
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
  const accessPoints: NormalizedAccessPoint[] = [];
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
      if (!osmWayIsHikingRelevant(values)) {
        rejectedWayCount += 1;
        return;
      }
      let coordinates = feature.geometry.coordinates.map((coordinate) => coordinate as readonly [number, number]);
      const wayDirection = osmFootDirection(values);
      if (wayDirection === "reverse") coordinates = [...coordinates].reverse();
      const wayNodes = coordinates.map(ensureNode);
      ways.push({
        id: `osm-${featureExternalId.replace("/", "-")}`,
        externalId: featureExternalId,
        nodeIds: wayNodes.map(({ id }) => id),
        coordinates,
        name: values.name ?? null,
        accessState: osmAccessState(values),
        bidirectional: wayDirection === "both",
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

    const kind = values.highway === "trailhead" ? "trailhead" : values.amenity === "parking" ? "parking" : null;
    if (!kind) return;
    const node = ensureNode(feature.geometry.coordinates);
    accessPoints.push({
      id: `osm-access-${featureExternalId.replace("/", "-")}`,
      externalId: featureExternalId,
      nodeId: node.id,
      name: values.name ?? `OSM ${kind}`,
      kind,
      accessState: osmAccessState(values),
      confidence: values.foot || values.access ? "medium" : "low",
      parkingEvidence: kind === "parking" ? "osm:amenity=parking" : null,
      sourceRefs: [sourceId],
    });
  });

  if (ways.length === 0) throw new Error("OSM extraction produced no supported pedestrian ways");
  return { nodes: [...nodes.values()], ways, accessPoints, rejectedWayCount };
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
