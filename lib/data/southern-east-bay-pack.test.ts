import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  EAST_BAY_PARK_ENTRANCES_QUERY_URL,
  EAST_BAY_REGIONAL_PARK_DISTRICT_QUERY_URL,
  readOfficialSourceConfigs,
} from "./authorities";
import { areaGeometryBounds, assertValidAreaGeometry } from "./area-geometry";
import { readElevationSourceConfig } from "./elevation";
import { readOsmSourceConfig } from "./osm";
import { readPopulationSourceConfig } from "./population";
import { readSearchRegionInput } from "./search-regions";
import {
  SOUTHERN_EAST_BAY_OFFICIAL_SOURCE_SET,
  SOUTHERN_EAST_BAY_REGION_ROOT,
  buildSouthernEastBayPack,
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
});
