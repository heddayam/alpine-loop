import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SourceSnapshot } from "./adapters";
import type { NormalizedNode, NormalizedTopology, NormalizedWay, PackBuildResult } from "./types";

const mocks = vi.hoisted(() => ({
  compilePack: vi.fn(),
  auditSqlitePack: vi.fn(),
  assertPackAuditPassed: vi.fn(),
  topology: undefined as NormalizedTopology | undefined,
}));

vi.mock("./audit", () => ({
  auditSqlitePack: mocks.auditSqlitePack,
  assertPackAuditPassed: mocks.assertPackAuditPassed,
}));

vi.mock("./compiler", () => ({ compilePack: mocks.compilePack }));

const snapshot = (id: string, retrievedAt = "2026-08-01T00:00:00.000Z"): SourceSnapshot => ({
  id,
  authority: `${id} authority`,
  dataset: `${id} dataset`,
  version: `${id}-v1`,
  retrievedAt,
  url: `https://example.com/${id}`,
  license: "fixture",
  contentHash: `sha256:${id.charCodeAt(0).toString(16).padStart(2, "0").repeat(32)}`,
  localPath: `/fixture/${id}`,
});

vi.mock("./osm", () => ({
  readOsmSourceConfig: vi.fn(async () => ({ id: "osm-config" })),
  readPinnedOsmSnapshot: vi.fn(async () => snapshot("osm", "2026-08-02T00:00:00.000Z")),
  refreshPinnedOsmSnapshot: vi.fn(async () => ({ snapshot: snapshot("osm") })),
  validateOsmPrerequisites: vi.fn(async () => undefined),
  OsmPbfTopologyAdapter: class {
    readonly adapterVersion = "classified-osm-v8";
    async validate() {}
    async *normalize() { yield mocks.topology; }
  },
  OsmPbfNamedAreaAdapter: class {
    readonly adapterVersion = "named-areas-v1";
    async validate() {}
    async normalize() { return []; }
  },
}));

vi.mock("./elevation", () => ({
  readElevationSourceConfig: vi.fn(async () => ({ id: "elevation-config" })),
  readPinnedThreeDepCollection: vi.fn(async () => ({
    collectionPath: "/fixture/dem.json",
    snapshot: snapshot("dem", "2026-08-03T00:00:00.000Z"),
  })),
  refreshPinnedThreeDepCollection: vi.fn(),
  validateUvRasterioPrerequisites: vi.fn(async () => undefined),
  UvRasterioThreeDepElevationSampler: class {
    readonly algorithmVersion = "elevation-v1";
  },
}));

vi.mock("./population", () => ({
  readPopulationSourceConfig: vi.fn(async () => ({ id: "population-config" })),
  readPinnedPopulationCollection: vi.fn(async () => ({
    collectionPath: "/fixture/population.json",
    collection: {},
    snapshot: snapshot("population", "2026-08-04T00:00:00.000Z"),
  })),
  refreshPinnedPopulationCollection: vi.fn(),
  validateUvRasterioPopulationPrerequisites: vi.fn(async () => undefined),
  UvRasterioPopulationSampler: class {
    readonly algorithmVersion = "population-v1";
    async verify() {}
  },
}));

vi.mock("./search-regions", () => ({
  readSearchRegionInput: vi.fn(async () => ({ regions: [] })),
}));

import { compilePack } from "./compiler";
import { readCuratedAccessFile } from "./curated-access";
import {
  SANTA_CRUZ_CURATED_ACCESS_PATH,
  buildSantaCruzPack,
} from "./santa-cruz-pack";

const restrictionIds = [
  "way/38903758", "way/38903882", "way/38903893", "way/38904206", "way/39158068",
  "way/39161341", "way/39428990", "way/69844556", "way/111475473", "way/141456929",
  "way/222603845", "way/352892062", "way/352892063", "way/352892064", "way/352892065",
  "way/352892067", "way/352892068", "way/427738829", "way/427738837", "way/808148863",
  "way/808148864", "way/1254704454", "way/1469336136", "way/1475165257", "way/1483129226",
  "way/1539878799", "way/1539878800", "way/1539878801", "way/1539878802", "way/1539878804",
  "way/1539878805",
];

function node(id: string, lon: number, lat: number): NormalizedNode {
  return {
    id,
    externalId: id,
    lon,
    lat,
    elevationM: null,
    flags: [],
    sourceRefs: ["osm"],
  };
}

function way(externalId: string, edgeClass: NonNullable<NormalizedWay["edgeClass"]>, nodeIds: string[]): NormalizedWay {
  const coordinatesByNode = new Map([
    ["n0", [-122.1, 37.1] as const],
    ["n1", [-122.099, 37.1] as const],
    ["road", [-122.1, 37.099] as const],
    ["context", [-122.101, 37.1] as const],
  ]);
  return {
    id: `osm-${externalId.replace("/", "-")}`,
    externalId,
    nodeIds,
    coordinates: nodeIds.map((id) => coordinatesByNode.get(id)!),
    name: edgeClass === "trail" ? "Fixture Trail" : null,
    accessState: "public",
    bidirectional: true,
    edgeClass,
    sourceRefs: ["osm"],
    flags: [],
  };
}

function classifiedFixture(): NormalizedTopology {
  return {
    nodes: [
      node("n0", -122.1, 37.1),
      node("n1", -122.099, 37.1),
      node("road", -122.1, 37.099),
      node("context", -122.101, 37.1),
    ],
    ways: [
      ...restrictionIds.map((id) => way(id, "trail", ["n0", "n1"])),
      way("way/9000000001", "street", ["road", "n0"]),
      way("way/9000000002", "service-road", ["road", "context"]),
      way("way/9000000003", "sidewalk", ["context", "n0"]),
    ],
    accessPoints: [{
      id: "legacy-parking",
      externalId: "node/parking",
      nodeId: "context",
      name: "Legacy parking",
      kind: "parking",
      accessState: "public",
      confidence: "low",
      parkingEvidence: null,
      sourceRefs: ["osm"],
    }],
    portalEvidence: [],
    rejectedWayCount: 0,
  };
}

