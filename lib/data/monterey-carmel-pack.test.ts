import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  MONTEREY_LOS_PADRES_TRAILS_QUERY_URL,
  MONTEREY_OFFICIAL_SOURCE_SET,
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
  readOfficialSourceConfigs,
  type OfficialAccessJoin,
} from "./authorities";
import { reconcileAccess } from "./access";
import { areaGeometryBounds, assertValidAreaGeometry } from "./area-geometry";
import { readElevationSourceConfig } from "./elevation";
import { sha256File } from "./file-source";
import {
  MONTEREY_CARMEL_REGION_ROOT,
  buildMontereyCarmelPack,
  montereyCarmelDataVersion,
  prioritizeMontereyCurrentClosureJoins,
  splitMontereyReviewedAccessEvidence,
} from "./monterey-carmel-pack";
import { readOsmSourceConfig } from "./osm";
import { readPopulationSourceConfig } from "./population";
import { readSearchRegionInput } from "./search-regions";
import type { SourceSnapshot } from "./adapters";

describe("Monterey–Carmel pack wiring", () => {
  it("owns a deterministic USFS-only official source set", async () => {
    expect(MONTEREY_OFFICIAL_SOURCE_SET.filenames).toEqual([
      "usfs-national-forest-system-trails.json",
    ]);
    expect(MONTEREY_OFFICIAL_SOURCE_SET.cacheNamespace).toBe("monterey-carmel-official-access");
    const configs = await readOfficialSourceConfigs(MONTEREY_OFFICIAL_SOURCE_SET);
    expect(configs.map(({ id }) => id)).toEqual([
      "usfs-los-padres-northern-connector-trails",
    ]);
    expect(configs.map(({ downloadUrl }) => downloadUrl)).toEqual([
      MONTEREY_LOS_PADRES_TRAILS_QUERY_URL,
    ]);
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

  it("pins and splits the reviewed overlay into entrances and exact closure targets", async () => {
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
    expect(MONTEREY_REVIEWED_ACCESS_CONTENT_HASH)
      .toBe("sha256:b8cbf834860a5249c743757de025304bb77a13673cf46bc578c1c35c34256466");
    expect(snapshot.localPath).toBe(path.join(MONTEREY_CARMEL_REGION_ROOT, MONTEREY_REVIEWED_ACCESS_RELATIVE_PATH));
    expect(await sha256File(snapshot.localPath)).toBe(MONTEREY_REVIEWED_ACCESS_CONTENT_HASH);

    const evidence = await new MontereyReviewedAccessAdapter().normalize(snapshot);
    const split = splitMontereyReviewedAccessEvidence(evidence);
    expect(split.entrances).toHaveLength(10);
    expect(split.entrances.every(({ externalId, accessState, confidence }) =>
      externalId.startsWith("entrance/") && accessState === "public" && confidence === "medium"))
      .toBe(true);
    expect(split.currentClosures.map(({ externalId }) => externalId)).toEqual([
      "way/55856070",
      "way/55856129",
    ]);
    expect(split.currentClosures.every(({ accessState, confidence }) =>
      accessState === "closed" && confidence === "high"))
      .toBe(true);
    expect(() => splitMontereyReviewedAccessEvidence([{
      ...split.entrances[0]!,
      accessState: "unknown",
    }])).toThrow(/must be public with medium confidence/);
  });

  it("suppresses older line evidence wherever a current closure exists", () => {
    const join = (
      sourceId: string,
      accessState: "unknown" | "closed",
      targetExternalId: string,
    ): OfficialAccessJoin => ({
      sourceId,
      authorityFeatureId: `${sourceId}:${targetExternalId}`,
      targetExternalId,
      matchMethod: "spatial-intersection",
      distanceM: 0,
      evidence: {
        sourceId,
        externalId: targetExternalId,
        lon: -121.9184,
        lat: 36.4595,
        name: "Rocky Ridge Trail",
        accessState,
        confidence: accessState === "closed" ? "high" : "medium",
      },
    });
    const target = "way/55856070";
    const inputs = [
      join("usfs-los-padres-northern-connector-trails", "unknown", target),
      join("usfs-los-padres-northern-connector-trails", "unknown", "way/1"),
    ];
    const closures = [join(MONTEREY_REVIEWED_ACCESS_SOURCE_ID, "closed", target)];
    const first = prioritizeMontereyCurrentClosureJoins(inputs, closures);
    const second = prioritizeMontereyCurrentClosureJoins([...inputs].reverse(), closures);

    expect(first.suppressedLineJoinCount).toBe(1);
    expect(first.lineJoins.map(({ targetExternalId }) => targetExternalId)).toEqual(["way/1"]);
    expect(first.combinedJoins.filter(({ targetExternalId }) => targetExternalId === target)
      .map(({ evidence }) => evidence.accessState))
      .toEqual(["closed"]);
    expect(second.combinedJoins).toEqual(first.combinedJoins);
    expect(reconcileAccess("unknown", ["closed"])).toMatchObject({ state: "closed", conflict: false });
  });

  it("hashes every deterministic pack input independently of source and version order", () => {
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
    const version = montereyCarmelDataVersion(
      "boundary",
      "search-regions",
      sources,
      adapters,
      metrics,
    );
    expect(version).toMatch(/^mc-[a-f0-9]{16}$/);
    expect(montereyCarmelDataVersion(
      "boundary",
      "search-regions",
      [...sources].reverse(),
      ["adapter-a", "adapter-b"],
      ["metric-a", "metric-b"],
    )).toBe(version);
    expect(montereyCarmelDataVersion("changed", "search-regions", sources, adapters, metrics))
      .not.toBe(version);
    expect(montereyCarmelDataVersion("boundary", "changed", sources, adapters, metrics))
      .not.toBe(version);
    expect(montereyCarmelDataVersion("boundary", "search-regions", sources.slice(1), adapters, metrics))
      .not.toBe(version);
    expect(montereyCarmelDataVersion("boundary", "search-regions", sources, ["adapter-changed"], metrics))
      .not.toBe(version);
    expect(montereyCarmelDataVersion("boundary", "search-regions", sources, adapters, ["metric-changed"]))
      .not.toBe(version);
  });
});
