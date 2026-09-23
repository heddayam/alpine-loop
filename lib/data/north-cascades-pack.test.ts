import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { areaGeometryBounds, pointInArea } from "./area-geometry";
import { readElevationSourceConfig } from "./elevation";
import { readOsmSourceConfig } from "./osm";
import { parseRegionalBoundary } from "./regional-builder";
import { readSearchRegionInput } from "./search-regions";
import {
  NORTH_CASCADES_PACK_CONFIG,
  NORTH_CASCADES_REGION_ROOT,
  buildNorthCascadesPack,
} from "./north-cascades-pack";

describe("North Cascades pack inputs", () => {
  it("pins the reviewed boundary, Washington snapshot, elevation products, and named areas", async () => {
    expect(NORTH_CASCADES_PACK_CONFIG).toMatchObject({
      id: "north-cascades",
      name: "North Cascades",
      dataVersionPrefix: "nc",
      compilerVersion: "basic-regional-pack-compiler-v1",
      boundaryVersion: "north-cascades-boundary-v2",
      regionRoot: NORTH_CASCADES_REGION_ROOT,
    });
    expect(buildNorthCascadesPack).toEqual(expect.any(Function));

    const [contents, osm, elevation, searchRegions] = await Promise.all([
      readFile(path.join(NORTH_CASCADES_REGION_ROOT, "boundary.geojson"), "utf8"),
      readOsmSourceConfig(path.join(NORTH_CASCADES_REGION_ROOT, "osm-source.json")),
      readElevationSourceConfig(path.join(NORTH_CASCADES_REGION_ROOT, "elevation-source.json")),
      readSearchRegionInput(path.join(NORTH_CASCADES_REGION_ROOT, "search-regions.json")),
    ]);
    const boundary = parseRegionalBoundary(NORTH_CASCADES_PACK_CONFIG, contents);
    expect(boundary.geometry.type).toBe("Polygon");
    expect(areaGeometryBounds(boundary.geometry)).toEqual([-122.12, 48.015, -119.78, 49]);
    // The southern lobe retains both legs of the PCT–South Fork Agnes cycle.
    expect(pointInArea([-120.95732, 48.24123], boundary.geometry)).toBe(true);
    expect(pointInArea([-120.93717, 48.21307], boundary.geometry)).toBe(true);
    expect(osm).toMatchObject({
      id: "geofabrik-washington-osm",
      version: "washington-260801",
      upstreamTimestamp: "2026-08-01T20:21:21.000Z",
      url: "https://download.geofabrik.de/north-america/us/washington-260801.osm.pbf",
      expectedByteLength: 359826867,
    });
    expect(elevation).toMatchObject({
      cacheNamespace: "north-cascades-elevation",
      bbox: [-122.12, 48.015, -119.78, 49],
      expectedProductIds: [
        "689d4591d4be027ac158993c",
        "689d4591d4be027ac158993a",
        "689d4590d4be027ac1589938",
        "6604fa86d34e64ff154955db",
      ],
    });
    expect(searchRegions.regions.map(({ namedAreaId }) => namedAreaId)).toEqual([
      "pack:north-cascades",
      "osm:relation/2421537",
      "osm:relation/6116357",
      "osm:relation/6116548",
      "osm:relation/6116621",
    ]);
  });

  it("keeps every provisional route anchor inside exact coverage", async () => {
    const boundary = parseRegionalBoundary(
      NORTH_CASCADES_PACK_CONFIG,
      await readFile(path.join(NORTH_CASCADES_REGION_ROOT, "boundary.geojson"), "utf8"),
    );
    const input = JSON.parse(await readFile(path.join(NORTH_CASCADES_REGION_ROOT, "scenarios.json"), "utf8")) as {
      packId: string;
      scenarios: Array<{
        id: string;
        referencePoint: { coordinates: [number, number] };
        searchRegionId: string;
        exactExpectation: { result: string; distanceMiles: { max: number } };
        impossibleExpectation: { result: string };
      }>;
    };
    expect(input.packId).toBe("north-cascades");
    expect(input.scenarios).toHaveLength(9);
    expect(new Set(input.scenarios.map(({ id }) => id)).size).toBe(9);
    for (const scenario of input.scenarios) {
      expect(pointInArea(scenario.referencePoint.coordinates, boundary.geometry), scenario.id).toBe(true);
      expect(scenario.searchRegionId).toBe("pack:north-cascades");
      expect(scenario.exactExpectation.result).toBe("at-least-one-exact");
      expect(scenario.exactExpectation.distanceMiles.max).toBeLessThanOrEqual(30);
      expect(scenario.impossibleExpectation.result).toBe("near-miss-only");
    }
  });
});
