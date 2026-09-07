import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { searchCatalogSchema, searchResultSchema, type SearchRequest } from "@/lib/contracts";
import { compilePack } from "@/lib/data/compiler";
import { fixtureCompileOptions, fixturePackSeed } from "@/lib/data/fixture-pack";
import { loadInstalledPack, type InstalledPack } from "@/lib/packs/installed-pack";
import { POST } from "@/app/api/search/route";
import { SQLiteGraphRepository } from "@/lib/graph";
import { mapData } from "./map";
import { drawnArea, resolveSearchPlan, searchCatalog } from "./search-area";
import { generateSearch, openSearchSession } from "./search";

const fixtures = vi.hoisted(() => ({ packs: new Map<string, InstalledPack>(), resolveArea: vi.fn() }));
vi.mock("@/lib/packs/pack-catalog", () => ({ discoverCatalogPacks: async () => fixtures.packs }));
vi.mock("@/lib/reachability/default-service", () => ({ defaultReachabilityService: () => ({ resolveArea: fixtures.resolveArea }) }));

const signal = () => new AbortController().signal;
const request: SearchRequest = {
  area: { mode: "drawn-area", bbox: [-122.1601, 37.1599, -122.1599, 37.1601] },
  criteria: {
    closedRoute: { maximumRepeatedTrailPct: 35, allowMultiCycle: true },
    distanceMiles: { min: 0.1, max: 20 }, includeUncertainAccess: true,
  },
  limit: 2,
};
let root: string;
let installed: Map<string, InstalledPack>;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "alpine-geographic-"));
  vi.stubEnv("ALPINE_PACK_ROOT", root);
  installed = new Map();
  for (const id of ["fixture-pack", "fixture-neighbor"]) {
    await compilePack(await fixtureCompileOptions(root, undefined, undefined, undefined, {
      seed: { ...fixturePackSeed, id, name: id },
      searchRegions: { version: 1, regions: [{ namedAreaId: "osm:relation/1001", expectedName: "Redwood Preserve" }] },
    }));
    installed.set(id, (await loadInstalledPack(id, root))!);
  }
});
beforeEach(() => {
  fixtures.packs = new Map(installed);
  fixtures.resolveArea.mockReset().mockResolvedValue({ geometry: drawnArea(fixturePackSeed.coverage.bbox), resolvedAt: "2026-09-06T00:00:00Z" });
});
afterAll(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

describe("geographic search with production storage and compute", () => {
  it("selects starts without clipping routes and deduplicates overlapping data within the global limit", async () => {
    const result = searchResultSchema.parse(await generateSearch(request, signal()));
    expect(result.exact.length).toBeGreaterThan(0);
    expect(result.exact.length + result.nearMisses.length).toBeLessThanOrEqual(request.limit);
    expect(new Set(result.exact.map((route) => JSON.stringify(route.geometry.coordinates))).size).toBe(result.exact.length);
    for (const route of result.exact) {
      expect(route.id).toContain("::");
      expect(route.startAccessPoint.id).toContain("::");
      expect(route.regionLabel).toMatch(/^fixture-/);
      expect(route.geometry.coordinates[0]).toEqual(route.geometry.coordinates.at(-1));
      expect(route.geometry.coordinates.some(([lon]) => lon! > -122.1599)).toBe(true);
      expect(route.geometry.coordinates.every(([lon, lat]) => lon! >= -122.161 && lon! <= -122.155 && lat! >= 37.159 && lat! <= 37.162)).toBe(true);
    }
  });

  it("offers geographic discovery and viewport data with opaque identities", async () => {
    const catalog = searchCatalogSchema.parse(await searchCatalog());
    expect(catalog.regions.map(({ id }) => id)).toEqual(["fixture-pack::osm:relation/1001", "fixture-neighbor::osm:relation/1001"]);
    expect(catalog).not.toHaveProperty("packs");
    const map = await mapData(new Request(`http://localhost/api/map?bbox=${fixturePackSeed.coverage.bbox}`));
    expect(map.accessPoints.length).toBeGreaterThan(0);
    expect(new Set(map.accessPoints.map(({ id }) => id)).size).toBe(map.accessPoints.length);
    expect(map.accessPoints.every(({ id }) => id.includes("::"))).toBe(true);
    expect(map.trailNetwork.features.length).toBeGreaterThan(0);
    const overview = await mapData(new Request(`http://localhost/api/map?bbox=${fixturePackSeed.coverage.bbox}&trails=0`));
    expect(overview.accessPoints).toEqual(map.accessPoints);
    expect(overview.trailNetwork.features).toEqual([]);
  });

  it("preserves the complete map response from the former graph reader across overlapping packs", async () => {
    const request = () => new Request(`http://localhost/api/map?bbox=${fixturePackSeed.coverage.bbox}`);
    const streamed = await mapData(request());
    const oldReader = vi.spyOn(SQLiteGraphRepository.prototype, "iterateMapTrails").mockImplementation(async function* (this: SQLiteGraphRepository, query) {
      const graph = await this.getInducedGraph(query);
      const physicalEdges = new Set<number>();
      for (const edge of graph.edges) {
        if (edge.physicalEdgeKey !== undefined) {
          if (physicalEdges.has(edge.physicalEdgeKey)) continue;
          physicalEdges.add(edge.physicalEdgeKey);
        }
        yield edge;
      }
    });
    try { expect(streamed).toEqual(await mapData(request())); }
    finally { oldReader.mockRestore(); }
  });

  it("stops streaming at the map feature limit, skips duplicate geometry, and closes the reader", async () => {
    fixtures.packs = new Map([installed.entries().next().value!]);
    let visited = 0;
    let readerClosed = false;
    const close = vi.spyOn(SQLiteGraphRepository.prototype, "close");
    const reader = vi.spyOn(SQLiteGraphRepository.prototype, "iterateMapTrails").mockImplementation(async function* () {
      try {
        for (let index = 0; index < 75_100; index += 1) {
          visited += 1;
          // A reversed duplicate at capacity still must not trigger MAP_TOO_LARGE.
          const coordinates: Array<readonly [number, number]> = index === 75_000
            ? [[0, 1], [0, 0]] : [[index, 0], [index, 1]];
          yield { id: String(index), physicalEdgeKey: index, coordinates, lengthMeters: 1,
            trailName: null, accessState: "public", sourceIds: [], edgeClass: "trail", flags: [] };
        }
      } finally { readerClosed = true; }
    });
    try {
      await expect(mapData(new Request(`http://localhost/api/map?bbox=${fixturePackSeed.coverage.bbox}`)))
        .rejects.toMatchObject({ code: "MAP_TOO_LARGE", status: 422 });
      expect(visited).toBe(75_002);
      expect(readerClosed).toBe(true);
      expect(close).toHaveBeenCalledTimes(1);
    } finally { reader.mockRestore(); close.mockRestore(); }
  });

  it("resolves one contour for all data and returns an honest empty result outside coverage", async () => {
    fixtures.resolveArea.mockResolvedValue({ geometry: drawnArea([0, 0, 1, 1]), resolvedAt: "2026-09-06T00:00:00Z" });
    const result = await generateSearch({ ...request, area: {
      mode: "drive-time", origin: { lon: 0, lat: 0, label: "Away" }, durationMinutes: 30, regionIds: [],
    } }, signal());
    expect(fixtures.resolveArea).toHaveBeenCalledTimes(1);
    expect(result.exact).toEqual([]);
    expect(result.incomplete).toBe(false);
    expect(result.messages).not.toEqual([]);
  });

  it("uses one Full session with distinct starts and labeled routes across datasets", async () => {
    const plan = await resolveSearchPlan(request, signal());
    const session = await openSearchSession({ request, plan, signal: signal() });
    try {
      const starts = await session.enumerateEligibleAccessPointIds(signal());
      expect(starts.some((id) => id.startsWith("fixture-pack::"))).toBe(true);
      expect(starts.some((id) => id.startsWith("fixture-neighbor::"))).toBe(true);
      expect(new Set(starts).size).toBe(starts.length);
      const result = await session.searchAccessPoint(starts[0]!, signal());
      expect(result.exact.length).toBeGreaterThan(0);
      expect(result.exact.every((route) => route.startAccessPoint.id === starts[0])).toBe(true);
    } finally { await session.close(); }
  });

  it("never broadens unavailable named areas or substitutes demo data", async () => {
    await expect(resolveSearchPlan({ ...request, area: { mode: "named-regions", regionIds: ["missing"] } }, signal()))
      .rejects.toMatchObject({ code: "REGION_NOT_FOUND" });
    fixtures.packs.clear();
    expect((await searchCatalog()).coverages).toEqual([]);
    await expect(generateSearch(request, signal())).rejects.toMatchObject({ code: "DATA_UNAVAILABLE" });
    const controller = new AbortController(); controller.abort();
    await expect(generateSearch(request, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  });

  it("validates the geographic HTTP boundary before work begins", async () => {
    const response = await POST(new Request("http://localhost/api/search", { method: "POST", body: JSON.stringify({ ...request, packId: "fixture-pack" }) }));
    expect(response.status).toBe(400);
    const malformed = await POST(new Request("http://localhost/api/search", { method: "POST", body: "{" }));
    expect(malformed.status).toBe(400);
  });
});
