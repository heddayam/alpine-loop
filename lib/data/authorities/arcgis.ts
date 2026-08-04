import type { AccessState } from "@/lib/graph/types";
import type { NormalizedAccessEvidence, OfficialAccessAdapter, SourceSnapshot } from "../adapters";
import { readValidatedSnapshot } from "../file-source";
import type { OfficialAccessJoinFeature } from "./types";

type ArcGisField = { name: string; type: string };
type ArcGisGeometry = { paths: number[][][] };
type ArcGisFeature = { attributes: Record<string, unknown>; geometry: ArcGisGeometry };
type ArcGisQuerySnapshot = {
  objectIdFieldName?: string;
  globalIdFieldName?: string;
  geometryType: string;
  spatialReference: { wkid?: number; latestWkid?: number };
  fields: ArcGisField[];
  features: ArcGisFeature[];
  exceededTransferLimit?: boolean;
};

export type ArcGisAuthorityDefinition = {
  authority: string;
  dataset: string;
  queryUrl: string;
  objectIdField: string;
  stableIdField: string;
  nameField: string;
  expectedFields: Record<string, string>;
  resolve(attributes: Record<string, unknown>): AccessState;
};

function assertRecord(value: unknown, context: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${context} must be an object`);
}

function parseSnapshot(value: unknown): ArcGisQuerySnapshot {
  assertRecord(value, "ArcGIS snapshot");
  if (value.geometryType !== "esriGeometryPolyline") throw new Error(`Unexpected ArcGIS geometry type ${String(value.geometryType)}`);
  assertRecord(value.spatialReference, "ArcGIS spatial reference");
  const spatialReference = value.spatialReference as ArcGisQuerySnapshot["spatialReference"];
  if (spatialReference.wkid !== 4326 && spatialReference.latestWkid !== 4326) {
    throw new Error(`Unexpected ArcGIS CRS ${String(spatialReference.latestWkid ?? spatialReference.wkid)}`);
  }
  if (!Array.isArray(value.fields)) throw new Error("ArcGIS snapshot is missing field metadata");
  if (!Array.isArray(value.features) || value.features.length === 0) throw new Error("ArcGIS snapshot is empty");
  if (value.exceededTransferLimit === true) throw new Error("ArcGIS snapshot exceeded the service transfer limit");
  return value as ArcGisQuerySnapshot;
}

function representativeCoordinate(geometry: ArcGisGeometry): [number, number] {
  if (!geometry || !Array.isArray(geometry.paths) || geometry.paths.length === 0) throw new Error("ArcGIS feature has no paths");
  const coordinates = geometry.paths.flat();
  if (coordinates.length < 2) throw new Error("ArcGIS feature path has fewer than two coordinates");
  const point = coordinates[Math.floor(coordinates.length / 2)];
  if (!Array.isArray(point) || point.length < 2 || !Number.isFinite(point[0]) || !Number.isFinite(point[1])) {
    throw new Error("ArcGIS feature has an invalid coordinate");
  }
  return [point[0], point[1]];
}

function geoJsonGeometry(geometry: ArcGisGeometry): OfficialAccessJoinFeature["geometry"] {
  if (!geometry || !Array.isArray(geometry.paths) || geometry.paths.length === 0) throw new Error("ArcGIS feature has no paths");
  for (const path of geometry.paths) {
    if (!Array.isArray(path) || path.length < 2 || path.some((coordinate) => !Array.isArray(coordinate)
      || coordinate.length < 2 || !Number.isFinite(coordinate[0]) || !Number.isFinite(coordinate[1]))) {
      throw new Error("ArcGIS feature has invalid path geometry");
    }
  }
  return geometry.paths.length === 1
    ? { type: "LineString", coordinates: geometry.paths[0] }
    : { type: "MultiLineString", coordinates: geometry.paths };
}

export class ArcGisOfficialAccessAdapter implements OfficialAccessAdapter {
  readonly adapterVersion = "arcgis-official-access-v1";

  constructor(readonly definition: ArcGisAuthorityDefinition) {}

  private async read(snapshot: SourceSnapshot): Promise<ArcGisQuerySnapshot> {
    if (snapshot.authority !== this.definition.authority || snapshot.dataset !== this.definition.dataset) {
      throw new Error(`Source identity does not match ${this.definition.authority} / ${this.definition.dataset}`);
    }
    if (snapshot.url !== this.definition.queryUrl) throw new Error(`Source URL does not match pinned endpoint for ${snapshot.id}`);
    const input = parseSnapshot(await readValidatedSnapshot(snapshot));
    const fields = new Map(input.fields.map((field) => [field.name, field.type]));
    for (const [name, type] of Object.entries(this.definition.expectedFields)) {
      if (!fields.has(name)) throw new Error(`ArcGIS schema drift: missing documented field ${name}`);
      if (fields.get(name) !== type) throw new Error(`ArcGIS schema drift: field ${name} changed from ${type} to ${fields.get(name)}`);
    }
    if (input.objectIdFieldName && input.objectIdFieldName !== this.definition.objectIdField) {
      throw new Error(`ArcGIS schema drift: object ID changed to ${input.objectIdFieldName}`);
    }
    return input;
  }

  async validate(snapshot: SourceSnapshot): Promise<void> {
    await this.read(snapshot);
  }

  async normalize(snapshot: SourceSnapshot): Promise<NormalizedAccessEvidence[]> {
    return (await this.normalizeForJoin(snapshot)).map(({ evidence }) => evidence);
  }

  async normalizeForJoin(snapshot: SourceSnapshot): Promise<OfficialAccessJoinFeature[]> {
    const input = await this.read(snapshot);
    const ids = new Set<string>();
    return input.features.map((feature, index) => {
      assertRecord(feature.attributes, `ArcGIS feature ${index} attributes`);
      for (const name of Object.keys(this.definition.expectedFields)) {
        if (!(name in feature.attributes)) throw new Error(`ArcGIS feature ${index} is missing documented field ${name}`);
      }
      const id = String(feature.attributes[this.definition.stableIdField] ?? "").trim();
      if (!id) throw new Error(`ArcGIS feature ${index} has no stable ID`);
      if (ids.has(id)) throw new Error(`ArcGIS snapshot contains duplicate stable ID ${id}`);
      ids.add(id);
      const [lon, lat] = representativeCoordinate(feature.geometry);
      return {
        sourceId: snapshot.id,
        authorityFeatureId: id,
        geometry: geoJsonGeometry(feature.geometry),
        evidence: {
          sourceId: snapshot.id,
          externalId: id,
          lon,
          lat,
          name: String(feature.attributes[this.definition.nameField] ?? id).trim() || id,
          accessState: this.definition.resolve(feature.attributes),
          confidence: "high" as const,
        },
      };
    });
  }
}

export function documentedValue(
  attributes: Record<string, unknown>,
  field: string,
  allowed: readonly string[],
): string | null {
  const raw = attributes[field];
  if (raw === null || raw === undefined || raw === "") return null;
  if (typeof raw !== "string" || !allowed.includes(raw)) {
    throw new Error(`Undocumented ${field} value ${JSON.stringify(raw)}`);
  }
  return raw;
}
