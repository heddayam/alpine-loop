import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { SourceSnapshot } from "./adapters";
import { areaGeometryBounds } from "./area-geometry";
import { basicRegionalDataVersion, createBasicRegionalPackSeed, parseBasicRegionalBoundary } from "./basic-regional-pack";
import {
  CENTRAL_CASCADES_PACK_CONFIG,
  CENTRAL_CASCADES_REGION_ROOT,
  buildCentralCascadesPack,
} from "./central-cascades-pack";
import { readElevationSourceConfig } from "./elevation";
import { readOsmSourceConfig } from "./osm";
import { readSearchRegionInput } from "./search-regions";

function snapshot(id: string, marker: string): SourceSnapshot {
  return {
    id,
    authority: `${id} authority`,
    dataset: `${id} dataset`,
    version: "v1",
    retrievedAt: "2026-08-10T00:00:00Z",
    url: `https://example.test/${id}`,
    license: `${id} license`,
    contentHash: `sha256:${marker.repeat(64)}`,
    localPath: `/unused/${id}`,
  };
}

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
    });
    expect(CENTRAL_CASCADES_REGION_ROOT).toMatch(/data\/regions\/central-cascades$/);

    const boundaryContents = await readFile(path.join(CENTRAL_CASCADES_REGION_ROOT, "boundary.geojson"), "utf8");
    const boundary = parseBasicRegionalBoundary(CENTRAL_CASCADES_PACK_CONFIG, boundaryContents);
    expect(boundary.geometry.type).toBe("Polygon");
    expect(areaGeometryBounds(boundary.geometry)).toEqual([
      -121.73319523634241,
      47.19654585917808,
      -120.5276988,
      48.4758823,
    ]);

    const [osm, elevation, searchRegions] = await Promise.all([
      readOsmSourceConfig(path.join(CENTRAL_CASCADES_REGION_ROOT, "osm-source.json")),
      readElevationSourceConfig(path.join(CENTRAL_CASCADES_REGION_ROOT, "elevation-source.json")),
      readSearchRegionInput(path.join(CENTRAL_CASCADES_REGION_ROOT, "search-regions.json")),
    ]);
    expect(osm).toMatchObject({ id: "geofabrik-washington-osm", version: "washington-260806" });
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
    expect(buildCentralCascadesPack).toEqual(expect.any(Function));
  });

  it("pins schema 6 and hashes seed inputs independently of source and version order", async () => {
    const snapshots = [snapshot("washington-osm", "a"), snapshot("usgs-3dep", "b")];
    const boundaryContents = await readFile(path.join(CENTRAL_CASCADES_REGION_ROOT, "boundary.geojson"), "utf8");
    const boundary = parseBasicRegionalBoundary(CENTRAL_CASCADES_PACK_CONFIG, boundaryContents).geometry;
    const searchRegionContents = JSON.stringify({ packId: "central-cascades", regions: [] });
    const version = basicRegionalDataVersion(
      CENTRAL_CASCADES_PACK_CONFIG,
      boundaryContents,
      searchRegionContents,
      snapshots,
      ["topology-v1", "portals-v1"],
      ["elevation-v1", "buildings-v1"],
    );

    expect(version).toMatch(/^cc-[a-f0-9]{16}$/);
    expect(basicRegionalDataVersion(
      CENTRAL_CASCADES_PACK_CONFIG,
      boundaryContents,
      searchRegionContents,
      [...snapshots].reverse(),
      ["portals-v1", "topology-v1"],
      ["buildings-v1", "elevation-v1"],
    )).toBe(version);

    const seed = createBasicRegionalPackSeed({
      config: CENTRAL_CASCADES_PACK_CONFIG,
      boundary,
      boundaryContents,
      searchRegionContents,
      snapshots,
      adapterVersions: ["topology-v1", "portals-v1"],
      metricVersions: ["elevation-v1", "buildings-v1"],
    });
    expect(seed).toMatchObject({
      schemaVersion: "6",
      id: "central-cascades",
      name: "Central Cascades",
      dataVersion: version,
      compilerVersion: "basic-regional-pack-compiler-v1",
      display: { center: [-121.2, 47.75], zoom: 7.5 },
      capabilities: {
        elevation: true,
        officialAccess: false,
        namedAreas: true,
        closedRouteTopology: true,
        batchSearchRegions: true,
        elevationProfiles: true,
        portalAccessPoints: true,
      },
    });
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
