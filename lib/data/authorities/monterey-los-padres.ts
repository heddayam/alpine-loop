import path from "node:path";
import type { NormalizedAccessEvidence, OfficialAccessAdapter, SourceSnapshot } from "../adapters";
import { readValidatedSnapshot } from "../file-source";
import type { OfficialAccessJoinFeature } from "./types";
import type { OfficialSourceSet } from "./source";

export const MONTEREY_LOS_PADRES_TRAILS_QUERY_URL = "https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_TrailNFSPublishWithDataStatus_01/MapServer/0/query?where=admin_org%3D%27050751%27&geometry=-121.86%2C36.35%2C-121.65%2C36.52&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=globalid%2Ctrail_name%2Ctrail_no%2Cadmin_org%2Cmanaging_org%2Cattributesubset%2Callowed_terra_use%2Chiker_pedestrian_managed%2Chiker_pedestrian_accpt%2Chiker_pedestrian_disc%2Chiker_pedestrian_accpt_disc%2Chiker_pedestrian_restricted&returnGeometry=true&outSR=4326&f=json";
export const MONTEREY_OFFICIAL_SOURCE_SET: OfficialSourceSet = {
  configRoot: path.resolve("data/regions/monterey-carmel/official-sources"),
  filenames: ["usfs-national-forest-system-trails.json"],
  cacheNamespace: "monterey-carmel-official-access",
};

export const montereyLosPadresTrailsDefinition = {
  authority: "USDA Forest Service",
  dataset: "National Forest System Trails / northern Monterey connector review",
  queryUrl: MONTEREY_LOS_PADRES_TRAILS_QUERY_URL,
  expectedFeatureCount: 15,
  adminOrg: "050751",
} as const;

type Feature = { attributes: Record<string, unknown>; geometry: { paths: number[][][] } };
type Input = {
  geometryType: string;
  spatialReference: { wkid?: number; latestWkid?: number };
  fields: Array<{ name: string; type: string }>;
  features: Feature[];
  exceededTransferLimit?: boolean;
};
const EXPECTED_FIELDS = {
  globalid: "esriFieldTypeGlobalID", trail_name: "esriFieldTypeString", trail_no: "esriFieldTypeString",
  admin_org: "esriFieldTypeString", managing_org: "esriFieldTypeString", attributesubset: "esriFieldTypeString",
  allowed_terra_use: "esriFieldTypeString", hiker_pedestrian_managed: "esriFieldTypeString",
  hiker_pedestrian_accpt: "esriFieldTypeString", hiker_pedestrian_disc: "esriFieldTypeString",
  hiker_pedestrian_accpt_disc: "esriFieldTypeString", hiker_pedestrian_restricted: "esriFieldTypeString",
} as const;