describe("Santa Cruz schema-6 portal pack", () => {
  let packDirectory: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.topology = classifiedFixture();
    packDirectory = await mkdtemp(path.join(os.tmpdir(), "santa-cruz-pack-test-"));
    const pack: PackBuildResult = {
      packDirectory,
      databasePath: path.join(packDirectory, "pack.sqlite"),
      manifestPath: path.join(packDirectory, "manifest.json"),
      auditPath: path.join(packDirectory, "audit.json"),
      audit: {
        schemaVersion: "6",
        packId: "santa-cruz-mountains",
        dataVersion: "fixture",
        nodeCount: 2,
        directedEdgeCount: 62,
        accessPointCount: 1,
        sourceCount: 5,
        rejectedWayCount: 0,
        conflictCount: 0,
        missingElevationNodeCount: 0,
        missingElevationEdgeCount: 0,
        accessStateCounts: { public: 0, unknown: 0, private: 0, closed: 60, prohibited: 2 },
      },
      reusedExisting: false,
    };
    mocks.compilePack.mockResolvedValue(pack);
    mocks.auditSqlitePack.mockResolvedValue({ errors: [], warnings: [] });
  });

  afterEach(() => {
    mocks.topology = undefined;
  });

  it("pins exactly the 31 public/unknown removals and excludes the already-private inert match", async () => {
    const curated = await readCuratedAccessFile(SANTA_CRUZ_CURATED_ACCESS_PATH);
    expect(curated.restrictions.map(({ externalId }) => externalId)).toEqual(restrictionIds);
    expect(curated.restrictions).toHaveLength(31);
    expect(curated.restrictions).not.toContainEqual(expect.objectContaining({ externalId: "way/427738834" }));
    expect(curated.restrictions.find(({ externalId }) => externalId === "way/39428990"))
      .toMatchObject({ accessState: "prohibited" });
    expect(curated.restrictions.find(({ externalId }) => externalId === "way/1254704454"))
      .toMatchObject({ accessState: "closed" });
  });

  it("uses no live authority adapter, spatial matcher, access snapper, or evidence promotion", async () => {
    const source = await readFile(path.resolve("lib/data/santa-cruz-pack.ts"), "utf8");
    expect(source).not.toMatch(/MidpenOfficialAccessAdapter|SantaClaraCountyParksAccessAdapter/);
    expect(source).not.toMatch(/matchOfficialAccessToOsm|readOfficialSourceSnapshots|refreshOfficialSourceSnapshots/);
    expect(source).not.toMatch(/snapAccessPointsToTopology|applyOfficialWayEvidenceToAccessPoints|auditOfficialAccessJoins/);
  });

  it("compiles a schema-6 portal-only topology with curated provenance and no official adapter", async () => {
    const result = await buildSantaCruzPack({
      outputRoot: "/fixture/output",
      sourceCacheRoot: "/fixture/cache",
      preparationRoot: "/fixture/preparation",
      refresh: false,
    });
    const options = vi.mocked(compilePack).mock.calls[0]![0];
    expect(options.seed).toMatchObject({
      schemaVersion: "6",
      compilerVersion: "santa-cruz-pack-compiler-v14-portals",
      capabilities: { portalAccessPoints: true, officialAccess: false },
    });
    expect(options).not.toHaveProperty("officialAccess");
    expect(options).not.toHaveProperty("additionalOfficialAccess");
    expect(options.additionalSources?.map(({ id }) => id)).toEqual(["santa-cruz-reviewed-access-restrictions"]);

    const published: NormalizedTopology[] = [];
    for await (const topology of options.topology.adapter.normalize(options.topology.snapshot)) published.push(topology);
    expect(published[0]!.ways).toHaveLength(31);
    expect(published[0]!.ways.every(({ edgeClass }) => edgeClass === "trail")).toBe(true);
    expect(published[0]!.accessPoints).toEqual([
      expect.objectContaining({
        id: "portal:n0",
        kind: "trailhead",
        accessState: "closed",
        portalRoadClass: "street",
      }),
    ]);
    expect(published[0]!.portalEvidence).toEqual([]);
    expect(result.portalDerivation).toMatchObject({
      curatedRestrictionCount: 31,
      portalCount: 1,
      inputWayCount: 34,
      trailWayCount: 31,
      streetWayCount: 1,
      serviceRoadWayCount: 1,
      sidewalkWayCount: 1,
      publishedWayCount: 31,
      strippedBuildContextWayCount: 3,
      inputNodeCount: 4,
      publishedNodeCount: 2,
      strippedBuildContextNodeCount: 2,
      publishedEvidenceCount: 0,
    });
  });

  it("derives the same data version from the same source inputs", async () => {
    const options = {
      outputRoot: "/fixture/output",
      sourceCacheRoot: "/fixture/cache",
      preparationRoot: "/fixture/preparation",
      refresh: false,
    };
    await buildSantaCruzPack(options);
    await buildSantaCruzPack(options);
    expect(vi.mocked(compilePack).mock.calls[0]![0].seed.dataVersion)
      .toBe(vi.mocked(compilePack).mock.calls[1]![0].seed.dataVersion);
    expect(vi.mocked(compilePack).mock.calls[0]![0].seed.dataVersion).toMatch(/^scm-[a-f0-9]{16}$/);
  });
});
