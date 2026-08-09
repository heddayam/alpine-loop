import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { SourceSnapshot } from "./adapters";
import { areaGeometryBounds } from "./area-geometry";
import { basicRegionalDataVersion, createBasicRegionalPackSeed, parseBasicRegionalBoundary } from "./basic-regional-pack";
import { readElevationSourceConfig } from "./elevation";
import { HENRY_COE_PACK_CONFIG, HENRY_COE_REGION_ROOT, buildHenryCoePack } from "./henry-coe-pack";
import { readOsmSourceConfig } from "./osm";
import { readSearchRegionInput } from "./search-regions";

function snapshot(id: string, marker: string): SourceSnapshot {
  return {
    id,
    authority: `${id} authority`,
    dataset: `${id} dataset`,
    version: "v1",
    retrievedAt: "2026-08-08T00:00:00Z",
    url: `https://example.test/${id}`,
    license: `${id} license`,
    contentHash: `sha256:${marker.repeat(64)}`,
    localPath: `/unused/${id}`,
  };
}

describe("Henry Coe pack wiring", () => {
  it("validates the coherent Henry Coe and Coyote Lake boundary and reviewed regions", async () => {
    const boundaryContents = await readFile(path.join(HENRY_COE_REGION_ROOT, "boundary.geojson"), "utf8");
    const boundary = parseBasicRegionalBoundary(HENRY_COE_PACK_CONFIG, boundaryContents);
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

  it("pins the schema-6 portal pipeline and hashes deterministic inputs independently of order", async () => {
    const boundaryContents = await readFile(path.join(HENRY_COE_REGION_ROOT, "boundary.geojson"), "utf8");
    const boundary = parseBasicRegionalBoundary(HENRY_COE_PACK_CONFIG, boundaryContents).geometry;
    const snapshots = [snapshot("source-b", "b"), snapshot("source-a", "a")];
    const version = basicRegionalDataVersion(
      HENRY_COE_PACK_CONFIG,
      boundaryContents,
      "regions",
      snapshots,
      ["adapter-b", "adapter-a"],
      ["metric-b", "metric-a"],
    );
    expect(version).toMatch(/^hc-[a-f0-9]{16}$/);
    expect(basicRegionalDataVersion(
      HENRY_COE_PACK_CONFIG,
      boundaryContents,
      "regions",
      [...snapshots].reverse(),
      ["adapter-a", "adapter-b"],
      ["metric-a", "metric-b"],
    )).toBe(version);

    const seed = createBasicRegionalPackSeed({
      config: HENRY_COE_PACK_CONFIG,
      boundary,
      boundaryContents,
      searchRegionContents: "regions",
      snapshots,
      adapterVersions: ["adapter-a"],
      metricVersions: ["metric-a"],
    });
    expect(seed).toMatchObject({
      schemaVersion: "6",
      id: "henry-coe",
      capabilities: {
        officialAccess: false,
        portalAccessPoints: true,
        elevationProfiles: true,
      },
    });
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
