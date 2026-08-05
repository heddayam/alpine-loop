import { constants } from "node:fs";
import { access, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { NamedAreaSourceAdapter, SourceSnapshot } from "../adapters";
import { areaGeometryBounds, assertValidAreaGeometry } from "../area-geometry";
import { aliasesFromOsmTags, osmNamedAreaKind, validateAndSortNamedAreas } from "../named-areas";
import { withAtomicDirectory } from "../source-cache";
import type { NormalizedNamedArea } from "../types";
import { runCommand } from "./command";
import { preparedOsmRegionPath, type OsmPipelineOptions } from "./pipeline";

const ADAPTER_VERSION = "osmium-named-areas-v1";
const AREA_FILTERS = [
  "wr/boundary=administrative,protected_area,national_park",
  "wr/leisure=park,nature_reserve",
  "wr/landuse=conservation",
  "wr/protect_class",
] as const;

const featureCollectionSchema = z.object({
  type: z.literal("FeatureCollection"),
  features: z.array(z.object({
    type: z.literal("Feature"),
    id: z.union([z.string(), z.number()]).optional(),
    properties: z.record(z.string(), z.unknown()).nullable().optional(),
    geometry: z.unknown(),
  }).passthrough()),
}).passthrough();

function stringProperties(properties: Record<string, unknown> | null | undefined): Record<string, string> {
  return Object.fromEntries(Object.entries(properties ?? {})
    .filter(([, value]) => typeof value === "string" || typeof value === "number")
    .map(([key, value]) => [key, String(value)]));
}

function externalId(featureId: string | number | undefined, properties: Record<string, string>): string {
  const raw = properties["@id"] ?? String(featureId ?? "");
  if (/^[rwn]\d+$/.test(raw)) {
    const kind = raw[0] === "r" ? "relation" : raw[0] === "w" ? "way" : "node";
    return `${kind}/${raw.slice(1)}`;
  }
  if (/^(relation|way)\/\d+$/.test(raw)) return raw;
  const type = properties["@type"] ?? properties.osm_type;
  const id = properties.osm_id ?? raw;
  if (["relation", "way"].includes(type ?? "") && /^\d+$/.test(id)) return `${type}/${id}`;
  throw new Error(`OSM named-area feature has no stable relation/way ID: ${raw || "missing"}`);
}

export function normalizeOsmNamedAreaGeoJson(contents: string, sourceId: string): NormalizedNamedArea[] {
  const collection = featureCollectionSchema.parse(JSON.parse(contents));
  const areas: NormalizedNamedArea[] = [];
  for (const feature of collection.features) {
    const tags = stringProperties(feature.properties);
    const kind = osmNamedAreaKind(tags);
    if (!kind) continue;
    const name = tags.name?.trim();
    if (!name) continue;
    const geometry = assertValidAreaGeometry(feature.geometry, `OSM named area ${name}`);
    const id = externalId(feature.id, tags);
    const addressContext = [tags["addr:county"], tags["addr:state"]].filter(Boolean).join(", ");
    const context = tags.is_in ?? (addressContext || undefined);
    areas.push({
      id: `osm:${id}`,
      name,
      kind,
      ...(context ? { context } : {}),
      aliases: aliasesFromOsmTags(tags),
      bbox: areaGeometryBounds(geometry),
      geometry,
      sourceIds: [sourceId],
    });
  }
  return validateAndSortNamedAreas(areas, new Set([sourceId]));
}

async function nonempty(filePath: string, label: string): Promise<void> {
  const fileStat = await stat(filePath);
  if (fileStat.size === 0) throw new Error(`${label} was empty`);
}

async function readPrepared(filePath: string): Promise<NormalizedNamedArea[] | null> {
  try {
    await access(filePath, constants.R_OK);
    const value = JSON.parse(await readFile(filePath, "utf8")) as NormalizedNamedArea[];
    return Array.isArray(value) && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

export type OsmNamedAreaOptions = OsmPipelineOptions & {
  namedAreaPreparationRoot?: string;
};

export async function prepareOsmNamedAreas(
  snapshot: SourceSnapshot,
  options: OsmNamedAreaOptions,
): Promise<NormalizedNamedArea[]> {
  const regionPath = await preparedOsmRegionPath(snapshot, options);
  const destination = path.join(
    options.namedAreaPreparationRoot ?? path.join(options.preparationRoot, "named-areas"),
    `${snapshot.contentHash.slice(7, 23)}-${ADAPTER_VERSION}`,
  );
  const normalizedPath = path.join(destination, "named-areas.json");
  const prepared = await readPrepared(normalizedPath);
  if (prepared) return validateAndSortNamedAreas(prepared, new Set([snapshot.id]));

  let result: NormalizedNamedArea[] | null = null;
  await withAtomicDirectory(destination, async (staging) => {
    const filtered = path.join(staging, "named-areas.osm.pbf");
    const geojson = path.join(staging, "named-areas.geojson");
    const runner = options.runner ?? runCommand;
    await runner("osmium", ["tags-filter", regionPath, ...AREA_FILTERS, "--overwrite", "--output", filtered]);
    await nonempty(filtered, "OSM named-area filter");
    await runner("osmium", [
      "export", filtered, "--geometry-types=polygon", "--output-format=geojson",
      "--attributes=type,id",
      "--overwrite", "--output", geojson,
    ]);
    await nonempty(geojson, "OSM named-area export");
    result = normalizeOsmNamedAreaGeoJson(await readFile(geojson, "utf8"), snapshot.id);
    if (result.length === 0) throw new Error("OSM named-area extraction produced no supported named polygons");
    await writeFile(path.join(staging, "named-areas.json"), `${JSON.stringify(result)}\n`, { flag: "wx" });
  });
  if (!result) throw new Error("OSM named-area preparation did not produce named areas");
  return result;
}

export class OsmPbfNamedAreaAdapter implements NamedAreaSourceAdapter {
  readonly adapterVersion = ADAPTER_VERSION;

  constructor(private readonly options: OsmNamedAreaOptions) {}

  async validate(snapshot: SourceSnapshot): Promise<void> {
    await prepareOsmNamedAreas(snapshot, this.options);
  }

  async normalize(snapshot: SourceSnapshot): Promise<NormalizedNamedArea[]> {
    return prepareOsmNamedAreas(snapshot, this.options);
  }
}
