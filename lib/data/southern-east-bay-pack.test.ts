import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { NormalizedAccessEvidence, SourceSnapshot } from "./adapters";
import { readOfficialSourceConfigs } from "./authorities";
import { areaGeometryBounds, assertValidAreaGeometry } from "./area-geometry";
import { readCuratedAccessFile, type CuratedAccessRestriction } from "./curated-access";
import { readElevationSourceConfig } from "./elevation";
import { readOsmSourceConfig } from "./osm";
import { readPopulationSourceConfig } from "./population";
import { readSearchRegionInput } from "./search-regions";
import {
  SOUTHERN_EAST_BAY_ENTRANCE_SOURCE_SET,
  SOUTHERN_EAST_BAY_REGION_ROOT,
  SOUTHERN_EAST_BAY_SCHEMA_VERSION,
  buildSouthernEastBayPack,
  createSouthernEastBayPackSeed,
  prepareSouthernEastBayPortalTopology,
  southernEastBayDataVersion,
} from "./southern-east-bay-pack";
import type { NormalizedNode, NormalizedTopology, NormalizedWay } from "./types";

const METERS_PER_LONGITUDE_DEGREE = 111_195;

function node(id: string, eastM: number, northM = 0): NormalizedNode {
  return {
    id,
    externalId: `node/${id}`,
    lon: eastM / METERS_PER_LONGITUDE_DEGREE,
    lat: northM / METERS_PER_LONGITUDE_DEGREE,
    elevationM: null,
    flags: [],
    sourceRefs: ["osm"],
  };
}

function way(
  id: string,
  externalId: string,
  nodeIds: string[],
  nodes: readonly NormalizedNode[],
  edgeClass: NonNullable<NormalizedWay["edgeClass"]>,
  accessState: NormalizedWay["accessState"] = "unknown",
): NormalizedWay {
  const nodesById = new Map(nodes.map((item) => [item.id, item]));
  return {
    id,
    externalId,
    nodeIds,
    coordinates: nodeIds.map((nodeId) => {
      const item = nodesById.get(nodeId)!;
      return [item.lon, item.lat] as const;
    }),
    name: null,
    accessState,
    bidirectional: true,
    edgeClass,
    sourceRefs: ["osm"],
    flags: [],
  };
}

function review(externalId: string, accessState: "closed" | "private" | "prohibited"): CuratedAccessRestriction {
  return {
    externalId,
    accessState,
    reason: "Reviewed restrictive access",
    review: {
      reviewedAt: "2026-08-07T00:00:00Z",
      reviewer: "Southern East Bay test review",
    },
  };
}

function snapshot(id: string, version = "v1"): SourceSnapshot {
  return {
    id,
    authority: "Test authority",
    dataset: "Test dataset",
    version,
    retrievedAt: "2026-08-07T00:00:00Z",
    url: `https://example.test/${id}`,
    license: "Test facts",
    contentHash: `sha256:${(id === "a" ? "a" : "b").repeat(64)}`,
    localPath: `/tmp/${id}`,
  };
}

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
    const implementation = await readFile(path.resolve("lib/data/southern-east-bay-pack.ts"), "utf8");
    expect(implementation).not.toContain("matchOfficialAccessToOsm");
    expect(implementation).not.toContain("PreparedOfficialAccessAdapter");
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

    const [osm, elevation, population, searchRegions] = await Promise.all([
      readOsmSourceConfig(path.join(SOUTHERN_EAST_BAY_REGION_ROOT, "osm-source.json")),
      readElevationSourceConfig(path.join(SOUTHERN_EAST_BAY_REGION_ROOT, "elevation-source.json")),
      readPopulationSourceConfig(path.join(SOUTHERN_EAST_BAY_REGION_ROOT, "population-source.json")),
      readSearchRegionInput(path.join(SOUTHERN_EAST_BAY_REGION_ROOT, "search-regions.json")),
    ]);
    expect(osm.version).toBe("norcal-260801");
    expect(elevation.cacheNamespace).toBe("southern-east-bay-elevation");
    expect(population.cacheNamespace).toBe("southern-east-bay-population");
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
    ));
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

  it("applies restrictions before portals and lets names neither create nor reopen starts", () => {
    const nodes = [node("start", 0), node("trail-end", -300), node("road-end", 0, 100)];
    const topology: NormalizedTopology = {
      nodes,
      ways: [
        way("trail", "way/100", ["trail-end", "start"], nodes, "trail"),
        way("street", "way/200", ["start", "road-end"], nodes, "street", "public"),
      ],
      accessPoints: [],
      portalEvidence: [],
      rejectedWayCount: 0,
    };
    const entrances: NormalizedAccessEvidence[] = [
      {
        sourceId: "entrance-names",
        externalId: "near",
        lon: 10 / METERS_PER_LONGITUDE_DEGREE,
        lat: 0,
        name: "Official Entrance",
        accessState: "public",
        confidence: "high",
      },
      {
        sourceId: "entrance-names",
        externalId: "far",
        lon: 1_000 / METERS_PER_LONGITUDE_DEGREE,
        lat: 0,
        name: "Far Entrance",
        accessState: "public",
        confidence: "high",
      },
    ];

    const prepared = prepareSouthernEastBayPortalTopology(
      topology,
      "curated-removals",
      [review("way/100", "prohibited")],
      entrances,
    );

    expect(prepared.topology.accessPoints).toHaveLength(1);
    expect(prepared.topology.accessPoints[0]).toMatchObject({
      name: "Official Entrance",
      accessState: "prohibited",
      sourceRefs: ["curated-removals", "entrance-names", "osm"],
    });
    expect(prepared.topology.ways.map(({ id }) => id)).toEqual(["trail"]);
    expect(prepared.report).toMatchObject({
      restrictionCount: 1,
      portalCount: 1,
      entranceNameInputCount: 2,
      namedOverlayCount: 1,
      unmatchedEntranceNameCount: 1,
      buildContext: {
        trailWayCount: 1,
        streetWayCount: 1,
        publishedWayCount: 1,
        strippedWayCount: 1,
      },
    });
  });

  it("emits schema 6 portal capabilities and hashes versions deterministically", async () => {
    const boundaryFile = JSON.parse(await readFile(
      path.join(SOUTHERN_EAST_BAY_REGION_ROOT, "boundary.geojson"),
      "utf8",
    )) as { geometry: unknown };
    const boundary = assertValidAreaGeometry(boundaryFile.geometry);
    const snapshots = [snapshot("a"), snapshot("b")];
    const firstVersion = southernEastBayDataVersion("boundary", "regions", snapshots, ["z", "a"], ["m2", "m1"]);
    const secondVersion = southernEastBayDataVersion(
      "boundary",
      "regions",
      [...snapshots].reverse(),
      ["a", "z"],
      ["m1", "m2"],
    );
    expect(firstVersion).toBe(secondVersion);

    const seed = createSouthernEastBayPackSeed({
      boundary,
      boundaryContents: "boundary",
      searchRegionContents: "regions",
      snapshots,
      adapterVersions: ["z", "a"],
      metricVersions: ["m2", "m1"],
    });
    expect(SOUTHERN_EAST_BAY_SCHEMA_VERSION).toBe("6");
    expect(seed).toMatchObject({
      schemaVersion: "6",
      dataVersion: firstVersion,
      compilerVersion: "southern-east-bay-pack-compiler-v3",
      capabilities: { portalAccessPoints: true, elevationProfiles: true },
    });
  });
});
