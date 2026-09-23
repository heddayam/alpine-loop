import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { areaGeometryBounds, pointInArea } from "./area-geometry";
import { readElevationSourceConfig } from "./elevation";
import { readOsmSourceConfig } from "./osm";
import { parseRegionalBoundary } from "./regional-builder";
import { readSearchRegionInput } from "./search-regions";
import {
  OLYMPIC_PENINSULA_PACK_CONFIG,
  OLYMPIC_PENINSULA_REGION_ROOT,
  buildOlympicPeninsulaPack,
} from "./olympic-peninsula-pack";

describe("Olympic Peninsula pack inputs", () => {
  it("keeps the coastal Ozette cycle inside reviewed coverage and validates pinned inputs", async () => {
    const root = OLYMPIC_PENINSULA_REGION_ROOT;
    const boundary = parseRegionalBoundary(
      OLYMPIC_PENINSULA_PACK_CONFIG,
      await readFile(path.join(root, "boundary.geojson"), "utf8"),
    );
    expect(boundary.geometry.type).toBe("MultiPolygon");
    expect(areaGeometryBounds(boundary.geometry)).toEqual([
      -124.7425886, 47.2992132, -122.8837697, 48.2752636,
    ]);
    for (const point of [
      [-124.66889, 48.15519], // Ozette trail parking
      [-124.73165, 48.16069], // Cape Alava beach junction
      [-124.70834, 48.12736], // Sand Point beach junction
      [-124.63798, 47.92101], // Rialto day-use parking
    ] as const) expect(pointInArea(point, boundary.geometry)).toBe(true);
    expect(pointInArea([-124.6809, 48.2917], boundary.geometry)).toBe(false); // Shi Shi tribal approach

    const [osm, elevation, searchRegions] = await Promise.all([
      readOsmSourceConfig(path.join(root, "osm-source.json")),
      readElevationSourceConfig(path.join(root, "elevation-source.json")),
      readSearchRegionInput(path.join(root, "search-regions.json")),
    ]);
    expect(osm).toMatchObject({ version: "washington-260801", expectedByteLength: 359826867 });
    expect(elevation.expectedProductIds).toHaveLength(6);
    expect(elevation.cacheNamespace).toBe("olympic-peninsula-elevation");
    expect(searchRegions.regions.map(({ namedAreaId }) => namedAreaId)).toEqual([
      "pack:olympic-peninsula",
      "osm:relation/6122342",
      "osm:relation/6122955",
      "osm:relation/6122367",
    ]);
    expect(buildOlympicPeninsulaPack).toEqual(expect.any(Function));
  });

  it("has explicit exact and impossible route checkpoints", async () => {
    const scenarios = JSON.parse(await readFile(path.join(OLYMPIC_PENINSULA_REGION_ROOT, "scenarios.json"), "utf8")) as {
      packId: string;
      scenarios: Array<{ id: string; exactExpectation: { result: string }; impossibleExpectation: { result: string } }>;
    };
    expect(scenarios.packId).toBe("olympic-peninsula");
    expect(scenarios.scenarios.some(({ id }) => id === "ozette-triangle")).toBe(true);
    expect(scenarios.scenarios.every(({ exactExpectation, impossibleExpectation }) =>
      exactExpectation.result === "at-least-one-exact"
      && impossibleExpectation.result === "near-miss-only")).toBe(true);
  });
});
