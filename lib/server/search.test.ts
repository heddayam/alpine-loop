import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { searchCatalogSchema, searchResultSchema, type SearchRequest } from "@/lib/contracts";
import { fixturePackSeed } from "@/lib/data/fixture-pack";
import { withPublicationLock } from "@/lib/coverage-install";
import { POST } from "@/app/api/search/route";
import { PreparedGraphRepository } from "@/lib/graph";
import { mapData } from "./map";
import { drawnArea, resolveSearchPlan, searchCatalog } from "./search-area";
import { generateSearch, openSearchSession } from "./search";
import { RouteSolverProcess } from "./route-solver-process";
import { preparedInstallation } from "./__fixtures__/prepared-installation";

vi.mock("node:os", async (original) => ({ ...await original<typeof import("node:os")>(), availableParallelism: () => 4 }));
const fixtures = vi.hoisted(() => ({ resolveArea: vi.fn() }));
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
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "alpine-geographic-"));
  vi.stubEnv("ALPINE_COVERAGE_ROOT", root);
  await preparedInstallation(root);
});
beforeEach(async () => {
  await writeFile(join(root, "current.json"), JSON.stringify({ installationId: "fixture-installation" }));
  fixtures.resolveArea.mockReset().mockResolvedValue({ geometry: drawnArea(fixturePackSeed.coverage.bbox), resolvedAt: "2026-09-06T00:00:00Z" });
});
afterAll(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });
const pins = () => withPublicationLock(root, store => store.db.prepare("SELECT installation FROM pins").all().map(row => row.installation));

