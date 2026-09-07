import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { NormalizedAccessEvidence, SourceSnapshot } from "./adapters";
import type { CompilePackOptions } from "./compiler";
import type { Coordinate, NormalizedTopology, NormalizedWay } from "./types";
import baseline from "./fixtures/regional-build-compatibility.json";

// Freeze the preparation boundary from dff1b43, before regional orchestration is
// consolidated. Only external acquisition is substituted; restrictions, portal
// derivation, entrance overlays, source configs and fingerprints remain real.
const captured = vi.hoisted(() => ({ options: undefined as CompilePackOptions | undefined }));
const topologyVersion = vi.hoisted(() => ({ value: "original-graph-feasibility-v2" }));
vi.mock("../graph/closed-route-topology", async (importOriginal) => ({
  ...await importOriginal<typeof import("../graph/closed-route-topology")>(),
  get CLOSED_ROUTE_TOPOLOGY_ALGORITHM_VERSION() { return topologyVersion.value; },
}));
vi.mock("./audited-pack", () => ({
  compileAuditedPack: async (options: CompilePackOptions) => {
    captured.options = options;
    return {};
  },
}));
vi.mock("./osm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./osm")>();
  return {
    ...actual,
    validateOsmPrerequisites: async () => undefined,
    readPinnedOsmSnapshot: async (_root: string, config: SourceConfig) => snapshot(config),
    refreshPinnedOsmSnapshot: async (_root: string, config: SourceConfig) => ({ snapshot: snapshot(config) }),
    prepareOsmTopology: async (source: SourceSnapshot, options: { boundaryPath: string }) =>
      tinyTopology(path.dirname(options.boundaryPath), source.id),
    prepareOsmBuildings: async () => [[-121.5, 37.1]],
  };
});
vi.mock("./elevation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./elevation")>();
  const collection = async (_root: string, config: SourceConfig) => ({
    collectionPath: "/fixture/dem.json", snapshot: snapshot(config),
  });
  return { ...actual, validateUvRasterioPrerequisites: async () => undefined,
    readPinnedThreeDepCollection: collection, refreshPinnedThreeDepCollection: collection };
});
vi.mock("./authorities", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./authorities")>();
  const snapshots = async (_root: string, sources: import("./authorities").OfficialSourceSet) =>
    (await actual.readOfficialSourceConfigs(sources)).map(snapshot);
  return {
    ...actual,
    readOfficialSourceSnapshots: snapshots,
    refreshOfficialSourceSnapshots: snapshots,
    EastBayRegionalParkDistrictEntranceAdapter: class extends actual.EastBayRegionalParkDistrictEntranceAdapter {
      async validate() {}
      async normalize(source: SourceSnapshot): Promise<NormalizedAccessEvidence[]> {
        return [{ sourceId: source.id, externalId: "entrance/fixture", lon: -121.8815061965,
          lat: 37.6145243526, name: "Reviewed fixture entrance", accessState: "public", confidence: "high" }];
      }
    },
  };
});
vi.mock("./official-trails", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./official-trails")>();
  return { ...actual,
    readPinnedOfficialTrailSnapshot: async (_root: string, config: SourceConfig) => snapshot(config),
    refreshPinnedOfficialTrailSnapshot: async (_root: string, config: SourceConfig) => ({ snapshot: snapshot(config) }),
    readUsgsNationalDigitalTrails: async () => [],
  };
});

import { buildCentralCascadesPack } from "./central-cascades-pack";
import { buildHenryCoePack } from "./henry-coe-pack";
import { buildMontereyCarmelPack } from "./monterey-carmel-pack";
import { buildSantaCruzPack } from "./santa-cruz-pack";
import { buildSouthernEastBayPack } from "./southern-east-bay-pack";

type SourceConfig = Pick<SourceSnapshot, "id" | "authority" | "dataset" | "version" | "license"> & {
  url?: string; endpoint?: string; downloadUrl?: string;
};
function snapshot(config: SourceConfig): SourceSnapshot {
  return { id: config.id, authority: config.authority, dataset: config.dataset, version: config.version,
    license: config.license, url: config.url ?? config.endpoint ?? config.downloadUrl!,
    retrievedAt: "2026-08-20T00:00:00Z", contentHash: `sha256:${digest(config.id)}`,
    localPath: `/fixture/${config.id}` };
}

const anchors: Record<string, Coordinate[]> = {
  "santa-cruz-mountains": [[-122.1, 37.1]],
  "southern-east-bay": [[-121.8815061965, 37.6145243526], [-121.7908, 37.5188], [-121.697152193, 37.585111116]],
  "monterey-carmel": [[-121.888643, 36.538635]],
  "henry-coe": [[-121.5458297, 37.1878465]],
  "central-cascades": [[-121.0895, 47.7465]],
};

