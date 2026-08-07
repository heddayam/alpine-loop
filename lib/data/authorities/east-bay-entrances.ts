import type { AccessState } from "@/lib/graph/types";
import type { NormalizedAccessEvidence, OfficialAccessAdapter, SourceSnapshot } from "../adapters";
import { readValidatedSnapshot } from "../file-source";

export const EAST_BAY_PARK_ENTRANCES_QUERY_URL = "https://services2.arcgis.com/jeEP9c9zZoQQwtck/arcgis/rest/services/EBRPD_Park_Entrances/FeatureServer/1/query?where=PARK%20IN%20(%27Mission%20Peak%27%2C%27Ohlone%27%2C%27Pleasanton%20Ridge%27%2C%27Vargas%20Plateau%27%2C%27Sunol%27%2C%27Del%20Valle%27)&outFields=GlobalID%2CUNIQUE_ID%2CPARK%2CNAME%2CWALKING%2CENTRANCE%2CCLOSED%2CPARKING&returnGeometry=true&outSR=4326&f=json";

const AUTHORITY = "East Bay Regional Park District";
const DATASET = "EBRPD Park Entrances";
const OBJECT_ID_FIELD = "OBJECTID_1";
const GLOBAL_ID_FIELD = "GlobalID";

const EXPECTED_FIELDS = {
  GlobalID: "esriFieldTypeGlobalID",
  UNIQUE_ID: "esriFieldTypeString",
  PARK: "esriFieldTypeString",
  NAME: "esriFieldTypeString",
  WALKING: "esriFieldTypeString",
  ENTRANCE: "esriFieldTypeString",
  CLOSED: "esriFieldTypeString",
  PARKING: "esriFieldTypeString",
} as const;

const PARKS = new Set([
  "Mission Peak",
  "Ohlone",
  "Pleasanton Ridge",
  "Vargas Plateau",
  "Sunol",
  "Del Valle",
]);

const WALKING_VALUES = new Set(["Y", "N"]);
const CLOSED_VALUES = new Set([
  "Entrance Open",
  "No Parking In Staging Area / Walk-In Access Only",
  "Entrance Closed / No Park Access",
]);
const CLOSED_NO_ACCESS = "Entrance Closed / No Park Access";

type ArcGisField = { name: string; type: string };
type ArcGisFeature = {
  attributes: Record<string, unknown>;
  geometry: { x: number; y: number };
};
type ArcGisPointQuerySnapshot = {
  objectIdFieldName?: string;
  globalIdFieldName?: string;
  geometryType: string;
  spatialReference: { wkid?: number; latestWkid?: number };
  fields: ArcGisField[];
  features: ArcGisFeature[];
  exceededTransferLimit?: boolean;
};

