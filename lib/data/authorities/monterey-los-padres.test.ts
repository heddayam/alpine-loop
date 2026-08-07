import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SourceSnapshot } from "../adapters";
import { sha256File } from "../file-source";
import {
  MONTEREY_LOS_PADRES_TRAILS_QUERY_URL,
  MONTEREY_OFFICIAL_SOURCE_SET,
  MontereyLosPadresTrailsAdapter,
  montereyLosPadresTrailsDefinition,
} from "./monterey-los-padres";
import { readOfficialSourceConfigs } from "./source";

const temporaryDirectories: string[] = [];
afterEach(async () => Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

const fields = [
  "globalid", "trail_name", "trail_no", "admin_org", "managing_org", "attributesubset", "allowed_terra_use",
  "hiker_pedestrian_managed", "hiker_pedestrian_accpt", "hiker_pedestrian_disc",
  "hiker_pedestrian_accpt_disc", "hiker_pedestrian_restricted",
].map((name) => ({ name, type: name === "globalid" ? "esriFieldTypeGlobalID" : "esriFieldTypeString" }));

function querySnapshot() {
  return {
    geometryType: "esriGeometryPolyline",
    spatialReference: { wkid: 4326, latestWkid: 4326 },
    fields: fields.map((field) => ({ ...field })),
    features: Array.from({ length: montereyLosPadresTrailsDefinition.expectedFeatureCount }, (_, index) => ({
      attributes: {
        globalid: `{${String(index).padStart(8, "0")}-0000-0000-0000-000000000000}`,
        trail_name: `Official trail ${index}`,
        trail_no: `T${index}`,
        admin_org: "050751", managing_org: "050751", attributesubset: "TrailNFS_MGMT",
        allowed_terra_use: index % 2 ? "21" : "321",
        hiker_pedestrian_managed: null, hiker_pedestrian_accpt: null, hiker_pedestrian_disc: null,
        hiker_pedestrian_accpt_disc: "01/01-12/31", hiker_pedestrian_restricted: null,
      },
      geometry: { paths: [[[-121.8, 36.4 + index * 0.001], [-121.79, 36.401 + index * 0.001]]] },
    })),
  };
}

async function sourceFor(input: unknown): Promise<SourceSnapshot> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "monterey-usfs-"));
  temporaryDirectories.push(directory);
  const localPath = path.join(directory, "trails.json");
  await writeFile(localPath, JSON.stringify(input));
  return {
    id: "usfs-los-padres-fixture", authority: montereyLosPadresTrailsDefinition.authority,
    dataset: montereyLosPadresTrailsDefinition.dataset, version: "fixture", retrievedAt: "2026-08-07T17:28:17Z",
    url: MONTEREY_LOS_PADRES_TRAILS_QUERY_URL, license: "US Government work", contentHash: await sha256File(localPath), localPath,
  };
}

describe("northern Los Padres official trail adapter", () => {
  it("exports a one-source refresh set and treats the complete official inventory only as unknown cross-check evidence", async () => {
    expect(MONTEREY_OFFICIAL_SOURCE_SET.filenames).toEqual(["usfs-national-forest-system-trails.json"]);
    const configs = await readOfficialSourceConfigs(MONTEREY_OFFICIAL_SOURCE_SET);
    expect(configs.map(({ id }) => id)).toEqual(["usfs-los-padres-northern-connector-trails"]);
    const adapter = new MontereyLosPadresTrailsAdapter();
    const joins = await adapter.normalizeForJoin(await sourceFor(querySnapshot()));
    expect(joins).toHaveLength(15);
    expect(joins.every(({ evidence }) => evidence.accessState === "unknown" && evidence.confidence === "high")).toBe(true);
    expect(joins.every(({ geometry }) => geometry.type === "LineString")).toBe(true);
  });

  it("fails closed on empty/count/schema/scope/permission drift and truncation", async () => {
    const adapter = new MontereyLosPadresTrailsAdapter();
    const empty = querySnapshot(); empty.features = [];
    await expect(adapter.validate(await sourceFor(empty))).rejects.toThrow(/empty/);
    const schema = querySnapshot(); schema.fields[1].type = "esriFieldTypeInteger";
    await expect(adapter.validate(await sourceFor(schema))).rejects.toThrow(/schema drift/);
    const scope = querySnapshot(); scope.features[0].attributes.admin_org = "another";
    await expect(adapter.validate(await sourceFor(scope))).rejects.toThrow(/scope drift/);
    const permission = querySnapshot(); (permission.features[0].attributes as Record<string, unknown>).hiker_pedestrian_managed = "YES";
    await expect(adapter.validate(await sourceFor(permission))).rejects.toThrow(/Undocumented/);
    await expect(adapter.validate(await sourceFor({ ...querySnapshot(), exceededTransferLimit: true }))).rejects.toThrow(/transfer limit/);
  });
});
