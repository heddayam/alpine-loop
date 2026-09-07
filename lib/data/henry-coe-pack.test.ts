import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { areaGeometryBounds } from "./area-geometry";
import { parseRegionalBoundary } from "./regional-builder";
import { readElevationSourceConfig } from "./elevation";
import { HENRY_COE_PACK_CONFIG, HENRY_COE_REGION_ROOT, buildHenryCoePack } from "./henry-coe-pack";
import { readOsmSourceConfig } from "./osm";
import { readSearchRegionInput } from "./search-regions";

describe("Henry Coe pack wiring", () => {
  it("validates the coherent Henry Coe and Coyote Lake boundary and reviewed regions", async () => {
    const boundaryContents = await readFile(path.join(HENRY_COE_REGION_ROOT, "boundary.geojson"), "utf8");
    const boundary = parseRegionalBoundary(HENRY_COE_PACK_CONFIG, boundaryContents);
    expect(boundary.geometry.type).toBe("MultiPolygon");
    expect(areaGeometryBounds(boundary.geometry)).toEqual([-121.596281, 37.0324441, -121.3058921, 37.3111329]);

    const [osm, elevation, searchRegions] = await Promise.all([
      readOsmSourceConfig(path.join(HENRY_COE_REGION_ROOT, "osm-source.json")),
      readElevationSourceConfig(path.join(HENRY_COE_REGION_ROOT, "elevation-source.json")),
      readSearchRegionInput(path.join(HENRY_COE_REGION_ROOT, "search-regions.json")),
    ]);
    expect(osm.version).toBe("norcal-260801");
    expect(elevation).toMatchObject({
      cacheNamespace: "henry-coe-elevation",
      expectedProductIds: ["68afba8fd4be02645f9b293f"],
    });
    expect(searchRegions.regions.map(({ namedAreaId }) => namedAreaId)).toEqual([
      "pack:henry-coe",
      "osm:relation/11341366",
      "osm:relation/16859470",
    ]);
    expect(buildHenryCoePack).toEqual(expect.any(Function));
  });

  it("defines unique representative scenarios for each major included cluster", async () => {
    const input = JSON.parse(await readFile(path.join(HENRY_COE_REGION_ROOT, "scenarios.json"), "utf8")) as {
      packId: string;
      scenarios: Array<{ id: string; cluster: string; searchRegionId: string }>;
    };
    expect(input.packId).toBe("henry-coe");
    expect(input.scenarios.map(({ id }) => id)).toEqual([
      "coe-ranch-headquarters",
      "hunting-hollow",
      "dowdy-ranch",
      "mendoza-ranch",
      "harvey-bear-ranch",
    ]);
    expect(new Set(input.scenarios.map(({ cluster }) => cluster)).size).toBe(input.scenarios.length);
    expect(input.scenarios.every(({ searchRegionId }) => searchRegionId.startsWith("osm:relation/"))).toBe(true);
  });
});