function assertRecord(value: unknown, context: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${context} must be an object`);
}

function parseSnapshot(value: unknown): ArcGisPointQuerySnapshot {
  assertRecord(value, "EBRPD entrance snapshot");
  if (value.geometryType !== "esriGeometryPoint") {
    throw new Error(`Unexpected EBRPD entrance geometry type ${String(value.geometryType)}`);
  }
  assertRecord(value.spatialReference, "EBRPD entrance spatial reference");
  const spatialReference = value.spatialReference as ArcGisPointQuerySnapshot["spatialReference"];
  if (spatialReference.wkid !== 4326 && spatialReference.latestWkid !== 4326) {
    throw new Error(`Unexpected EBRPD entrance CRS ${String(spatialReference.latestWkid ?? spatialReference.wkid)}`);
  }
  if (!Array.isArray(value.fields)) throw new Error("EBRPD entrance snapshot is missing field metadata");
  if (!Array.isArray(value.features) || value.features.length === 0) throw new Error("EBRPD entrance snapshot is empty");
  if (value.exceededTransferLimit === true) throw new Error("EBRPD entrance snapshot exceeded the service transfer limit");
  if (value.objectIdFieldName !== OBJECT_ID_FIELD) {
    throw new Error(`EBRPD entrance schema drift: object ID changed to ${String(value.objectIdFieldName)}`);
  }
  if (value.globalIdFieldName !== GLOBAL_ID_FIELD) {
    throw new Error(`EBRPD entrance schema drift: global ID changed to ${String(value.globalIdFieldName)}`);
  }
  const fields = new Map((value.fields as ArcGisField[]).map((field) => [field.name, field.type]));
  for (const [name, type] of Object.entries(EXPECTED_FIELDS)) {
    if (!fields.has(name)) throw new Error(`EBRPD entrance schema drift: missing documented field ${name}`);
    if (fields.get(name) !== type) {
      throw new Error(`EBRPD entrance schema drift: field ${name} changed from ${type} to ${fields.get(name)}`);
    }
  }
  return value as ArcGisPointQuerySnapshot;
}

function optionalDocumentedValue(
  attributes: Record<string, unknown>,
  field: "WALKING" | "CLOSED",
  allowed: ReadonlySet<string>,
): string | null {
  const value = attributes[field];
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || !allowed.has(value)) {
    throw new Error(`Undocumented ${field} value ${JSON.stringify(value)}`);
  }
  return value;
}

function optionalText(attributes: Record<string, unknown>, field: string): string | null {
  const value = attributes[field];
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") throw new Error(`EBRPD entrance field ${field} must be a string or null`);
  return value.trim() || null;
}

function accessState(attributes: Record<string, unknown>): AccessState {
  const walking = optionalDocumentedValue(attributes, "WALKING", WALKING_VALUES);
  const closed = optionalDocumentedValue(attributes, "CLOSED", CLOSED_VALUES);
  if (closed === CLOSED_NO_ACCESS) return "closed";
  return walking === "Y" ? "public" : "unknown";
}

export class EastBayRegionalParkDistrictEntranceAdapter implements OfficialAccessAdapter {
  readonly adapterVersion = "ebrpd-park-entrances-v1";

  private async read(snapshot: SourceSnapshot): Promise<ArcGisPointQuerySnapshot> {
    if (snapshot.authority !== AUTHORITY || snapshot.dataset !== DATASET) {
      throw new Error(`Source identity does not match ${AUTHORITY} / ${DATASET}`);
    }
    if (snapshot.url !== EAST_BAY_PARK_ENTRANCES_QUERY_URL) {
      throw new Error(`Source URL does not match pinned EBRPD entrance endpoint for ${snapshot.id}`);
    }
    return parseSnapshot(await readValidatedSnapshot(snapshot));
  }

  async validate(snapshot: SourceSnapshot): Promise<void> {
    await this.read(snapshot);
  }

  async normalize(snapshot: SourceSnapshot): Promise<NormalizedAccessEvidence[]> {
    const input = await this.read(snapshot);
    const ids = new Set<string>();
    const evidence = input.features.map((feature, index): NormalizedAccessEvidence => {
      assertRecord(feature, `EBRPD entrance feature ${index}`);
      assertRecord(feature.attributes, `EBRPD entrance feature ${index} attributes`);
      for (const field of Object.keys(EXPECTED_FIELDS)) {
        if (!(field in feature.attributes)) {
          throw new Error(`EBRPD entrance feature ${index} is missing documented field ${field}`);
        }
      }
      const externalId = optionalText(feature.attributes, GLOBAL_ID_FIELD);
      if (!externalId) throw new Error(`EBRPD entrance feature ${index} has no stable GlobalID`);
      if (ids.has(externalId)) throw new Error(`EBRPD entrance snapshot contains duplicate stable ID ${externalId}`);
      ids.add(externalId);

      const park = optionalText(feature.attributes, "PARK");
      if (!park || !PARKS.has(park)) throw new Error(`EBRPD entrance feature ${externalId} has unexpected park ${String(park)}`);
      const name = optionalText(feature.attributes, "NAME") ?? `${park} Entrance`;
      assertRecord(feature.geometry, `EBRPD entrance feature ${externalId} geometry`);
      const { x: lon, y: lat } = feature.geometry;
      if (!Number.isFinite(lon) || !Number.isFinite(lat) || lon < -180 || lon > 180 || lat < -90 || lat > 90) {
        throw new Error(`EBRPD entrance feature ${externalId} has invalid point geometry`);
      }
      return {
        sourceId: snapshot.id,
        externalId,
        lon,
        lat,
        name,
        accessState: accessState(feature.attributes),
        confidence: "high",
      };
    });
    return evidence.sort((first, second) => first.externalId.localeCompare(second.externalId));
  }
}
