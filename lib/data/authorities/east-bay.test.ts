import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SourceSnapshot } from "../adapters";
import { sha256File } from "../file-source";
import { ArcGisOfficialAccessAdapter } from "./arcgis";
import {
  EAST_BAY_REGIONAL_PARK_DISTRICT_QUERY_URL,
  EastBayRegionalParkDistrictAccessAdapter,
  eastBayRegionalParkDistrictDefinition,
} from "./east-bay";

const AUTHORITY = "East Bay Regional Park District";
const DATASET = "EBRPD Roads and Trails / Roads and Trails-by Access";
const temporaryDirectories: string[] = [];

const DOCUMENTED_ACCESS = [
  ["Foot", "public"],
  ["Foot Bicycle", "public"],
  ["Foot Horse", "public"],
  ["Foot Horse Bicycle", "public"],
  ["Foot Horse Bicycle Vehicle", "public"],
  ["Foot Bicycle Vehicle", "public"],
  ["Service", "prohibited"],
  ["Horse", "prohibited"],
  ["Bicycle", "prohibited"],
  ["EVMA", "prohibited"],
  [null, "unknown"],
  ["", "unknown"],
] as const;

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function querySnapshot(accessValues: readonly (string | null)[]) {
  return {
    objectIdFieldName: "OBJECTID",
    globalIdFieldName: "GlobalID",
    geometryType: "esriGeometryPolyline",
    spatialReference: { wkid: 4326 },
    fields: [
      { name: "GlobalID", type: "esriFieldTypeGlobalID" },
      { name: "ACCESS", type: "esriFieldTypeString" },
      { name: "PARK_NAME", type: "esriFieldTypeString" },
      { name: "LOCALNAME", type: "esriFieldTypeString" },
    ],
    features: accessValues.map((access, index) => ({
      attributes: {
        GlobalID: `{ebrpd-${index}}`,
        ACCESS: access,
        PARK_NAME: "Mission Peak",
        LOCALNAME: `Trail ${index}`,
      },
      geometry: { paths: [[[-121.9, 37.5], [-121.89, 37.51]]] },
    })),
  };
}

async function sourceFor(input: unknown): Promise<SourceSnapshot> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "east-bay-authority-"));
  temporaryDirectories.push(directory);
  const localPath = path.join(directory, "ebrpd.json");
  await writeFile(localPath, JSON.stringify(input));
  return {
    id: "ebrpd-roads-and-trails-fixture",
    authority: AUTHORITY,
    dataset: DATASET,
    version: "fixture-1",
    retrievedAt: "2026-08-06T00:00:00Z",
    url: EAST_BAY_REGIONAL_PARK_DISTRICT_QUERY_URL,
    license: "Fixture-only data",
    contentHash: await sha256File(localPath),
    localPath,
  };
}

describe("East Bay Regional Park District official access adapter", () => {
  it("pins layer 13 to the six Southern East Bay parks and the documented fields", () => {
    expect(EAST_BAY_REGIONAL_PARK_DISTRICT_QUERY_URL).toBe(
      "https://services2.arcgis.com/jeEP9c9zZoQQwtck/arcgis/rest/services/EBRPD_Roads_and_Trails/FeatureServer/13/query?where=PARK_NAME%20IN%20(%27Pleasanton%20Ridge%27%2C%27Mission%20Peak%27%2C%27Vargas%20Plateau%27%2C%27Sunol%27%2C%27Ohlone%27%2C%27Del%20Valle%27)&outFields=GlobalID%2CACCESS%2CPARK_NAME%2CLOCALNAME&returnGeometry=true&outSR=4326&f=json",
    );
    expect(eastBayRegionalParkDistrictDefinition).toMatchObject({
      authority: AUTHORITY,
      dataset: DATASET,
      objectIdField: "OBJECTID",
      stableIdField: "GlobalID",
      nameField: "LOCALNAME",
      expectedFields: {
        GlobalID: "esriFieldTypeGlobalID",
        ACCESS: "esriFieldTypeString",
        PARK_NAME: "esriFieldTypeString",
        LOCALNAME: "esriFieldTypeString",
      },
    });
    expect(new EastBayRegionalParkDistrictAccessAdapter()).toBeInstanceOf(ArcGisOfficialAccessAdapter);
  });

  it("maps every documented ACCESS value, null, and empty access conservatively", async () => {
    const adapter = new EastBayRegionalParkDistrictAccessAdapter();
    const source = await sourceFor(querySnapshot(DOCUMENTED_ACCESS.map(([access]) => access)));

    const evidence = await adapter.normalize(source);

    expect(evidence.map(({ externalId, name, accessState }) => [externalId, name, accessState])).toEqual(
      DOCUMENTED_ACCESS.map(([, state], index) => [`{ebrpd-${index}}`, `Trail ${index}`, state]),
    );
  });

  it("fails on schema drift and undocumented non-empty ACCESS values", async () => {
    const changedSchema = querySnapshot(["Foot"]);
    changedSchema.fields.find(({ name }) => name === "ACCESS")!.type = "esriFieldTypeInteger";
    const changedSchemaSource = await sourceFor(changedSchema);
    const undocumentedSource = await sourceFor(querySnapshot(["Pedestrian"]));
    const adapter = new EastBayRegionalParkDistrictAccessAdapter();

    await expect(adapter.validate(changedSchemaSource)).rejects.toThrow(/field ACCESS changed from esriFieldTypeString/);
    await expect(adapter.normalize(undocumentedSource)).rejects.toThrow(/Undocumented ACCESS value "Pedestrian"/);
  });

  it("rejects source identity or query URL drift", async () => {
    const adapter = new EastBayRegionalParkDistrictAccessAdapter();
    const source = await sourceFor(querySnapshot(["Foot"]));

    await expect(adapter.validate({ ...source, authority: "Another agency" })).rejects.toThrow(/Source identity does not match/);
    await expect(adapter.validate({ ...source, dataset: "Another layer" })).rejects.toThrow(/Source identity does not match/);
    await expect(adapter.validate({ ...source, url: `${source.url}&resultOffset=1` })).rejects.toThrow(/pinned endpoint/);
  });
});
