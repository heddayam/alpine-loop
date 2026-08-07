import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  EAST_BAY_CURRENT_CLOSURES_AUTHORITY,
  EAST_BAY_CURRENT_CLOSURES_DATASET,
  EAST_BAY_CURRENT_CLOSURES_RETRIEVED_AT,
  EAST_BAY_CURRENT_CLOSURES_SOURCE_ID,
  EAST_BAY_CURRENT_CLOSURES_SOURCE_URL,
  EAST_BAY_CURRENT_CLOSURES_VERSION,
  EAST_BAY_PARK_ENTRANCES_QUERY_URL,
  EAST_BAY_REGIONAL_PARK_DISTRICT_QUERY_URL,
  EastBayCurrentClosuresAdapter,
  readOfficialSourceConfigs,
  type OfficialAccessJoin,
} from "./authorities";
import { reconcileAccess } from "./access";
import { areaGeometryBounds, assertValidAreaGeometry } from "./area-geometry";
import { readElevationSourceConfig } from "./elevation";
import { sha256File } from "./file-source";
import { readOsmSourceConfig } from "./osm";
import { readPopulationSourceConfig } from "./population";
import { readSearchRegionInput } from "./search-regions";
import {
  SOUTHERN_EAST_BAY_OFFICIAL_SOURCE_SET,
  SOUTHERN_EAST_BAY_REGION_ROOT,
  buildSouthernEastBayPack,
  prioritizeCurrentClosureJoins,
} from "./southern-east-bay-pack";

describe("Southern East Bay pack wiring", () => {
  it("owns a deterministic source set with roads before entrances", async () => {
    expect(SOUTHERN_EAST_BAY_OFFICIAL_SOURCE_SET).toEqual({
      configRoot: path.join(SOUTHERN_EAST_BAY_REGION_ROOT, "official-sources"),
      filenames: ["ebrpd-roads-and-trails.json", "ebrpd-park-entrances.json"],
      cacheNamespace: "southern-east-bay-official-access",
    });
    const configs = await readOfficialSourceConfigs(SOUTHERN_EAST_BAY_OFFICIAL_SOURCE_SET);
    expect(configs.map(({ id }) => id)).toEqual([
      "ebrpd-roads-and-trails-access",
      "ebrpd-park-entrances",
    ]);
    expect(configs.map(({ downloadUrl }) => downloadUrl)).toEqual([
      EAST_BAY_REGIONAL_PARK_DISTRICT_QUERY_URL,
      EAST_BAY_PARK_ENTRANCES_QUERY_URL,
    ]);
  });

  it("validates the exact boundary, reviewed regions, and regional raster namespaces", async () => {
    const boundary = JSON.parse(await readFile(path.join(SOUTHERN_EAST_BAY_REGION_ROOT, "boundary.geojson"), "utf8")) as {
      properties: { id: string; boundaryVersion: string };
      geometry: unknown;
    };
    expect(boundary.properties).toMatchObject({
      id: "southern-east-bay",
      boundaryVersion: "southern-east-bay-boundary-v1",
    });
    expect(areaGeometryBounds(assertValidAreaGeometry(boundary.geometry))).toEqual([
      -122.08, 37.365, -121.515, 37.75,
    ]);

    const [osm, elevation, population, searchRegions] = await Promise.all([
      readOsmSourceConfig(path.join(SOUTHERN_EAST_BAY_REGION_ROOT, "osm-source.json")),
      readElevationSourceConfig(path.join(SOUTHERN_EAST_BAY_REGION_ROOT, "elevation-source.json")),
      readPopulationSourceConfig(path.join(SOUTHERN_EAST_BAY_REGION_ROOT, "population-source.json")),
      readSearchRegionInput(path.join(SOUTHERN_EAST_BAY_REGION_ROOT, "search-regions.json")),
    ]);
    expect(osm.version).toBe("norcal-260801");
    expect(elevation.cacheNamespace).toBe("southern-east-bay-elevation");
    expect(population.cacheNamespace).toBe("southern-east-bay-population");
    expect(searchRegions.regions.map(({ namedAreaId }) => namedAreaId)).toEqual([
      "pack:southern-east-bay",
      "osm:relation/11518106",
      "osm:relation/317363",
      "osm:relation/226483",
    ]);
    expect(buildSouthernEastBayPack).toEqual(expect.any(Function));
  });

  it("pins the reviewed closure overlay to its exact content and three OSM ways", async () => {
    const localPath = path.join(SOUTHERN_EAST_BAY_REGION_ROOT, "current-closures.json");
    const contentHash = await sha256File(localPath);
    expect(contentHash).toBe("sha256:a7576a0e770587599c748a95212d9ec77329db1f5ca342325a7db0003e5cf5ab");
    const evidence = await new EastBayCurrentClosuresAdapter().normalize({
      id: EAST_BAY_CURRENT_CLOSURES_SOURCE_ID,
      authority: EAST_BAY_CURRENT_CLOSURES_AUTHORITY,
      dataset: EAST_BAY_CURRENT_CLOSURES_DATASET,
      version: EAST_BAY_CURRENT_CLOSURES_VERSION,
      retrievedAt: EAST_BAY_CURRENT_CLOSURES_RETRIEVED_AT,
      url: EAST_BAY_CURRENT_CLOSURES_SOURCE_URL,
      license: "Human-reviewed facts for local evaluation; derivative redistribution requires review",
      contentHash,
      localPath,
    });
    expect(evidence.map(({ externalId }) => externalId)).toEqual([
      "way/133590543",
      "way/284501998",
      "way/284501999",
    ]);
    expect(evidence.every(({ accessState, confidence }) => accessState === "closed" && confidence === "high")).toBe(true);
  });

  it("suppresses older line permission where a current closure exists", () => {
    const join = (
      sourceId: string,
      accessState: "public" | "closed",
      targetExternalId: string,
    ): OfficialAccessJoin => ({
      sourceId,
      authorityFeatureId: `${sourceId}:${targetExternalId}`,
      targetExternalId,
      matchMethod: "spatial-intersection",
      distanceM: 0,
      evidence: {
        sourceId,
        externalId: targetExternalId,
        lon: -121.831,
        lat: 37.5175,
        name: "Shady Glen Trail",
        accessState,
        confidence: "high",
      },
    });
    const target = "way/133590543";
    const result = prioritizeCurrentClosureJoins(
      [join("ebrpd-roads-and-trails-access", "public", target), join("roads", "public", "way/1")],
      [join(EAST_BAY_CURRENT_CLOSURES_SOURCE_ID, "closed", target)],
    );

    expect(result.suppressedLineJoinCount).toBe(1);
    expect(result.lineJoins.map(({ targetExternalId }) => targetExternalId)).toEqual(["way/1"]);
    expect(result.combinedJoins.filter(({ targetExternalId }) => targetExternalId === target)
      .map(({ evidence }) => evidence.accessState))
      .toEqual(["closed"]);
    expect(reconcileAccess("public", ["closed"])).toMatchObject({ state: "closed", conflict: false });
  });
});
