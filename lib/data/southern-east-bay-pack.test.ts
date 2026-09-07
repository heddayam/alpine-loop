import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readOfficialSourceConfigs } from "./authorities";
import { areaGeometryBounds, assertValidAreaGeometry } from "./area-geometry";
import { readCuratedAccessFile } from "./curated-access";
import { readElevationSourceConfig } from "./elevation";
import { readOsmSourceConfig } from "./osm";
import { readSearchRegionInput } from "./search-regions";
import {
  SOUTHERN_EAST_BAY_ENTRANCE_SOURCE_SET,
  SOUTHERN_EAST_BAY_REGION_ROOT,
  SOUTHERN_EAST_BAY_PACK_CONFIG,
  buildSouthernEastBayPack,
} from "./southern-east-bay-pack";
import type { NormalizedTopology } from "./types";

describe("Southern East Bay pack wiring", () => {
  it("owns an entrance-only optional source set with no live line source", async () => {
    expect(SOUTHERN_EAST_BAY_ENTRANCE_SOURCE_SET).toEqual({
      configRoot: path.join(SOUTHERN_EAST_BAY_REGION_ROOT, "official-sources"),
      filenames: ["ebrpd-park-entrances.json"],
      cacheNamespace: "southern-east-bay-official-access",
    });
    const configs = await readOfficialSourceConfigs(SOUTHERN_EAST_BAY_ENTRANCE_SOURCE_SET);
    expect(configs.map(({ id }) => id)).toEqual(["ebrpd-park-entrances"]);
    await expect(readFile(path.join(
      SOUTHERN_EAST_BAY_REGION_ROOT,
      "official-sources/ebrpd-roads-and-trails.json",
    ))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(path.join(SOUTHERN_EAST_BAY_REGION_ROOT, "current-closures.json")))
      .rejects.toMatchObject({ code: "ENOENT" });

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

    const [osm, elevation, searchRegions] = await Promise.all([
      readOsmSourceConfig(path.join(SOUTHERN_EAST_BAY_REGION_ROOT, "osm-source.json")),
      readElevationSourceConfig(path.join(SOUTHERN_EAST_BAY_REGION_ROOT, "elevation-source.json")),
      readSearchRegionInput(path.join(SOUTHERN_EAST_BAY_REGION_ROOT, "search-regions.json")),
    ]);
    expect(osm.version).toBe("norcal-260801");
    expect(elevation.cacheNamespace).toBe("southern-east-bay-elevation");
    expect(searchRegions.regions.map(({ namedAreaId }) => namedAreaId)).toEqual([
      "pack:southern-east-bay",
      "osm:relation/11518106",
      "osm:relation/317363",
      "osm:relation/226483",
    ]);
    expect(buildSouthernEastBayPack).toEqual(expect.any(Function));
  });

  it("pins exactly the 45 effective restrictive changes and the three reviewed closures", async () => {
    const curated = await readCuratedAccessFile(path.join(
      SOUTHERN_EAST_BAY_REGION_ROOT,
      "access-restrictions.json",
    ), SOUTHERN_EAST_BAY_PACK_CONFIG.restrictions!.contentHash);
    expect(curated.snapshot.id).toBe("ebrpd-reviewed-access-removals-2026-08-07");
    expect(curated.restrictions).toHaveLength(45);
    expect(curated.restrictions.filter(({ accessState }) => accessState === "prohibited")).toHaveLength(42);
    expect(curated.restrictions.filter(({ accessState }) => accessState === "closed").map(({ externalId }) => externalId))
      .toEqual(["way/133590543", "way/284501998", "way/284501999"]);
    expect(curated.restrictions.map(({ externalId }) => externalId)).toEqual([
      "way/6321494", "way/6324361", "way/6389637", "way/8948809", "way/41743274",
      "way/41743275", "way/97347653", "way/113342002", "way/116321805", "way/116321809",
      "way/116327940", "way/123422404", "way/127025640", "way/133590543", "way/166094137",
      "way/173113945", "way/174698087", "way/180780788", "way/180781999", "way/185941638",
      "way/284501998", "way/284501999", "way/328514386", "way/508347184", "way/598427275",
      "way/685008813", "way/685009651", "way/850345234", "way/926545582", "way/926545585",
      "way/926545587", "way/1036134755", "way/1036134757", "way/1059466026", "way/1122932141",
      "way/1122932143", "way/1123796332", "way/1123796333", "way/1123798513", "way/1123998868",
      "way/1195647753", "way/1293787608", "way/1293787609", "way/1375487755", "way/1378753436",
    ]);
  });

  it("requires useful portal coverage in all three regional corridors", async () => {
    const boundary = assertValidAreaGeometry(JSON.parse(await readFile(path.join(SOUTHERN_EAST_BAY_REGION_ROOT, "boundary.geojson"), "utf8")).geometry);
    const topology: NormalizedTopology = {
      nodes: [[-121.90, 37.52], [-121.80, 37.53], [-121.70, 37.60]].map(([lon, lat], index) => ({
        id: String(index), externalId: String(index), lon: lon!, lat: lat!, elevationM: null, sourceRefs: ["osm"], flags: [],
      })),
      ways: [], rejectedWayCount: 0,
      accessPoints: [0, 1, 2].map((index) => ({
        id: `portal:${index}`, externalId: String(index), nodeId: String(index), name: "Portal",
        kind: "trailhead", accessState: "unknown", confidence: "low", parkingEvidence: null, sourceRefs: ["osm"],
      })),
    };
    expect(SOUTHERN_EAST_BAY_PACK_CONFIG.checkPortals!(topology, boundary)).toMatchObject({
      corridor: { westernFoothills: 1, sunolOhlone: 1, delValle: 1 },
    });
    expect(() => SOUTHERN_EAST_BAY_PACK_CONFIG.checkPortals!({ ...topology, accessPoints: topology.accessPoints.slice(1) }, boundary))
      .toThrow("Portal inventory is not regionally useful");
  });
});