async function tinyTopology(regionRoot: string, sourceId: string): Promise<NormalizedTopology> {
  const topology: NormalizedTopology = { nodes: [], ways: [], accessPoints: [], portalEvidence: [], rejectedWayCount: 2 };
  const way = (externalId: string, nodeIds: string[], edgeClass: NormalizedWay["edgeClass"]): NormalizedWay => ({
    id: externalId, externalId, nodeIds, edgeClass, name: "Fixture trail", accessState: "unknown",
    bidirectional: true, sourceRefs: [sourceId], flags: ["surface:ground"],
    coordinates: nodeIds.map((id) => { const node = topology.nodes.find((node) => node.id === id)!; return [node.lon, node.lat]; }),
  });
  anchors[path.basename(regionRoot)]!.forEach(([lon, lat], index) => {
    const ids = ["start", "end", "road"].map((part) => `${index}-${part}`);
    [[lon, lat], [lon + 0.004, lat], [lon, lat - 0.001]].forEach(([x, y], offset) => {
      topology.nodes.push({ id: ids[offset]!, externalId: `node/${index * 3 + offset + 1}`, lon: x!, lat: y!,
        elevationM: null, sourceRefs: [sourceId], flags: [] });
    });
    topology.ways.push(way(`way/${9000000000 + index}`, ids.slice(0, 2), "trail"),
      { ...way(`way/${9100000000 + index}`, [ids[0]!, ids[2]!], "street"), accessState: "public" });
  });
  if (["santa-cruz-mountains", "southern-east-bay", "monterey-carmel"].includes(path.basename(regionRoot))) {
    const restrictions = JSON.parse(await readFile(path.join(regionRoot, "access-restrictions.json"), "utf8")) as {
      restrictions: Array<{ externalId: string }>;
    };
    topology.ways.push(...restrictions.restrictions.map(({ externalId }) => way(externalId, ["0-start", "0-end"], "trail")));
  }
  return topology;
}

// Object key ordering is not part of the contract; array order and all values are.
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .sort(([first], [second]) => first.localeCompare(second)).map(([key, item]) => [key, canonical(item)]));
  return value;
}
function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}
function normalizedSnapshot(source: SourceSnapshot) {
  return Object.fromEntries(Object.entries(source).filter(([key]) => key !== "localPath"));
}
function preparationRecord(options: CompilePackOptions) {
  return {
    dataVersion: options.seed.dataVersion,
    seedHash: digest(options.seed),
    topologyHash: digest(options.topology.data),
    accessPoints: options.topology.data.accessPoints,
    inputsHash: digest({ builtAt: options.builtAt, topology: normalizedSnapshot(options.topology.snapshot),
      additionalSources: [...(options.additionalSources ?? [])].sort((first, second) => first.id.localeCompare(second.id)).map(normalizedSnapshot),
      elevation: normalizedSnapshot(options.elevation.snapshot), elevationAlgorithm: options.elevation.sampler.algorithmVersion,
      namedAreas: normalizedSnapshot(options.namedAreas.snapshot), namedAreaAdapter: options.namedAreas.adapter.adapterVersion,
      buildings: options.buildings, searchRegions: options.searchRegions }),
  };
}

describe("regional preparation compatibility with dff1b43", () => {
  const builders = [buildSantaCruzPack, buildSouthernEastBayPack, buildMontereyCarmelPack, buildHenryCoePack, buildCentralCascadesPack];
  it.each(builders.flatMap((build, index) => [false, true].map((refresh) => ({ build, region: Object.keys(anchors)[index]!, refresh }))))(
    "$region preserves prepared output (refresh=$refresh)", async ({ build, region, refresh }) => {
      captured.options = undefined;
      await build({ outputRoot: "/fixture/output", sourceCacheRoot: "/fixture/cache", preparationRoot: "/fixture/prepared", refresh });
      expect(captured.options).toBeDefined();
      const actual = preparationRecord(captured.options!);
      const old = baseline[region as keyof typeof baseline];
      const seed = captured.options!.seed;
      expect(seed.closedRouteTopology.algorithmVersion).toBe(topologyVersion.value);
      expect(actual.dataVersion).not.toBe(old.dataVersion);
      // Only the explicitly versioned feasibility compilation changes the seed;
      // normalized regional inputs retain their original frozen expectations.
      expect({ ...actual, dataVersion: old.dataVersion, seedHash: digest({ ...seed,
        dataVersion: old.dataVersion, closedRouteTopology: { ...seed.closedRouteTopology,
          algorithmVersion: "closed-route-safe-pruning-v1" } }) }).toEqual(old);
      if (!refresh) {
        const currentVersion = topologyVersion.value;
        try {
          topologyVersion.value = "future-feasibility-version";
          await build({ outputRoot: "/fixture/output", sourceCacheRoot: "/fixture/cache", preparationRoot: "/fixture/prepared", refresh });
          expect(captured.options!.seed.dataVersion).not.toBe(actual.dataVersion);
          expect(captured.options!.seed.closedRouteTopology.algorithmVersion).toBe(topologyVersion.value);
          expect(preparationRecord(captured.options!).topologyHash).toBe(actual.topologyHash);
        } finally { topologyVersion.value = currentVersion; }
      }
    },
  );
});
