import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { areaGeometryBounds, pointInArea } from "./area-geometry";
import { readElevationSourceConfig } from "./elevation";
import { readOsmSourceConfig } from "./osm";
import { parseRegionalBoundary } from "./regional-builder";
import { readSearchRegionInput } from "./search-regions";
import {
  SOUTHWEST_CASCADES_PACK_CONFIG,
  SOUTHWEST_CASCADES_REGION_ROOT,
  buildSouthwestCascadesPack,
} from "./southwest-cascades-pack";

describe("Southwest Cascades pack wiring", () => {
  it("pins the reviewed two-part boundary, Washington extract, elevation tiles, and pack selector", async () => {
    expect(SOUTHWEST_CASCADES_PACK_CONFIG).toEqual({
      id: "southwest-cascades",
      name: "Southwest Cascades",
      dataVersionPrefix: "swc",
      compilerVersion: "basic-regional-pack-compiler-v1",
      boundaryVersion: "southwest-cascades-boundary-v1",
      regionRoot: SOUTHWEST_CASCADES_REGION_ROOT,
      display: { center: [-121.95, 46.15], zoom: 8 },
    });
    expect(buildSouthwestCascadesPack).toEqual(expect.any(Function));

    const contents = await readFile(path.join(SOUTHWEST_CASCADES_REGION_ROOT, "boundary.geojson"), "utf8");
    const boundary = parseRegionalBoundary(SOUTHWEST_CASCADES_PACK_CONFIG, contents);
    expect(boundary.geometry.type).toBe("MultiPolygon");
    expect(areaGeometryBounds(boundary.geometry)).toEqual([-122.51, 45.68, -121.434711, 46.51]);
    expect(pointInArea([-122.18, 46.2], boundary.geometry)).toBe(true); // Loowit circuit
    expect(pointInArea([-121.56, 46.25], boundary.geometry)).toBe(true); // Adams west
    expect(pointInArea([-121.65, 46.42], boundary.geometry)).toBe(true); // Blue Lake–Hamilton
    expect(pointInArea([-121.57, 46.47], boundary.geometry)).toBe(true); // Klickitat overlap
    expect(pointInArea([-122.24, 45.75], boundary.geometry)).toBe(true); // Silver Star
    expect(pointInArea([-121.45, 46.25], boundary.geometry)).toBe(false); // Yakama edge
    expect(pointInArea([-121.46, 46.5], boundary.geometry)).toBe(false); // Goat Rocks
    expect(pointInArea([-121.9, 45.68], boundary.geometry)).toBe(false); // Columbia Gorge

    const [osm, elevation, searchRegions] = await Promise.all([
      readOsmSourceConfig(path.join(SOUTHWEST_CASCADES_REGION_ROOT, "osm-source.json")),
      readElevationSourceConfig(path.join(SOUTHWEST_CASCADES_REGION_ROOT, "elevation-source.json")),
      readSearchRegionInput(path.join(SOUTHWEST_CASCADES_REGION_ROOT, "search-regions.json")),
    ]);
    expect(osm).toMatchObject({
      id: "geofabrik-washington-osm",
      version: "washington-260801",
      expectedByteLength: 359826867,
    });
    expect(elevation).toMatchObject({
      cacheNamespace: "southwest-cascades-elevation",
      bbox: [-122.51, 45.68, -121.434711, 46.51],
      expectedProductIds: [
        "6981bb9ab66b0193caec85a4",
        "69e6dcc0b66b01f903b6a342",
        "689d4592d4be027ac1589946",
        "689d4592d4be027ac1589944",
      ],
    });
    expect(searchRegions.regions).toEqual([{
      namedAreaId: "pack:southwest-cascades",
      expectedName: "Southwest Cascades",
    }]);
  });

  it("records plausible and impossible requests for all nine review clusters", async () => {
    const input = JSON.parse(await readFile(path.join(SOUTHWEST_CASCADES_REGION_ROOT, "scenarios.json"), "utf8")) as {
      packId: string;
      scenarios: Array<{
        id: string;
        searchRegionId: string;
        referencePoint: { name: string; coordinates: [number, number] };
        exactExpectation: { result: string };
        impossibleExpectation: { result: string };
      }>;
    };
    expect(input.packId).toBe("southwest-cascades");
    expect(input.scenarios.map(({ id }) => id)).toEqual([
      "ape-canyon-loowit",
      "june-lake-loowit",
      "mount-margaret-boundary",
      "adams-south-stagman",
      "adams-north-killen",
      "upper-cispus-blue-lake",
      "indian-heaven-lemei",
      "trapper-creek-big-hollow",
      "silver-star-tarbell",
    ]);
    expect(input.scenarios.find(({ id }) => id === "upper-cispus-blue-lake")?.referencePoint).toEqual({
      name: "Blue Lake ORV Trailhead parking way/716832243",
      coordinates: [-121.73118, 46.396063],
    });
    expect(input.scenarios.every((scenario) =>
      scenario.searchRegionId === "pack:southwest-cascades"
      && scenario.exactExpectation.result === "at-least-one-exact"
      && scenario.impossibleExpectation.result === "near-miss-only")).toBe(true);
  });
});