describe("geographic search with prepared installation storage and compute", () => {
  it("selects starts without clipping routes and enforces one global limit", async () => {
    const result = searchResultSchema.parse(await generateSearch(request, signal()));
    expect(result.exact.length).toBeGreaterThan(0);
    expect(result.exact.length + result.nearMisses.length).toBeLessThanOrEqual(request.limit);
    expect(new Set(result.exact.map(route => JSON.stringify(route.geometry.coordinates))).size).toBe(result.exact.length);
    for (const route of result.exact) {
      expect(route.id).toContain("fixture-installation::");
      expect(route.startAccessPoint.id).toContain("fixture-installation::");
      expect(route.regionLabel).toBe("Installed coverage");
      expect(route.geometry.coordinates[0]).toEqual(route.geometry.coordinates.at(-1));
      expect(route.geometry.coordinates.some(([lon]) => lon! > -122.1599)).toBe(true);
      expect(route.geometry.coordinates.every(([lon, lat]) => lon! >= -122.161 && lon! <= -122.155 && lat! >= 37.159 && lat! <= 37.162)).toBe(true);
    }
  });

  it("opens one Quick worker for the logical graph regardless of worker count", async () => {
    const opened = vi.spyOn(RouteSolverProcess, "open");
    try {
      vi.stubEnv("ALPINE_SOLVER_WORKERS", "2");
      const first = await generateSearch(request, signal());
      expect(opened).toHaveBeenCalledTimes(1);
      vi.stubEnv("ALPINE_SOLVER_WORKERS", "1");
      expect(await generateSearch(request, signal())).toEqual(first);
    } finally { opened.mockRestore(); vi.stubEnv("ALPINE_SOLVER_WORKERS", "2"); }
  });

  it("pins the immutable installation through Quick computation", async () => {
    const original = RouteSolverProcess.prototype.generate;
    let started!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const generate = vi.spyOn(RouteSolverProcess.prototype, "generate").mockImplementation(async function (this: RouteSolverProcess, ...args) {
      started(); await gate; return original.apply(this, args);
    });
    const running = generateSearch(request, signal());
    try { await entered; expect(await pins()).toContain("fixture-installation"); }
    finally { release(); generate.mockRestore(); }
    await running;
    expect(await pins()).toEqual([]);
  });

  it("pins map readers and resolves canonical region IDs plus legacy aliases from release metadata", async () => {
    const original = PreparedGraphRepository.prototype.getAccessPointCandidates;
    let started!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const candidates = vi.spyOn(PreparedGraphRepository.prototype, "getAccessPointCandidates").mockImplementation(async function (this: PreparedGraphRepository, ...args) {
      started(); await gate; return original.apply(this, args);
    });
    const running = mapData(new Request(`http://localhost/api/map?bbox=${fixturePackSeed.coverage.bbox}`));
    try { await entered; expect(await pins()).toContain("fixture-installation"); }
    finally { release(); candidates.mockRestore(); }
    await running;
    expect(await pins()).toEqual([]);
    const canonical = await resolveSearchPlan({ ...request, area: { mode: "named-regions", regionIds: ["fixture-release::osm:relation/1001"] } }, signal());
    const alias = await resolveSearchPlan({ ...request, area: { mode: "named-regions", regionIds: ["fixture-pack::osm:relation/1001"] } }, signal());
    expect(alias).toEqual(canonical);
    expect(canonical.installationId).toBe("fixture-installation");
  });

  it("uses two independent Full workers within one installation and closes all readers", async () => {
    vi.stubEnv("ALPINE_SOLVER_WORKERS", "2");
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
    expect(catalog.regions.map(({ id }) => id)).toEqual(["fixture-release::osm:relation/1001"]);
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

  it("preserves the complete map response from the former graph reader across the prepared graph", async () => {
    const request = () => new Request(`http://localhost/api/map?bbox=${fixturePackSeed.coverage.bbox}`);
    const streamed = await mapData(request());
    const oldReader = vi.spyOn(PreparedGraphRepository.prototype, "iterateMapTrails").mockImplementation(async function* (this: PreparedGraphRepository, query) {
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
    let visited = 0;
    let readerClosed = false;
    const close = vi.spyOn(PreparedGraphRepository.prototype, "close");
    const reader = vi.spyOn(PreparedGraphRepository.prototype, "iterateMapTrails").mockImplementation(async function* () {
      try {
        for (let index = 0; index < 75_100; index += 1) {
          visited += 1;
          // A reversed duplicate at capacity still must not trigger MAP_TOO_LARGE.
          const coordinates: Array<readonly [number, number]> = index === 75_000
            ? [[0, 1], [0, 0]] : [[index, 0], [index, 1]];
          yield { id: String(index), physicalEdgeKey: index, coordinates, lengthMeters: 1,
            fromNodeId: "a", toNodeId: "b", gainMeters: 0, lossMeters: 0, maximumElevationMeters: 0, maximumSustainedGradePct: 0,
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

  it("validates the geographic HTTP boundary before work begins", async () => {
    const response = await POST(new Request("http://localhost/api/search", { method: "POST", body: JSON.stringify({ ...request, packId: "fixture-pack" }) }));
    expect(response.status).toBe(400);
    const malformed = await POST(new Request("http://localhost/api/search", { method: "POST", body: "{" }));
    expect(malformed.status).toBe(400);
  });

  it("never executes legacy plans or substitutes demo data for an empty installation", async () => {
    await expect(openSearchSession({ request, plan: { installationId: null, area: { label: "Legacy" } }, signal: signal() }))
      .rejects.toThrow("start a new search");
    await expect(resolveSearchPlan({ ...request, area: { mode: "named-regions", regionIds: ["missing"] } }, signal()))
      .rejects.toMatchObject({ code: "REGION_NOT_FOUND" });
    await writeFile(join(root, "current.json"), JSON.stringify({ installationId: null }));
    expect((await searchCatalog()).coverages).toEqual([]);
    await expect(generateSearch(request, signal())).rejects.toMatchObject({ code: "DATA_UNAVAILABLE" });
    const controller = new AbortController(); controller.abort();
    await expect(generateSearch(request, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  });
});
