import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const topology = {
    nodes: [
      { id: "n1", lon: 0.25, lat: 0.25 },
      { id: "n2", lon: 0.75, lat: 0.75 },
    ],
    ways: [{
      id: "w1",
      externalId: "osm-way-1",
      nodeIds: ["n1", "n2"],
      coordinates: [[0.25, 0.25], [0.75, 0.75]],
      bidirectional: true,
      accessState: "public",
      edgeClass: "trail",
      sourceRefs: ["osm"],
      flags: [],
    }],
    accessPoints: [{
      id: "portal-1",
      externalId: "osm-node-1",
      nodeId: "n1",
      name: "Test portal",
      accessState: "public",
      confidence: "high",
      sourceRefs: ["osm"],
      parkingEvidence: true,
    }],
    portalEvidence: [],
    rejectedWayCount: 0,
  };
  const osmSnapshot = {
    id: "osm",
    authority: "OpenStreetMap contributors",
    dataset: "test",
    version: "2026-01-01",
    retrievedAt: "2026-01-01T00:00:00.000Z",
    url: "https://example.test/osm.pbf",
    license: "ODbL-1.0",
    contentHash: "osm-hash",
    localPath: "/cache/osm.pbf",
  };
  const elevationSnapshot = {
    ...osmSnapshot,
    id: "elevation",
    license: "public-domain",
    contentHash: "elevation-hash",
    localPath: "/cache/elevation.tif",
  };
  return {
    topology,
    osmSnapshot,
    elevationSnapshot,
    readFile: vi.fn(async (filePath: string) => filePath.endsWith("boundary.geojson")
      ? JSON.stringify({
          type: "Feature",
          properties: { id: "test-region", boundaryVersion: "test-boundary-v1" },
          geometry: { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] },
        })
      : "{}"),
    writeFile: vi.fn(async () => undefined),
    compilePack: vi.fn(async (options: unknown) => {
      void options;
      return {
        packDirectory: "/output/test-region/version",
        databasePath: "/output/test-region/version/pack.sqlite",
        manifestPath: "/output/test-region/version/manifest.json",
        auditPath: "/output/test-region/version/audit.json",
        audit: {},
        reusedExisting: false,
      };
    }),
    auditSqlitePack: vi.fn(async () => ({ passed: true, errors: [] })),
    refreshOsm: vi.fn(async () => ({ snapshot: osmSnapshot })),
    readOsm: vi.fn(async () => osmSnapshot),
    refreshElevation: vi.fn(async () => ({ collectionPath: "/cache/elevation.json", snapshot: elevationSnapshot })),
    readElevation: vi.fn(async () => ({ collectionPath: "/cache/elevation.json", snapshot: elevationSnapshot })),
  };
});

vi.mock("node:fs/promises", () => ({ readFile: mocks.readFile, writeFile: mocks.writeFile }));
vi.mock("./audit", () => ({
  assertPackAuditPassed: vi.fn(),
  auditSqlitePack: mocks.auditSqlitePack,
}));
vi.mock("./compiler", () => ({ compilePack: mocks.compilePack }));
vi.mock("./elevation", () => ({
  readElevationSourceConfig: vi.fn(async () => ({})),
  readPinnedThreeDepCollection: mocks.readElevation,
  refreshPinnedThreeDepCollection: mocks.refreshElevation,
  UvRasterioThreeDepElevationSampler: class {
    readonly algorithmVersion = "test-elevation-v1";
  },
  validateUvRasterioPrerequisites: vi.fn(async () => undefined),
}));
vi.mock("./osm", () => ({
  BUILDINGS_ADAPTER_VERSION: "test-buildings-v1",
  prepareOsmBuildings: vi.fn(async () => []),
  OsmPbfNamedAreaAdapter: class {
    readonly adapterVersion = "test-named-areas-v1";
  },
  OsmPbfTopologyAdapter: class {
    readonly adapterVersion = "test-topology-v1";
    async *normalize() {
      yield mocks.topology;
    }
  },
  readOsmSourceConfig: vi.fn(async () => ({})),
  readPinnedOsmSnapshot: mocks.readOsm,
  refreshPinnedOsmSnapshot: mocks.refreshOsm,
  validateOsmPrerequisites: vi.fn(async () => undefined),
}));
vi.mock("./portals", () => ({
  PORTAL_DERIVATION_VERSION: "test-portals-v1",
  deriveTrailheadPortals: vi.fn(() => mocks.topology),
  stripPortalBuildContext: vi.fn(() => mocks.topology),
}));
vi.mock("./search-regions", () => ({ readSearchRegionInput: vi.fn(async () => []) }));

import {
  BASIC_REGIONAL_PACK_BUILD_PHASES,
  createBasicRegionalPackBuilder,
  type BasicRegionalPackConfig,
} from "./basic-regional-pack";
import type { RegionalPackBuildProgress } from "./regional-pack";

const config: BasicRegionalPackConfig = {
  id: "test-region",
  name: "Test Region",
  dataVersionPrefix: "test",
  compilerVersion: "test-compiler-v1",
  boundaryVersion: "test-boundary-v1",
  regionRoot: "/regions/test-region",
  display: { center: [0.5, 0.5], zoom: 8 },
};

const baseOptions = {
  outputRoot: "/output",
  sourceCacheRoot: "/cache",
  preparationRoot: "/build-cache",
  refresh: false,
};

describe("basic regional pack build progress", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reports stable high-level milestones in order", async () => {
    const progress: RegionalPackBuildProgress[] = [];

    await createBasicRegionalPackBuilder(config)({
      ...baseOptions,
      onProgress: (update) => progress.push(update),
    });

    expect(progress).toEqual(BASIC_REGIONAL_PACK_BUILD_PHASES.map((label, index) => ({
      phase: index + 1,
      phaseCount: BASIC_REGIONAL_PACK_BUILD_PHASES.length,
      label,
    })));
  });

  it("labels source refresh explicitly and remains optional", async () => {
    const progress: RegionalPackBuildProgress[] = [];
    await createBasicRegionalPackBuilder(config)({ ...baseOptions, refresh: true, onProgress: (update) => progress.push(update) });
    expect(progress[1]).toEqual({ phase: 2, phaseCount: 9, label: "Refresh pinned source snapshots" });
    expect(mocks.refreshOsm).toHaveBeenCalledOnce();
    expect(mocks.refreshElevation).toHaveBeenCalledOnce();

    await expect(createBasicRegionalPackBuilder(config)(baseOptions)).resolves.toMatchObject({ pack: { reusedExisting: false } });
    const dataVersions = mocks.compilePack.mock.calls.map(([options]) =>
      (options as { seed: { dataVersion: string } }).seed.dataVersion);
    expect(dataVersions[0]).toMatch(/^test-/);
    expect([...new Set(dataVersions)]).toHaveLength(1);
  });
});
