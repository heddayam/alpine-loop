import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  MONTEREY_REVIEWED_ACCESS_AUTHORITY,
  MONTEREY_REVIEWED_ACCESS_CONTENT_HASH,
  MONTEREY_REVIEWED_ACCESS_DATASET,
  MONTEREY_REVIEWED_ACCESS_RELATIVE_PATH,
  MONTEREY_REVIEWED_ACCESS_REVIEWED_AT,
  MONTEREY_REVIEWED_ACCESS_SOURCE_ID,
  MONTEREY_REVIEWED_ACCESS_SOURCE_URL,
  MONTEREY_REVIEWED_ACCESS_VERSION,
  MontereyReviewedAccessAdapter,
  montereyReviewedAccessSnapshot,
} from "./authorities";
import type { SourceSnapshot } from "./adapters";
import { areaGeometryBounds, assertValidAreaGeometry } from "./area-geometry";
import { applyCuratedAccessRestrictions, readCuratedAccessFile } from "./curated-access";
import { readElevationSourceConfig } from "./elevation";
import { sha256File } from "./file-source";
import {
  MONTEREY_CARMEL_COMPILER_VERSION,
  MONTEREY_CARMEL_PACK_SCHEMA_VERSION,
  MONTEREY_CARMEL_REGION_ROOT,
  buildMontereyCarmelPack,
  montereyCarmelDataVersion,
  montereyReviewedEntranceEvidence,
} from "./monterey-carmel-pack";
import { readOsmSourceConfig } from "./osm";
import { readPopulationSourceConfig } from "./population";
import { applyOfficialEntranceOverlay } from "./portals";
import { readSearchRegionInput } from "./search-regions";
import type { NormalizedTopology, NormalizedWay } from "./types";

function way(externalId: string): NormalizedWay {
  return {
    id: externalId,
    externalId,
    nodeIds: ["node/1", "node/2"],
    coordinates: [[-121.9, 36.5], [-121.89, 36.51]],
    name: "Rocky Ridge Trail",
    accessState: "unknown",
    bidirectional: true,
    edgeClass: "trail",
    sourceRefs: ["osm"],
    flags: [],
  };
}

function topology(ways: NormalizedWay[]): NormalizedTopology {
  return {
    nodes: [
      { id: "node/1", externalId: "node/1", lon: -121.9, lat: 36.5, elevationM: null, flags: [], sourceRefs: ["osm"] },
      { id: "node/2", externalId: "node/2", lon: -121.89, lat: 36.51, elevationM: null, flags: [], sourceRefs: ["osm"] },
    ],
    ways,
    accessPoints: [],
    portalEvidence: [],
    rejectedWayCount: 0,
  };
}