function record(value: unknown, context: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${context} must be an object`);
}
function geometry(feature: Feature, id: string): OfficialAccessJoinFeature["geometry"] {
  const paths = feature.geometry?.paths;
  if (!Array.isArray(paths) || paths.length === 0 || paths.some((line) => !Array.isArray(line) || line.length < 2
    || line.some((point) => !Array.isArray(point) || point.length < 2 || !Number.isFinite(point[0]) || !Number.isFinite(point[1])))) {
    throw new Error(`USFS trail ${id} has invalid geometry`);
  }
  return paths.length === 1 ? { type: "LineString", coordinates: paths[0] } : { type: "MultiLineString", coordinates: paths };
}

export class MontereyLosPadresTrailsAdapter implements OfficialAccessAdapter {
  readonly adapterVersion = "usfs-northern-los-padres-trails-v1";

  private async read(snapshot: SourceSnapshot): Promise<Input> {
    if (snapshot.authority !== montereyLosPadresTrailsDefinition.authority || snapshot.dataset !== montereyLosPadresTrailsDefinition.dataset) {
      throw new Error("Source identity does not match the pinned USFS trail review");
    }
    if (snapshot.url !== MONTEREY_LOS_PADRES_TRAILS_QUERY_URL) throw new Error("Source URL does not match the pinned USFS query");
    const raw = await readValidatedSnapshot(snapshot);
    record(raw, "USFS trail snapshot");
    const input = raw as Input;
    if (input.geometryType !== "esriGeometryPolyline") throw new Error(`Unexpected USFS geometry type ${input.geometryType}`);
    if (input.spatialReference?.wkid !== 4326 && input.spatialReference?.latestWkid !== 4326) throw new Error("Unexpected USFS CRS");
    if (!Array.isArray(input.fields)) throw new Error("USFS snapshot lacks field metadata");
    const fields = new Map(input.fields.map(({ name, type }) => [name, type]));
    for (const [name, type] of Object.entries(EXPECTED_FIELDS)) {
      if (fields.get(name) !== type) throw new Error(`USFS schema drift for ${name}`);
    }
    if (!Array.isArray(input.features) || input.features.length === 0) throw new Error("USFS trail snapshot is empty");
    if (input.features.length !== montereyLosPadresTrailsDefinition.expectedFeatureCount) throw new Error("USFS feature count drifted");
    if (input.exceededTransferLimit === true) throw new Error("USFS trail snapshot exceeded the transfer limit");
    return input;
  }

  async validate(snapshot: SourceSnapshot): Promise<void> { await this.normalizeForJoin(snapshot); }

  async normalizeForJoin(snapshot: SourceSnapshot): Promise<OfficialAccessJoinFeature[]> {
    const input = await this.read(snapshot);
    const ids = new Set<string>();
    return input.features.map((feature, index) => {
      record(feature.attributes, `USFS feature ${index} attributes`);
      for (const field of Object.keys(EXPECTED_FIELDS)) if (!(field in feature.attributes)) throw new Error(`USFS feature ${index} is missing ${field}`);
      const id = String(feature.attributes.globalid ?? "").trim();
      if (!/^\{[A-F0-9-]{36}\}$/.test(id)) throw new Error(`USFS feature ${index} has invalid globalid`);
      if (ids.has(id)) throw new Error(`USFS snapshot has duplicate globalid ${id}`);
      ids.add(id);
      if (feature.attributes.admin_org !== "050751" || feature.attributes.managing_org !== "050751"
        || feature.attributes.attributesubset !== "TrailNFS_MGMT") throw new Error(`USFS scope drift for ${id}`);
      if (feature.attributes.allowed_terra_use !== "21" && feature.attributes.allowed_terra_use !== "321") throw new Error(`Undocumented allowed_terra_use for ${id}`);
      for (const field of ["hiker_pedestrian_managed", "hiker_pedestrian_accpt", "hiker_pedestrian_disc", "hiker_pedestrian_restricted"]) {
        if (feature.attributes[field] !== null) throw new Error(`Undocumented ${field} value for ${id}`);
      }
      if (feature.attributes.hiker_pedestrian_accpt_disc !== "01/01-12/31") throw new Error(`Undocumented hiker_pedestrian_accpt_disc value for ${id}`);
      const line = geometry(feature, id);
      const points = line.type === "LineString" ? line.coordinates as number[][] : (line.coordinates as number[][][]).flat();
      const point = points[Math.floor(points.length / 2)];
      return {
        sourceId: snapshot.id,
        authorityFeatureId: id,
        geometry: line,
        evidence: {
          sourceId: snapshot.id,
          externalId: id,
          lon: point[0], lat: point[1],
          name: String(feature.attributes.trail_name ?? feature.attributes.trail_no ?? id),
          accessState: "unknown" as const,
          confidence: "high" as const,
        },
      };
    }).sort((a, b) => a.authorityFeatureId.localeCompare(b.authorityFeatureId));
  }

  async normalize(snapshot: SourceSnapshot): Promise<NormalizedAccessEvidence[]> {
    return (await this.normalizeForJoin(snapshot)).map(({ evidence }) => evidence);
  }
}
