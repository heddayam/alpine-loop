import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { searchCatalogSchema, searchResultSchema, type SearchRequest } from "@/lib/contracts";
import { compilePack } from "@/lib/data/compiler";
import * as namedAreaCatalog from "@/lib/data/named-area-catalog";
import { fixtureCompileOptions, fixturePackSeed } from "@/lib/data/fixture-pack";
import { loadInstalledPack, type InstalledPack } from "@/lib/packs/installed-pack";
import { withGenerationLock } from "@/lib/packs/generation-pins";
import { POST } from "@/app/api/search/route";
import { SQLiteGraphRepository } from "@/lib/graph";
import { mapData } from "./map";
import { drawnArea, resolveSearchPlan, searchCatalog } from "./search-area";
import { generateSearch, openSearchSession } from "./search";
import { RouteSolverProcess } from "./route-solver-process";

vi.mock("node:os", async (original) => ({ ...await original<typeof import("node:os")>(), availableParallelism: () => 4 }));

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
let localInstalled: InstalledPack | undefined;

async function localPack(): Promise<InstalledPack> {
  if (localInstalled) return localInstalled;
  await compilePack(await fixtureCompileOptions(root, undefined, undefined, undefined, {
    seed: { ...fixturePackSeed, id: "local-coverage", name: "Local coverage" },
    searchRegions: { version: 1, regions: [{ namedAreaId: "osm:relation/1001", expectedName: "Redwood Preserve" }] },
  }));
  localInstalled = (await loadInstalledPack("local-coverage", root))!;
  return localInstalled;
}

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

  it("runs Quick packs concurrently and keeps deterministic merging", async () => {
    vi.stubEnv("ALPINE_SOLVER_WORKERS", "2");
    const original = RouteSolverProcess.prototype.generate;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    let active = 0;
    let peak = 0;
    const generate = vi.spyOn(RouteSolverProcess.prototype, "generate").mockImplementation(async function (this: RouteSolverProcess, ...args) {
      peak = Math.max(peak, ++active);
      if (active === 2) release();
      await barrier;
      try { return await original.apply(this, args); }
      finally { active -= 1; }
    });
    let parallel;
    try { parallel = await generateSearch(request, signal()); }
    finally { generate.mockRestore(); }
    expect(peak).toBe(2);
    vi.stubEnv("ALPINE_SOLVER_WORKERS", "1");
    expect(await generateSearch(request, signal())).toEqual(parallel);
    vi.stubEnv("ALPINE_SOLVER_WORKERS", "2");
  });

  it("pins local coverage while a Quick search reads its generation", async () => {
    const local = await localPack();
    fixtures.packs = new Map([["local-coverage", local]]);
    const original = RouteSolverProcess.prototype.generate;
    let started!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const generate = vi.spyOn(RouteSolverProcess.prototype, "generate").mockImplementation(async function (this: RouteSolverProcess, ...args) {
      started();
      await gate;
      return original.apply(this, args);
    });
    const running = generateSearch(request, signal());
    try {
      await entered;
      const live = await withGenerationLock(root, (lock) => lock.liveVersions());
      expect(live.has(local.manifest.dataVersion)).toBe(true);
    } finally { release(); generate.mockRestore(); }
    await running;
    expect((await withGenerationLock(root, (lock) => lock.liveVersions())).size).toBe(0);
  });

  it("pins local coverage while resolving a named region", async () => {
    const local = await localPack();
    fixtures.packs = new Map([["local-coverage", local]]);
    const original = namedAreaCatalog.getSearchRegion;
    let sawPin = false;
    const lookup = vi.spyOn(namedAreaCatalog, "getSearchRegion").mockImplementation((...args) => {
      const db = new DatabaseSync(join(root, "local-coverage", "generation-pins.sqlite"), { readOnly: true });
      try {
        const row = db.prepare("SELECT count(*) AS count FROM generation_pins WHERE version = ?").get(local.manifest.dataVersion) as { count: number };
        sawPin = row.count > 0;
      } finally { db.close(); }
      return original(...args);
    });
    try {
      await resolveSearchPlan({ ...request, area: { mode: "named-regions", regionIds: ["local-coverage::osm:relation/1001"] } }, signal());
      expect(sawPin).toBe(true);
    } finally { lookup.mockRestore(); }
  });

  it("pins local coverage through map database reads and catalogs its regions", async () => {
    const local = await localPack();
    fixtures.packs = new Map([["local-coverage", local]]);
    const original = SQLiteGraphRepository.prototype.getAccessPointCandidates;
    let started!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const candidates = vi.spyOn(SQLiteGraphRepository.prototype, "getAccessPointCandidates").mockImplementation(async function (this: SQLiteGraphRepository, ...args) {
      started();
      await gate;
      return original.apply(this, args);
    });
    const running = mapData(new Request(`http://localhost/api/map?bbox=${fixturePackSeed.coverage.bbox}`));
    try {
      await Promise.race([entered, running.then(() => { throw new Error("Map finished before database read"); })]);
      expect((await withGenerationLock(root, (lock) => lock.liveVersions())).has(local.manifest.dataVersion)).toBe(true);
    } finally { release(); candidates.mockRestore(); }
    await running;
    expect((await withGenerationLock(root, (lock) => lock.liveVersions())).size).toBe(0);
    expect((await searchCatalog()).regions.some(({ id }) => id.startsWith("local-coverage::"))).toBe(true);
  });

  it("uses two independent Full workers within one pack and closes all readers", async () => {
    vi.stubEnv("ALPINE_SOLVER_WORKERS", "2");
    fixtures.packs = new Map([installed.entries().next().value!]);
    const opened = vi.spyOn(RouteSolverProcess, "open");
    const close = vi.spyOn(RouteSolverProcess.prototype, "close");
    const plan = await resolveSearchPlan(request, signal());
    const session = await openSearchSession({ request, plan, signal: signal() });
    try {
      expect(opened).not.toHaveBeenCalled();
      const starts = await session.enumerateEligibleAccessPointIds(signal());
      expect(close).toHaveBeenCalledTimes(1);
      const results = await Promise.all([session.searchAccessPoint(starts[0]!, signal()), session.searchAccessPoint(starts[0]!, signal())]);
      expect(results[0]!.exact).toEqual(results[1]!.exact);
      expect(results[0]!.nearMisses).toEqual(results[1]!.nearMisses);
      expect(opened).toHaveBeenCalledTimes(3); // one discovery reader, two retained workers
      const workers = await Promise.all(opened.mock.results.map(({ value }) => value));
      expect(new Set(workers).size).toBe(3);
    } finally {
      await session.close();
      expect(close).toHaveBeenCalledTimes(3);
      opened.mockRestore(); close.mockRestore();
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

  it("honors drive-time band holes for starts without clipping hiking geometry", async () => {
    fixtures.packs = new Map([installed.entries().next().value!]);
    const excludedStart = (await generateSearch(request, signal())).exact[0]!.startAccessPoint.id;
    const driveRequest: SearchRequest = { ...request, area: {
      mode: "drive-time", origin: { lon: -122.16, lat: 37.16, label: "Home" }, minDurationMinutes: 15, durationMinutes: 30, regionIds: [],
    } };
    const outer = drawnArea(fixturePackSeed.coverage.bbox);
    if (outer.type !== "Polygon") throw new Error("Expected fixture polygon");
    const atStart = drawnArea(request.area.mode === "drawn-area" ? request.area.bbox : fixturePackSeed.coverage.bbox);
    if (atStart.type !== "Polygon") throw new Error("Expected fixture polygon");
    const band = { type: "Polygon" as const, coordinates: [outer.coordinates[0]!, atStart.coordinates[0]!] };
    fixtures.resolveArea.mockResolvedValue({ geometry: band, resolvedAt: "2026-09-06T00:00:00Z" });
    const quick = await generateSearch(driveRequest, signal());
    expect(fixtures.resolveArea).toHaveBeenCalledWith(driveRequest.area, expect.any(AbortSignal));
    expect([...quick.exact, ...quick.nearMisses].every(({ startAccessPoint }) => startAccessPoint.lon !== -122.16)).toBe(true);
    const plan = await resolveSearchPlan(driveRequest, signal());
    const session = await openSearchSession({ request: driveRequest, plan: { ...plan, area: { ...plan.area, filterGeometry: band } }, signal: signal() });
    try {
      const starts = await session.enumerateEligibleAccessPointIds(signal());
      expect(starts).not.toContain(excludedStart);
    } finally { await session.close(); }
    // A hole around an interior trail node must not cut the hiking route.
    const atTrail = drawnArea([-122.1581, 37.1599, -122.1579, 37.1601]);
    if (atTrail.type !== "Polygon") throw new Error("Expected fixture polygon");
    fixtures.resolveArea.mockResolvedValue({ geometry: { ...band, coordinates: [outer.coordinates[0]!, atTrail.coordinates[0]!] }, resolvedAt: "2026-09-06T00:00:00Z" });
    const throughHole = await generateSearch(driveRequest, signal());
    expect(throughHole.exact.length).toBeGreaterThan(0);
    expect(throughHole.exact.some(({ geometry }) => geometry.coordinates.some(([lon, lat]) => lon === -122.158 && lat === 37.16))).toBe(true);
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
