import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SourceSnapshot } from "../adapters";
import { sha256File } from "../file-source";
import {
  EAST_BAY_PARK_ENTRANCES_QUERY_URL,
  EastBayRegionalParkDistrictEntranceAdapter,
} from "./east-bay-entrances";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function querySnapshot() {
  const records = [
    { GlobalID: "closed-id", NAME: "Closed Gate", WALKING: "Y", CLOSED: "Entrance Closed / No Park Access" },
    { GlobalID: "unknown-id", NAME: "Unreviewed Gate", WALKING: null, CLOSED: null },
    { GlobalID: "public-id", NAME: "Named Entrance", WALKING: "Y", CLOSED: "Entrance Open" },
    { GlobalID: "walk-in-id", NAME: "Walk-In Gate", WALKING: "Y", CLOSED: "No Parking In Staging Area / Walk-In Access Only" },
  ];
  return {
    objectIdFieldName: "OBJECTID_1",
    globalIdFieldName: "GlobalID",
    geometryType: "esriGeometryPoint",
    spatialReference: { wkid: 4326, latestWkid: 4326 },
    fields: [
      { name: "GlobalID", type: "esriFieldTypeGlobalID" },
      { name: "UNIQUE_ID", type: "esriFieldTypeString" },
      { name: "PARK", type: "esriFieldTypeString" },
      { name: "NAME", type: "esriFieldTypeString" },
      { name: "WALKING", type: "esriFieldTypeString" },
      { name: "ENTRANCE", type: "esriFieldTypeString" },
      { name: "CLOSED", type: "esriFieldTypeString" },
      { name: "PARKING", type: "esriFieldTypeString" },
    ],
    features: records.map((attributes, index) => ({
      attributes: {
        UNIQUE_ID: String(index + 1).padStart(4, "0"),
        PARK: "Mission Peak",
        ENTRANCE: "Y",
        PARKING: index === 0 ? "N" : "Y",
        ...attributes,
      },
      geometry: { x: -121.9 + index * 0.001, y: 37.5 },
    })),
  };
}

async function sourceFor(input: unknown): Promise<SourceSnapshot> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "east-bay-entrances-"));
  temporaryDirectories.push(directory);
  const localPath = path.join(directory, "entrances.json");
  await writeFile(localPath, JSON.stringify(input));
  return {
    id: "ebrpd-entrances-fixture",
    authority: "East Bay Regional Park District",
    dataset: "EBRPD Park Entrances",
    version: "fixture-1",
    retrievedAt: "2026-08-06T00:00:00Z",
    url: EAST_BAY_PARK_ENTRANCES_QUERY_URL,
    license: "Fixture-only data",
    contentHash: await sha256File(localPath),
    localPath,
  };
}

describe("East Bay Regional Park District entrance adapter", () => {
  it("pins the exact query and maps public, closed, and unknown entrance evidence with stable IDs", async () => {
    expect(EAST_BAY_PARK_ENTRANCES_QUERY_URL).toBe(
      "https://services2.arcgis.com/jeEP9c9zZoQQwtck/arcgis/rest/services/EBRPD_Park_Entrances/FeatureServer/1/query?where=PARK%20IN%20(%27Mission%20Peak%27%2C%27Ohlone%27%2C%27Pleasanton%20Ridge%27%2C%27Vargas%20Plateau%27%2C%27Sunol%27%2C%27Del%20Valle%27)&outFields=GlobalID%2CUNIQUE_ID%2CPARK%2CNAME%2CWALKING%2CENTRANCE%2CCLOSED%2CPARKING&returnGeometry=true&outSR=4326&f=json",
    );
    const evidence = await new EastBayRegionalParkDistrictEntranceAdapter().normalize(await sourceFor(querySnapshot()));

    expect(evidence.map(({ externalId, name, accessState, confidence }) => ({ externalId, name, accessState, confidence }))).toEqual([
      { externalId: "closed-id", name: "Closed Gate", accessState: "closed", confidence: "high" },
      { externalId: "public-id", name: "Named Entrance", accessState: "public", confidence: "high" },
      { externalId: "unknown-id", name: "Unreviewed Gate", accessState: "unknown", confidence: "high" },
      { externalId: "walk-in-id", name: "Walk-In Gate", accessState: "public", confidence: "high" },
    ]);
  });

  it("fails closed on identity, URL, schema, CRS, empty, truncation, and undocumented value drift", async () => {
    const adapter = new EastBayRegionalParkDistrictEntranceAdapter();
    const valid = await sourceFor(querySnapshot());
    await expect(adapter.validate({ ...valid, authority: "Another agency" })).rejects.toThrow(/Source identity/);
    await expect(adapter.validate({ ...valid, url: `${valid.url}&resultOffset=1` })).rejects.toThrow(/pinned/);

    const changedSchema = querySnapshot();
    changedSchema.fields.find(({ name }) => name === "WALKING")!.type = "esriFieldTypeInteger";
    await expect(adapter.validate(await sourceFor(changedSchema))).rejects.toThrow(/field WALKING changed/);

    const changedCrs = querySnapshot();
    changedCrs.spatialReference = { wkid: 3857, latestWkid: 3857 };
    await expect(adapter.validate(await sourceFor(changedCrs))).rejects.toThrow(/CRS 3857/);

    const empty = querySnapshot();
    empty.features = [];
    await expect(adapter.validate(await sourceFor(empty))).rejects.toThrow(/snapshot is empty/);

    const truncated = { ...querySnapshot(), exceededTransferLimit: true };
    await expect(adapter.validate(await sourceFor(truncated))).rejects.toThrow(/transfer limit/);

    const undocumentedWalking = querySnapshot();
    undocumentedWalking.features[0].attributes.WALKING = "MAYBE";
    await expect(adapter.normalize(await sourceFor(undocumentedWalking))).rejects.toThrow(/Undocumented WALKING value/);

    const undocumentedClosed = querySnapshot();
    undocumentedClosed.features[0].attributes.CLOSED = "Temporarily closed";
    await expect(adapter.normalize(await sourceFor(undocumentedClosed))).rejects.toThrow(/Undocumented CLOSED value/);

    const invalidGeometry = querySnapshot();
    invalidGeometry.features[0].geometry.x = Number.NaN;
    await expect(adapter.normalize(await sourceFor(invalidGeometry))).rejects.toThrow(/invalid point geometry/);

    const duplicateId = querySnapshot();
    duplicateId.features[1].attributes.GlobalID = duplicateId.features[0].attributes.GlobalID;
    await expect(adapter.normalize(await sourceFor(duplicateId))).rejects.toThrow(/duplicate stable ID/);
  });
});
