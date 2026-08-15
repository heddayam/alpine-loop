import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { SourceSnapshot } from "../adapters";
import type { Coordinate } from "../types";
import type { OfficialTrailFeature } from "./types";

const coordinateSchema = z.tuple([z.number().finite(), z.number().finite()]);
const geometrySchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("LineString"), coordinates: z.array(coordinateSchema).min(2) }),
  z.object({ type: z.literal("MultiLineString"), coordinates: z.array(z.array(coordinateSchema).min(2)).min(1) }),
]);
const featureSchema = z.object({
  type: z.literal("Feature"),
  properties: z.record(z.string(), z.unknown()),
  geometry: geometrySchema,
});
const collectionSchema = z.object({
  type: z.literal("FeatureCollection"),
  features: z.array(featureSchema),
});

function text(properties: Record<string, unknown>, key: string): string | null {
  const value = properties[key];
  return typeof value === "string" && value.trim() ? value.trim() : typeof value === "number" ? String(value) : null;
}

function featureId(properties: Record<string, unknown>, index: number): string {
  return text(properties, "permanentidentifier")
    ?? text(properties, "globalid")
    ?? text(properties, "sourcefeatureid")
    ?? text(properties, "objectid")
    ?? `feature-${index}`;
}

function parts(geometry: z.infer<typeof geometrySchema>): Coordinate[][] {
  return geometry.type === "LineString"
    ? [geometry.coordinates as Coordinate[]]
    : geometry.coordinates as Coordinate[][];
}

export const USGS_NATIONAL_DIGITAL_TRAILS_ADAPTER_VERSION = "usgs-national-digital-trails-v1";

export async function readUsgsNationalDigitalTrails(snapshot: SourceSnapshot): Promise<OfficialTrailFeature[]> {
  const collection = collectionSchema.parse(JSON.parse(await readFile(snapshot.localPath, "utf8")));
  return collection.features.flatMap((feature, featureIndex) => {
    const properties = feature.properties;
    const trailType = text(properties, "trailtype");
    const hiker = text(properties, "hikerpedestrian");
    const terrestrial = trailType === "Terra Trail";
    const explicitlyHiking = hiker === "Y" || hiker === "Yes";
    const eligibilityReason = !terrestrial ? "not-terrestrial" : !explicitlyHiking ? "hiking-not-explicit" : null;
    const externalId = featureId(properties, featureIndex);
    const sourceOriginator = text(properties, "sourceoriginator");
    const sourceFeatureId = text(properties, "sourcefeatureid");
    const permanentIdentifier = text(properties, "permanentidentifier");
    return parts(feature.geometry).map((coordinates, partIndex) => ({
      externalId: `${externalId}#${partIndex + 1}`,
      name: text(properties, "name") ?? text(properties, "maplabel"),
      trailNumber: text(properties, "trailnumber"),
      coordinates,
      accessState: "unknown" as const,
      sourceRefs: [snapshot.id],
      flags: [
        "official-trail-conflation",
        `official-trail-feature:${externalId}`,
        ...(sourceFeatureId ? [`official-source-feature:${sourceFeatureId}`] : []),
        ...(permanentIdentifier ? [`official-permanent-id:${permanentIdentifier}`] : []),
        ...(sourceOriginator ? [`official-originator:${sourceOriginator}`] : []),
        ...(trailType ? [`official-trail-type:${trailType}`] : []),
        ...(hiker ? [`official-hiker-pedestrian:${hiker}`] : []),
        ...(text(properties, "trailnumber") ? [`trail-number:${text(properties, "trailnumber")}`] : []),
      ],
      eligible: eligibilityReason === null,
      eligibilityReason,
    }));
  }).sort((first, second) => first.externalId.localeCompare(second.externalId));
}
