import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { areaGeometryBounds, pointInArea } from "./area-geometry";
import { readElevationSourceConfig } from "./elevation";
import { readOsmSourceConfig } from "./osm";
import { parseRegionalBoundary } from "./regional-builder";
import { readSearchRegionInput } from "./search-regions";
import {
  RAINIER_GOAT_ROCKS_PACK_CONFIG,
  RAINIER_GOAT_ROCKS_REGION_ROOT,
  buildRainierGoatRocksPack,
} from "./rainier-goat-rocks-pack";

describe("Rainier–Goat Rocks pack inputs", () => {
  it("pins a valid boundary that keeps Wonderland and the Central PCT seam inside", async () => {
    expect(RAINIER_GOAT_ROCKS_PACK_CONFIG).toEqual({
      id: "rainier-goat-rocks",
      name: "Rainier–Goat Rocks",
      dataVersionPrefix: "rgr",
      compilerVersion: "basic-regional-pack-compiler-v1",
      boundaryVersion: "rainier-goat-rocks-boundary-v1",
      regionRoot: RAINIER_GOAT_ROCKS_REGION_ROOT,
      display: { center: [-121.54, 46.74], zoom: 8 },
    });
    const raw = JSON.parse(await readFile(path.join(RAINIER_GOAT_ROCKS_REGION_ROOT, "boundary.geojson"), "utf8"));
    expect(raw.properties.sourceNamedAreaIds).toEqual([
      "osm:relation/1399219",
      "osm:relation/6109986",
      "osm:relation/6109916",
      "osm:relation/6109176",
    ]);
    const boundary = parseRegionalBoundary(RAINIER_GOAT_ROCKS_PACK_CONFIG, JSON.stringify(raw));
    expect(boundary.geometry.type).toBe("Polygon");
    expect(areaGeometryBounds(boundary.geometry)).toEqual([
      -122.0849597, 46.3163758, -120.9891357, 47.456977,
    ]);
    for (const coordinate of [
      [-121.81253, 46.7501122], // Longmire / Wonderland
      [-121.864831, 46.9332678], // Mowich / Wonderland
      [-121.641863, 46.9140604], // Sunrise / Wonderland
      [-121.4, 47.3], // PCT gap that neither initial envelope nor Central covered
      [-121.435, 47.336], // PCT approach into Central
      [-121.518893, 46.4639429], // Goat Rocks west approach
    ] as const) expect(pointInArea(coordinate, boundary.geometry)).toBe(true);
    for (const coordinate of [
      [-122.4, 47], // Puget lowland
      [-122.19, 46.2], // Mount St. Helens, Southwest pack
      [-120.8, 47.5], // Central core
    ] as const) expect(pointInArea(coordinate, boundary.geometry)).toBe(false);
    expect(buildRainierGoatRocksPack).toEqual(expect.any(Function));
  });

  it("pins the shared Washington extract and five polygon-intersecting 3DEP products", async () => {
    const [osm, elevation, regions] = await Promise.all([
      readOsmSourceConfig(path.join(RAINIER_GOAT_ROCKS_REGION_ROOT, "osm-source.json")),
      readElevationSourceConfig(path.join(RAINIER_GOAT_ROCKS_REGION_ROOT, "elevation-source.json")),
      readSearchRegionInput(path.join(RAINIER_GOAT_ROCKS_REGION_ROOT, "search-regions.json")),
    ]);
    expect(osm).toMatchObject({
      id: "geofabrik-washington-osm",
      version: "washington-260801",
      upstreamTimestamp: "2026-08-01T20:21:21.000Z",
      expectedByteLength: 359826867,
    });
    expect(elevation).toMatchObject({
      cacheNamespace: "rainier-goat-rocks-elevation",
      bbox: [-122.0849597, 46.3163758, -120.9891357, 47.456977],
      expectedProductIds: [
        "689d4592d4be027ac1589948",
        "689d4592d4be027ac1589946",
        "689d4592d4be027ac1589944",
        "689d4591d4be027ac158993e",
        "6604fa8bd34e64ff154955e1",
      ],
    });
    expect(regions.regions.map(({ namedAreaId }) => namedAreaId)).toEqual(["pack:rainier-goat-rocks"]);
  });

  it("records exact and impossible checks for each reviewed OSM trailhead cluster", async () => {
    const input = JSON.parse(await readFile(path.join(RAINIER_GOAT_ROCKS_REGION_ROOT, "scenarios.json"), "utf8")) as {
      packId: string;
      scenarios: Array<{
        id: string;
        cluster: string;
        referencePoint: { coordinates: [number, number] };
        searchRegionId: string;
        exactExpectation: { result: string };
        impossibleExpectation: { result: string };
      }>;
    };
    expect(input.packId).toBe("rainier-goat-rocks");
    expect(input.scenarios.map(({ id }) => id)).toEqual([
      "longmire-paradise", "mowich-carbon", "sunrise-white-river", "ohanapecosh",
      "chinook-naches", "greenwater-norse-peak", "white-pass", "goat-rocks-snowgrass",
      "goat-rocks-walupt",
    ]);
    expect(new Set(input.scenarios.map(({ cluster }) => cluster)).size).toBe(input.scenarios.length);
    const boundary = parseRegionalBoundary(
      RAINIER_GOAT_ROCKS_PACK_CONFIG,
      await readFile(path.join(RAINIER_GOAT_ROCKS_REGION_ROOT, "boundary.geojson"), "utf8"),
    );
    for (const scenario of input.scenarios) {
      expect(pointInArea(scenario.referencePoint.coordinates, boundary.geometry)).toBe(true);
      expect(scenario.searchRegionId).toBe("pack:rainier-goat-rocks");
      expect(scenario.exactExpectation.result).toBe("at-least-one-exact");
      expect(scenario.impossibleExpectation.result).toBe("near-miss-only");
    }
  });
});