describe("Monterey–Carmel pack wiring", () => {
  it("has no live USFS source or pack dependency", async () => {
    const sourceFiles = await readdir(path.join(MONTEREY_CARMEL_REGION_ROOT, "official-sources"));
    expect(sourceFiles.filter((filename) => filename.includes("usfs"))).toEqual([]);
    const packSource = await readFile(path.join(process.cwd(), "lib/data/monterey-carmel-pack.ts"), "utf8");
    expect(packSource).not.toMatch(/MONTEREY_OFFICIAL_SOURCE_SET|MontereyLosPadresTrailsAdapter|readOfficialSourceSnapshots|matchOfficialAccessToOsm/);
    expect(packSource).toContain("additionalSources: [curatedAccess.snapshot, reviewedSnapshot]");
  });

  it("validates the exact boundary, reviewed regions, and regional source namespaces", async () => {
    const boundary = JSON.parse(await readFile(path.join(MONTEREY_CARMEL_REGION_ROOT, "boundary.geojson"), "utf8")) as {
      properties: { id: string; boundaryVersion: string };
      geometry: unknown;
    };
    expect(boundary.properties).toMatchObject({
      id: "monterey-carmel",
      boundaryVersion: "monterey-carmel-boundary-v1",
    });
    expect(areaGeometryBounds(assertValidAreaGeometry(boundary.geometry))).toEqual([
      -121.985, 36.32, -121.66, 36.715,
    ]);

    const [osm, elevation, population, searchRegions] = await Promise.all([
      readOsmSourceConfig(path.join(MONTEREY_CARMEL_REGION_ROOT, "osm-source.json")),
      readElevationSourceConfig(path.join(MONTEREY_CARMEL_REGION_ROOT, "elevation-source.json")),
      readPopulationSourceConfig(path.join(MONTEREY_CARMEL_REGION_ROOT, "population-source.json")),
      readSearchRegionInput(path.join(MONTEREY_CARMEL_REGION_ROOT, "search-regions.json")),
    ]);
    expect(osm.version).toBe("norcal-260801");
    expect(elevation.cacheNamespace).toBe("monterey-carmel-elevation");
    expect(population.cacheNamespace).toBe("monterey-carmel-population");
    expect(searchRegions.regions.map(({ namedAreaId }) => namedAreaId)).toEqual([
      "pack:monterey-carmel",
      "osm:relation/15100521",
      "osm:way/682362148",
      "osm:relation/13029412",
      "osm:relation/184336",
    ]);
    expect(buildMontereyCarmelPack).toEqual(expect.any(Function));
  });

  it("applies exactly the two curated Rocky Ridge closures", async () => {
    const curated = await readCuratedAccessFile(path.join(MONTEREY_CARMEL_REGION_ROOT, "access-restrictions.json"));
    expect(curated.snapshot).toMatchObject({
      id: "monterey-carmel-curated-access-restrictions-2026-08-07",
      authority: "California State Parks",
      version: "reviewed-2026-08-07-v1",
    });
    expect(curated.restrictions.map(({ externalId, accessState }) => ({ externalId, accessState }))).toEqual([
      { externalId: "way/55856070", accessState: "closed" },
      { externalId: "way/55856129", accessState: "closed" },
    ]);
    const original = topology([way("way/55856070"), way("way/55856129"), way("way/1")]);
    const restricted = applyCuratedAccessRestrictions(
      original,
      curated.snapshot.id,
      curated.restrictions,
    );
    expect(restricted.ways.map(({ externalId, accessState }) => ({ externalId, accessState }))).toEqual([
      { externalId: "way/55856070", accessState: "closed" },
      { externalId: "way/55856129", accessState: "closed" },
      { externalId: "way/1", accessState: "unknown" },
    ]);
  });

  it("uses reviewed records only as an entrance-name overlay that cannot create starts", async () => {
    const snapshot = montereyReviewedAccessSnapshot(MONTEREY_CARMEL_REGION_ROOT);
    expect(snapshot).toMatchObject({
      id: MONTEREY_REVIEWED_ACCESS_SOURCE_ID,
      authority: MONTEREY_REVIEWED_ACCESS_AUTHORITY,
      dataset: MONTEREY_REVIEWED_ACCESS_DATASET,
      version: MONTEREY_REVIEWED_ACCESS_VERSION,
      retrievedAt: MONTEREY_REVIEWED_ACCESS_REVIEWED_AT,
      url: MONTEREY_REVIEWED_ACCESS_SOURCE_URL,
      contentHash: MONTEREY_REVIEWED_ACCESS_CONTENT_HASH,
    });
    expect(snapshot.localPath).toBe(path.join(MONTEREY_CARMEL_REGION_ROOT, MONTEREY_REVIEWED_ACCESS_RELATIVE_PATH));
    expect(await sha256File(snapshot.localPath)).toBe(MONTEREY_REVIEWED_ACCESS_CONTENT_HASH);

    const normalized = await new MontereyReviewedAccessAdapter().normalize(snapshot);
    const entrances = montereyReviewedEntranceEvidence(normalized);
    expect(entrances).toHaveLength(10);
    expect(entrances.every(({ externalId, accessState, confidence }) =>
      externalId.startsWith("entrance/") && accessState === "public" && confidence === "medium"))
      .toBe(true);
    expect(normalized.filter(({ externalId }) => externalId.startsWith("way/"))).toHaveLength(2);

    const withoutPortals = topology([way("way/1")]);
    const overlaid = applyOfficialEntranceOverlay(withoutPortals, entrances);
    expect(overlaid.accessPoints).toEqual([]);
    expect(overlaid.ways).toEqual(withoutPortals.ways);
    expect(overlaid.nodes).toEqual(withoutPortals.nodes);
  });

  it("pins schema 6 and hashes every deterministic input independently of order", () => {
    expect(MONTEREY_CARMEL_PACK_SCHEMA_VERSION).toBe("6");
    expect(MONTEREY_CARMEL_COMPILER_VERSION).toBe("monterey-carmel-pack-compiler-v2");
    const snapshot = (id: string, version: string, contentHash: `sha256:${string}`): SourceSnapshot => ({
      id,
      authority: `${id} authority`,
      dataset: `${id} dataset`,
      version,
      retrievedAt: "2026-08-07T00:00:00Z",
      url: `https://example.test/${id}`,
      license: `${id} license`,
      contentHash,
      localPath: `/unused/${id}`,
    });
    const sources = [
      snapshot("source-b", "v2", `sha256:${"b".repeat(64)}`),
      snapshot("source-a", "v1", `sha256:${"a".repeat(64)}`),
    ];
    const adapters = ["adapter-b", "adapter-a"];
    const metrics = ["metric-b", "metric-a"];
    const version = montereyCarmelDataVersion("boundary", "search-regions", sources, adapters, metrics);
    expect(version).toMatch(/^mc-[a-f0-9]{16}$/);
    expect(montereyCarmelDataVersion(
      "boundary",
      "search-regions",
      [...sources].reverse(),
      [...adapters].reverse(),
      [...metrics].reverse(),
    )).toBe(version);
    expect(montereyCarmelDataVersion("boundary", "search-regions", sources.slice(1), adapters, metrics))
      .not.toBe(version);
  });
});
