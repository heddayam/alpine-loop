import { describe, expect, it } from "vitest";
import type { SourceSnapshot } from "./adapters";
import type { AreaGeometry } from "./area-geometry";
import { basicRegionalDataVersion, createBasicRegionalPackSeed } from "./basic-regional-pack";
import {
  CENTRAL_CASCADES_PACK_CONFIG,
  CENTRAL_CASCADES_REGION_ROOT,
  buildCentralCascadesPack,
} from "./central-cascades-pack";

const boundary: AreaGeometry = {
  type: "Polygon",
  coordinates: [[
    [-122.4, 46.9],
    [-120.2, 46.9],
    [-120.2, 48.5],
    [-122.4, 48.5],
    [-122.4, 46.9],
  ]],
};

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
  it("configures the generic cross-crest regional builder", () => {
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
    expect(buildCentralCascadesPack).toEqual(expect.any(Function));
  });

  it("pins schema 6 and hashes seed inputs independently of source and version order", () => {
    const snapshots = [snapshot("washington-osm", "a"), snapshot("usgs-3dep", "b")];
    const boundaryContents = JSON.stringify({
      type: "Feature",
      properties: {
        id: CENTRAL_CASCADES_PACK_CONFIG.id,
        boundaryVersion: CENTRAL_CASCADES_PACK_CONFIG.boundaryVersion,
      },
      geometry: boundary,
    });
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
});
