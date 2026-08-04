import type { NormalizedAccessEvidence, OfficialAccessAdapter, SourceSnapshot } from "../adapters";
import { readValidatedSnapshot } from "../file-source";
import type { OfficialAccessJoinFeature } from "./types";

export const SAN_MATEO_COUNTY_GEOJSON_URL = "https://data.smcgov.org/resource/pap8-kg7r.geojson?$limit=50000";

type GeoJsonFeature = {
  id?: string | number;
  properties: Record<string, unknown>;
  geometry: { type: "LineString" | "MultiLineString"; coordinates: number[][] | number[][][] };
};

type FeatureCollection = { type: "FeatureCollection"; features: GeoJsonFeature[] };

function parse(value: unknown): FeatureCollection {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("San Mateo snapshot must be a GeoJSON object");
  const input = value as Partial<FeatureCollection>;
  if (input.type !== "FeatureCollection" || !Array.isArray(input.features)) throw new Error("San Mateo snapshot must be a GeoJSON FeatureCollection");
  if (input.features.length === 0) throw new Error("San Mateo County trails source is empty");
  return input as FeatureCollection;
}

function point(feature: GeoJsonFeature): [number, number] {
  if (!feature.geometry || !["LineString", "MultiLineString"].includes(feature.geometry.type)) {
    throw new Error("San Mateo trail feature has an unexpected geometry type");
  }
  const coordinates = feature.geometry.type === "LineString"
    ? feature.geometry.coordinates as number[][]
    : (feature.geometry.coordinates as number[][][]).flat();
  const coordinate = coordinates[Math.floor(coordinates.length / 2)];
  if (!coordinate || !Number.isFinite(coordinate[0]) || !Number.isFinite(coordinate[1])) {
    throw new Error("San Mateo trail feature has invalid geometry");
  }
  return [coordinate[0], coordinate[1]];
}

/**
 * Adapter retained for fail-loud monitoring. The official Socrata view has
 * advertised zero columns and returned empty geometries since inspection on
 * 2026-08-04, so it is not enabled in a pack until the county repairs it.
 */
export class SanMateoCountyParksAccessAdapter implements OfficialAccessAdapter {
  readonly adapterVersion = "san-mateo-socrata-v1";

  private async read(snapshot: SourceSnapshot): Promise<FeatureCollection> {
    if (snapshot.authority !== "San Mateo County" || snapshot.dataset !== "San Mateo County trails") {
      throw new Error("Source identity does not match San Mateo County trails");
    }
    if (snapshot.url !== SAN_MATEO_COUNTY_GEOJSON_URL) throw new Error("Source URL does not match pinned San Mateo endpoint");
    return parse(await readValidatedSnapshot(snapshot));
  }

  async validate(snapshot: SourceSnapshot): Promise<void> { await this.read(snapshot); }

  async normalize(snapshot: SourceSnapshot): Promise<NormalizedAccessEvidence[]> {
    return (await this.normalizeForJoin(snapshot)).map(({ evidence }) => evidence);
  }

  async normalizeForJoin(snapshot: SourceSnapshot): Promise<OfficialAccessJoinFeature[]> {
    const input = await this.read(snapshot);
    const ids = new Set<string>();
    return input.features.map((feature, index) => {
      if (!feature.properties || typeof feature.properties !== "object") throw new Error(`San Mateo feature ${index} has no properties`);
      const id = String(feature.id ?? feature.properties.id ?? "").trim();
      if (!id) throw new Error(`San Mateo feature ${index} has no documented stable ID`);
      if (ids.has(id)) throw new Error(`San Mateo snapshot contains duplicate stable ID ${id}`);
      ids.add(id);
      const [lon, lat] = point(feature);
      return {
        sourceId: snapshot.id,
        authorityFeatureId: id,
        geometry: feature.geometry,
        evidence: {
          sourceId: snapshot.id,
          externalId: id,
          lon,
          lat,
          name: String(feature.properties.name ?? id),
          accessState: "unknown",
          confidence: "medium",
        },
      };
    });
  }
}
