import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { areaGeometryBounds } from "./area-geometry";
import { parseRegionalBoundary } from "./regional-builder";
import {
  CENTRAL_CASCADES_PACK_CONFIG,
  CENTRAL_CASCADES_REGION_ROOT,
  buildCentralCascadesPack,
} from "./central-cascades-pack";
import { readElevationSourceConfig } from "./elevation";
import { readOsmSourceConfig } from "./osm";
import { readOfficialTrailConflationPolicy, readOfficialTrailSourceConfig } from "./official-trails";
import { readSearchRegionInput } from "./search-regions";

describe("Central Cascades pack wiring", () => {
  it("validates the reviewed cross-crest boundary, sources, and search regions", async () => {
    expect(CENTRAL_CASCADES_PACK_CONFIG).toEqual({
      id: "central-cascades",
      name: "Central Cascades",
      dataVersionPrefix: "cc",
      compilerVersion: "basic-regional-pack-compiler-v1",
      boundaryVersion: "central-cascades-boundary-v1",
      regionRoot: CENTRAL_CASCADES_REGION_ROOT,
      display: { center: [-121.2, 47.75], zoom: 7.5 },
      officialTrails: {
        sourceConfigPath: path.join(CENTRAL_CASCADES_REGION_ROOT, "official-trail-source.json"),
        conflationPolicyPath: path.join(CENTRAL_CASCADES_REGION_ROOT, "official-trail-conflation.json"),
      },
    });
    expect(CENTRAL_CASCADES_REGION_ROOT).toMatch(/data\/regions\/central-cascades$/);

    const boundaryContents = await readFile(path.join(CENTRAL_CASCADES_REGION_ROOT, "boundary.geojson"), "utf8");
    const boundary = parseRegionalBoundary(CENTRAL_CASCADES_PACK_CONFIG, boundaryContents);
    expect(boundary.geometry.type).toBe("Polygon");
    expect(areaGeometryBounds(boundary.geometry)).toEqual([
      -121.73319523634241,
      47.19654585917808,
      -120.5276988,
      48.4758823,
    ]);

    const [osm, elevation, searchRegions, officialTrails, conflationPolicy] = await Promise.all([
      readOsmSourceConfig(path.join(CENTRAL_CASCADES_REGION_ROOT, "osm-source.json")),
      readElevationSourceConfig(path.join(CENTRAL_CASCADES_REGION_ROOT, "elevation-source.json")),
      readSearchRegionInput(path.join(CENTRAL_CASCADES_REGION_ROOT, "search-regions.json")),
      readOfficialTrailSourceConfig(path.join(CENTRAL_CASCADES_REGION_ROOT, "official-trail-source.json")),
      readOfficialTrailConflationPolicy(path.join(CENTRAL_CASCADES_REGION_ROOT, "official-trail-conflation.json")),
    ]);
    expect(osm).toMatchObject({
      id: "geofabrik-washington-osm",
      version: "washington-260801",
      upstreamTimestamp: "2026-08-01T20:21:21.000Z",
      url: "https://download.geofabrik.de/north-america/us/washington-260801.osm.pbf",
      expectedByteLength: 359826867,
    });
    expect(elevation).toMatchObject({
      cacheNamespace: "central-cascades-elevation",
      expectedProductIds: [
        "689d4591d4be027ac1589940",
        "689d4591d4be027ac158993e",
        "689d4591d4be027ac158993a",
        "689d4590d4be027ac1589938",
      ],
    });
    expect(searchRegions.regions.map(({ namedAreaId }) => namedAreaId)).toEqual([
      "pack:central-cascades",
      "osm:relation/6115914",
      "osm:relation/6112652",
      "osm:relation/6437099",
    ]);
    expect(officialTrails).toMatchObject({
      kind: "usgs-national-digital-trails",
      version: "2026-07-central-cascades",
      expectedSha256: "sha256:4e52617e13761a7512f143d3e818719391655a68e00d9a1b2291abb7e8bf215a",
    });
    expect(conflationPolicy).toMatchObject({
      representedDistanceM: 100,
      internalConnectionDistanceM: 50,
      maximumConnectionAngleDegrees: 45,
      minimumGapLengthM: 500,
    });
    expect(buildCentralCascadesPack).toEqual(expect.any(Function));
  });

  it("defines one exact and impossible search for every required trail cluster", async () => {
    const input = JSON.parse(await readFile(path.join(CENTRAL_CASCADES_REGION_ROOT, "scenarios.json"), "utf8")) as {
      packId: string;
      scenarios: Array<{
        id: string;
        cluster: string;
        exactExpectation?: { result?: string };
        impossibleExpectation?: { result?: string };
      }>;
    };
    expect(input.packId).toBe("central-cascades");
    expect(input.scenarios.map(({ id }) => id)).toEqual([
      "east-glacier-peak-white-river",
      "chiwawa-spider-meadow",
      "west-glacier-peak-north-fork-sauk",
      "stevens-pass",
      "icicle-enchantments",
      "snoqualmie-alpine-lakes",
      "cle-elum-pete-lake",
      "teanaway-west-fork",
    ]);
    expect(new Set(input.scenarios.map(({ cluster }) => cluster)).size).toBe(input.scenarios.length);
    expect(input.scenarios.every(({ exactExpectation, impossibleExpectation }) =>
      exactExpectation?.result === "at-least-one-exact"
      && impossibleExpectation?.result === "near-miss-only")).toBe(true);
  });
});
