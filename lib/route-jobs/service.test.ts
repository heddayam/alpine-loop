import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SearchIntent, SearchRoute } from "@/lib/contracts";
import { cleanupInstallations, withInstallationPins } from "@/lib/coverage-install";
import { createRouteJobCancelHandler, createRouteJobCollectionHandlers } from "./http";
import { RouteJobService, decodeResultCursor, encodeResultCursor } from "./service";
import { SQLiteRouteJobStore } from "./store";
import type { RouteJobRunnerDependencies } from "./types";

const temporary: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); temporary.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })); });

const request: SearchIntent = {
  area: { mode: "drive-time", origin: { lon: -122.1, lat: 37.3, label: "Home" }, durationMinutes: 30, regionIds: ["fixture-pack::pack:fixture-pack"] },
  criteria: { closedRoute: { maximumRepeatedTrailPct: 35, allowMultiCycle: true }, distanceMiles: { min: 4, max: 8 }, includeUncertainAccess: true },
};
const regionWideRequest: SearchIntent = {
  area: { mode: "named-regions", regionIds: ["fixture-pack::pack:fixture-pack"] }, criteria: request.criteria,
};
const drawnAreaRequest: SearchIntent = {
  area: { mode: "drawn-area", bbox: [-122.4, 37.1, -122.2, 37.3] }, criteria: request.criteria,
};
const plan = { installationId: "v4", area: { label: "Fixture" } };
const drawnAreaGeometry = {
  type: "Polygon" as const,
  coordinates: [[
    [-122.4, 37.1], [-122.2, 37.1], [-122.2, 37.3], [-122.4, 37.3], [-122.4, 37.1],
  ]] as [number, number][][],
};
const geometry = { type: "Polygon" as const, coordinates: [[[-123, 37], [-122, 37], [-122, 38], [-123, 38], [-123, 37]]] };

function route(id: string): SearchRoute {
  const offset = id === "second" ? 0.01 : 0;
  return {
    id, regionLabel: "Fixture", geometry: { type: "LineString", coordinates: [[-122.1 + offset, 37.3], [-122.11 + offset, 37.31], [-122.1 + offset, 37.3]] },
    startAccessPoint: { id: "access", name: "Access", lon: -122.1 + offset, lat: 37.3, accessState: "public", confidence: "high" },
    distanceMeters: 6_000, elevationGainMeters: 200, elevationLossMeters: 200, minimumElevationMeters: 100, maximumElevationMeters: 300, steepestSustainedGradePct: 8,
    topology: { kind: "simple-loop", cycleCount: 1, cycleBlockCount: 1, repeatedTrailDistanceMeters: 0, repeatedTrailFraction: 0, sharedStemDistanceMeters: 0, connectorCount: 0 },
    trailNames: ["Fixture"], warnings: [], source: { freshness: "2026-01-01T00:00:00.000Z", confidence: "high", sourceIds: ["fixture"] },
  };
}

function harness(overrides: Partial<RouteJobRunnerDependencies> = {}) {
  const directory = mkdtempSync(join(tmpdir(), "route-job-service-"));
  temporary.push(directory);
  const store = new SQLiteRouteJobStore(join(directory, "jobs.sqlite"));
  const dependencies: RouteJobRunnerDependencies = {
    resolveJob: vi.fn(async () => plan),
    resolveDriveTime: vi.fn(async () => ({ geometry, resolvedAt: "2026-01-01T00:00:00.000Z" })),
    openSearchSession: vi.fn(async () => ({
      enumerateEligibleAccessPointIds: vi.fn(async () => ["first", "second"]),
      searchAccessPoint: vi.fn(async (accessPointId: string) => ({ exact: [route(accessPointId)], nearMisses: [], truncated: false })),
      close: vi.fn(async () => undefined),
    })),
    currentInstallationId: vi.fn(async () => "v4"),
    pinInstallation: async (_id, action) => action(),
    ...overrides,
  };
  const ids = ["00000000-0000-4000-8000-000000000010", "00000000-0000-4000-8000-000000000011"];
  const service = new RouteJobService({ store, dependencies, id: () => ids.shift()! });
  return { store, service, dependencies, directory };
}

function installLocal(root: string, id: string): void {
  for (const dir of ["releases", "installations", "artifacts"]) mkdirSync(join(root, dir), { recursive: true });
  const artifactId = "a".repeat(64);
  writeFileSync(join(root, "artifacts", `${artifactId}.sqlite`), "fixture");
  writeFileSync(join(root, "releases", "release.json"), JSON.stringify({
    schemaVersion: 1, graphSchemaVersion: "7", id: "release", builtAt: "2026-09-24T00:00:00Z", compilerVersion: "test", metricAlgorithmVersion: "test", geometry,
    sources: [{ id: "test", authority: "test", dataset: "test", version: "1", retrievedAt: "2026-09-24T00:00:00Z", url: "https://example.com", license: "test", contentHash: `sha256:${artifactId}` }],
    sections: [{ id: "section", geometry, artifactIds: [artifactId] }], artifacts: [{ id: artifactId, path: `objects/${artifactId}.sqlite.gz`, compressedBytes: 1, bytes: 7, geometry }], regions: [], limitations: [],
  }));
  writeFileSync(join(root, "installations", `${id}.json`), JSON.stringify({ id, releaseId: "release", createdAt: "2026-09-24T00:00:00Z", sectionIds: ["section"], artifactIds: [artifactId], geometry }));
}

describe("RouteJobService", () => {
  it("replans if cleanup removes a generation before its job plan is saved", async () => {
    let resolveFirst!: () => void;
    let releaseFirst!: () => void;
    const firstChosen = new Promise<void>((resolve) => { resolveFirst = resolve; });
    const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let calls = 0;
    const { service, store, directory } = harness({
      resolveJob: vi.fn(async () => {
        if (++calls === 1) { resolveFirst(); await gate; }
        return { installationId: calls === 1 ? "old" : "active", area: { label: "Local" } };
      }),
      currentInstallationId: vi.fn(async () => "active"),
      pinInstallation: (id, action) => withInstallationPins([id], action, packRoot),
    });
    const packRoot = join(directory, "coverage");
    installLocal(packRoot, "old"); installLocal(packRoot, "active");
    writeFileSync(join(packRoot, "current.json"), JSON.stringify({ installationId: "active" }));
    const creating = service.create(drawnAreaRequest);
    await firstChosen;
    await cleanupInstallations(packRoot, []);
    releaseFirst();
    const job = await creating;
    expect(calls).toBe(2);
    expect(store.getStored(job.id)?.plan.installationId).toBe("active");
    await service.waitUntilIdle();
    store.close();
  });

  it("keeps legacy saved geometry readable and rejects executing old plans", async () => {
    const { service, store, directory, dependencies } = harness();
    const job = await service.create(regionWideRequest);
    await service.waitUntilIdle();
    const before = (await service.results(job.id)).results;
    const db = new DatabaseSync(join(directory, "jobs.sqlite"));
    db.prepare("UPDATE route_jobs SET plan_json=? WHERE id=?").run(JSON.stringify({ packs: [{ id: "legacy", dataVersion: "old", builtAt: "2026-01-01T00:00:00.000Z" }], area: { label: "Legacy" } }), job.id);
    expect(store.getStored(job.id)?.plan).toEqual({ installationId: null, area: { label: "Legacy" } });
    expect((await service.results(job.id)).results).toEqual(before);
    expect(await service.get(job.id)).toMatchObject({ stale: true });
    vi.mocked(dependencies.openSearchSession).mockClear();
    db.prepare("UPDATE route_jobs SET status='queued' WHERE id=?").run(job.id);
    service.start(); await service.waitUntilIdle();
    expect(await service.get(job.id)).toMatchObject({ status: "cancelled", error: expect.stringContaining("restart the search") });
    expect(dependencies.openSearchSession).not.toHaveBeenCalled();
    expect((await service.results(job.id)).results).toEqual(before);
    db.close(); store.close();
  });

  it("pins the installation throughout an active job while publication and cleanup run", async () => {
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const searching = new Promise<void>(resolve => { started = resolve; });
    const { service, store, directory } = harness({
      resolveJob: async () => ({ installationId: "old", area: { label: "Pinned" } }),
      pinInstallation: (id, action) => withInstallationPins([id], action, root),
      openSearchSession: async () => ({
        enumerateEligibleAccessPointIds: async () => ["one"],
        searchAccessPoint: async () => { started(); await gate; return { exact: [], nearMisses: [], truncated: false }; },
        close: async () => {},
      }),
    });
    const root = join(directory, "coverage"); installLocal(root, "old"); installLocal(root, "active");
    writeFileSync(join(root, "current.json"), JSON.stringify({ installationId: "old" }));
    const job = await service.create(regionWideRequest); await searching;
    writeFileSync(join(root, "current.json"), JSON.stringify({ installationId: "active" }));
    expect(await cleanupInstallations(root, [])).toEqual([]);
    release(); await service.waitUntilIdle();
    expect(await cleanupInstallations(root, [store.getStored(job.id)!.plan.installationId!])).toEqual([]);
    store.close();
  });

  it("runs a drawn-area job with its resolved geographic plan", async () => {
    const { service, dependencies, store } = harness({
      resolveJob: vi.fn(async () => ({
        installationId: "v4",
        area: { label: "Drawn area", filterGeometry: drawnAreaGeometry },
      })),
    });

    const job = await service.create(drawnAreaRequest);
    await service.waitUntilIdle();

    expect(await service.get(job.id)).toMatchObject({
      status: "completed",
      request: drawnAreaRequest,
      area: { label: "Drawn area", filterGeometry: drawnAreaGeometry },
      progress: { eligibleAccessPointCount: 2, processedAccessPointCount: 2 },
    });
    expect(dependencies.resolveDriveTime).not.toHaveBeenCalled();
    expect(dependencies.openSearchSession).toHaveBeenCalledWith({
      request: drawnAreaRequest,
      plan: { installationId: "v4", area: { label: "Drawn area", filterGeometry: drawnAreaGeometry } },
      signal: expect.any(AbortSignal),
    });
    store.close();
  });

  it("runs a region-wide job without drive-time resolution or geometry", async () => {
    const { service, dependencies, store } = harness();

    const job = await service.create(regionWideRequest);
    await service.waitUntilIdle();

    expect(await service.get(job.id)).toMatchObject({
      status: "completed",
      request: regionWideRequest,
      progress: { eligibleAccessPointCount: 2, processedAccessPointCount: 2 },
    });
    expect(await service.get(job.id)).not.toHaveProperty("filterGeometry");
    expect(dependencies.resolveDriveTime).not.toHaveBeenCalled();
    expect(dependencies.openSearchSession).toHaveBeenCalledWith({
      request: regionWideRequest,
      plan,
      signal: expect.any(AbortSignal),
    });
    store.close();
  });

  it("runs jobs FIFO, attempts each eligible access point, and persists deterministic results", async () => {
    const { service, dependencies, store } = harness();
    const first = await service.create(request);
    const second = await service.create(request);
    await service.waitUntilIdle();
    expect((await service.get(first.id))?.status).toBe("completed");
    expect((await service.get(second.id))?.status).toBe("completed");
    expect(await service.get(first.id)).toMatchObject({ area: { filterGeometry: geometry } });
    const sessions = await Promise.all(vi.mocked(dependencies.openSearchSession).mock.results.map(({ value }) => value));
    expect(sessions.flatMap((session) => vi.mocked(session.searchAccessPoint).mock.calls.map((call: unknown[]) => call[0])))
      .toEqual(["first", "second", "first", "second"]);
    expect(sessions.every((session) => vi.mocked(session.close).mock.calls.length === 1)).toBe(true);
    expect((await service.results(first.id)).results.map(({ route: value }) => value.id)).toEqual(["first", "second"]);
    store.close();
  });

  it("cancels active work, retains completed checkpoints, and deletes with cascade", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const { service, store } = harness({
      openSearchSession: vi.fn(async () => ({
        enumerateEligibleAccessPointIds: vi.fn(async () => ["first", "second"]),
        searchAccessPoint: vi.fn(async (accessPointId: string, signal: AbortSignal) => {
          if (accessPointId === "second") await Promise.race([
            blocked,
            new Promise((_, reject) => signal.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError")), { once: true })),
          ]);
          return { exact: [route(accessPointId)], nearMisses: [], truncated: false };
        }),
        close: vi.fn(async () => undefined),
      })),
    });
    const job = await service.create(request);
    await vi.waitFor(async () => expect((await service.get(job.id))?.progress.processedAccessPointCount).toBe(1));
    await service.cancel(job.id);
    release();
    await service.waitUntilIdle();
    expect(await service.get(job.id)).toMatchObject({ status: "cancelled", partial: true, progress: { processedAccessPointCount: 1 } });
    expect((await service.results(job.id)).results).toHaveLength(1);
    await service.delete(job.id);
    expect(await service.get(job.id)).toBeNull();
    store.close();
  });

  it("services list and cancel HTTP requests between CPU-heavy trailhead checkpoints", async () => {
    let releaseFirst!: () => void;
    const firstFinished = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const searched: string[] = [];
    const { service, store } = harness({
      openSearchSession: vi.fn(async () => ({
        enumerateEligibleAccessPointIds: vi.fn(async () => ["first", "second"]),
        searchAccessPoint: vi.fn(async (accessPointId: string) => {
          searched.push(accessPointId);
          if (accessPointId === "first") {
            const deadline = performance.now() + 40;
            let iterations = 0;
            while (performance.now() < deadline) iterations += 1;
            expect(iterations).toBeGreaterThan(0);
            releaseFirst();
          }
          return { exact: [], nearMisses: [], truncated: false };
        }),
        close: vi.fn(async () => undefined),
      })),
    });
    const job = await service.create(request);
    await firstFinished;
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(searched).toEqual(["first"]);
    const collection = createRouteJobCollectionHandlers(service);
    const listResponse = await collection.GET();
    expect(listResponse.status).toBe(200);
    expect(await listResponse.json()).toMatchObject({
      jobs: [{ id: job.id, progress: { processedAccessPointCount: 1 } }],
    });

    const cancelResponse = await createRouteJobCancelHandler(service)(
      new Request(`http://localhost/api/route-jobs/${job.id}/cancel`, { method: "POST" }),
      { params: Promise.resolve({ id: job.id }) },
    );
    expect(cancelResponse.status).toBe(200);
    expect(searched).toEqual(["first"]);
    await service.waitUntilIdle();
    expect(await service.get(job.id)).toMatchObject({
      status: "cancelled",
      partial: true,
      progress: { processedAccessPointCount: 1 },
    });
    expect(searched).toEqual(["first"]);
    store.close();
  });

  it("looks up the current installation once when listing jobs", async () => {
    const { service, dependencies, store } = harness();
    await service.create(request);
    await service.create(request);
    await service.waitUntilIdle();
    vi.mocked(dependencies.currentInstallationId).mockClear();

    expect(await service.list()).toHaveLength(2);
    expect(dependencies.currentInstallationId).toHaveBeenCalledTimes(1);
    expect(dependencies.currentInstallationId).toHaveBeenCalledWith();
    store.close();
  });

  it("marks jobs stale when their pinned installation is no longer current", async () => {
    const { service, store } = harness({ currentInstallationId: vi.fn(async () => null) });
    const job = await service.create(request);
    await service.waitUntilIdle();

    expect(await service.get(job.id)).toMatchObject({ stale: true });
    expect(await service.list()).toMatchObject([{ id: job.id, stale: true }]);
    store.close();
  });

  it("covers multiple regions in one installation and retains ten per start", async () => {
    const combined = { installationId: "v4", area: { label: "Both regions" } };
    let current: string | null = "v4";
    const starts = ["fixture-pack::access", "other-pack::access"];
    const closeRoute = {
      ...route("other-pack::close"),
      geometry: { type: "LineString" as const, coordinates: [[-121, 37], [-121.01, 37.01], [-121, 37]] as [number, number][] },
      regionLabel: "Other region",
      violations: [{ constraint: "distance" as const, value: 3, min: 4, max: 8, delta: 1, normalizedDelta: 0.125 }],
    };
    const { service, store, dependencies } = harness({
      resolveJob: vi.fn(async () => combined),
      currentInstallationId: vi.fn(async () => current),
      openSearchSession: vi.fn(async () => ({
        enumerateEligibleAccessPointIds: vi.fn(async () => starts),
        searchAccessPoint: vi.fn(async (id) => ({
          exact: id === starts[0] ? Array.from({ length: 12 }, (_, index) => ({
            ...route(`fixture-pack::route-${index}`),
            geometry: { type: "LineString" as const, coordinates: [[-122, 37], [-122.01, 37.01 + index / 100], [-122, 37]] as [number, number][] },
          })) : [],
          nearMisses: [closeRoute, { ...closeRoute, id: "ignored-close" }], truncated: false,
        })),
        close: vi.fn(async () => undefined),
      })),
    });
    const reads = vi.spyOn(store, "getStored");
    const job = await service.create(regionWideRequest);
    await service.waitUntilIdle();
    // Read once for the initial public job and once to claim it, never per start.
    expect(reads).toHaveBeenCalledTimes(2);
    expect(dependencies.openSearchSession).toHaveBeenCalledWith({ request: regionWideRequest, plan: combined, signal: expect.any(AbortSignal) });
    expect(await service.get(job.id)).toMatchObject({ stale: false, progress: { eligibleAccessPointCount: 2, processedAccessPointCount: 2, exactRouteCount: 10, nearMissRouteCount: 1 } });
    const results = (await service.results(job.id)).results;
    expect(results.map(({ matchType }) => matchType)).toEqual([...Array(10).fill("exact"), "near-miss"]);
    expect(new Set(results.map(({ accessPointId }) => accessPointId))).toEqual(new Set(starts));
    current = "changed";
    expect(await service.get(job.id)).toMatchObject({ stale: true });
    vi.mocked(dependencies.currentInstallationId).mockClear();
    expect(await service.list()).toMatchObject([{ stale: true }]);
    expect(dependencies.currentInstallationId).toHaveBeenCalledTimes(1);
    current = null;
    expect(await service.get(job.id)).toMatchObject({ stale: true });
    store.close();
  });

  it("bounds parallel starts and checkpoints in ordinal order despite reversed completion", async () => {
    const releases = new Map<string, () => void>();
    const started: string[] = [];
    const { service, store } = harness({
      openSearchSession: async () => ({
        concurrency: 2,
        enumerateEligibleAccessPointIds: async () => ["first", "second", "third", "fourth"],
        searchAccessPoint: async (id) => {
          started.push(id);
          await new Promise<void>((resolve) => releases.set(id, resolve));
          // Identical geometry exercises deterministic first-start ownership.
          return { exact: [{ ...route("first"), id }], nearMisses: [], truncated: false };
        },
        close: async () => undefined,
      }),
    });
    const completed = vi.spyOn(store, "completeAccessPoint");
    const job = await service.create(regionWideRequest);
    await vi.waitFor(() => expect(started).toEqual(["first", "second"]));
    releases.get("second")!();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(completed).not.toHaveBeenCalled();
    expect(started).toEqual(["first", "second"]);
    releases.get("first")!();
    await vi.waitFor(() => expect(started).toEqual(["first", "second", "third", "fourth"]));
    releases.get("fourth")!();
    releases.get("third")!();
    await service.waitUntilIdle();
    expect(completed.mock.calls.map((call) => call[1])).toEqual([0, 1, 2, 3]);
    expect((await service.results(job.id)).results.map(({ accessPointId }) => accessPointId)).toEqual(["first"]);
    store.close();
  });

  it.each(["cancel", "delete"] as const)("discards buffered and late parallel results after %s", async (action) => {
    const started: string[] = [];
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const close = vi.fn(async () => { release(); });
    const { service, store } = harness({
      openSearchSession: async () => ({
        concurrency: 2,
        enumerateEligibleAccessPointIds: async () => ["first", "second", "third"],
        searchAccessPoint: async (id, signal) => {
          started.push(id);
          if (id === "first") await Promise.race([blocked, new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))]);
          return { exact: [route(id)], nearMisses: [], truncated: false };
        },
        close,
      }),
    });
    const job = await service.create(regionWideRequest);
    await vi.waitFor(() => expect(started).toEqual(["first", "second"]));
    await service[action](job.id);
    await service.waitUntilIdle();
    expect(close).toHaveBeenCalledOnce();
    expect(started).toEqual(["first", "second"]);
    if (action === "delete") expect(await service.get(job.id)).toBeNull();
    else {
      expect(await service.get(job.id)).toMatchObject({ status: "cancelled", progress: { processedAccessPointCount: 0 } });
      expect((await service.results(job.id)).results).toEqual([]);
    }
    store.close();
  });

  it("resumes every uncommitted parallel start after reopening storage", async () => {
    const directory = mkdtempSync(join(tmpdir(), "route-job-resume-parallel-"));
    temporary.push(directory);
    const path = join(directory, "jobs.sqlite");
    let store = new SQLiteRouteJobStore(path);
    const id = "00000000-0000-4000-8000-000000000012";
    store.create(id, regionWideRequest, plan);
    store.claimNext();
    store.initializeAccessPoints(id, ["first", "second", "third", "fourth"]);
    store.nextAccessPoint(id);
    store.completeAccessPoint(id, 0, [], false);
    expect(store.nextAccessPoint(id)?.accessPointId).toBe("second");
    expect(store.nextAccessPoint(id)?.accessPointId).toBe("third");
    store.close();
    store = new SQLiteRouteJobStore(path);
    const searched: string[] = [];
    const { dependencies, store: unusedStore, service: unusedService } = harness();
    await unusedService.waitUntilIdle();
    unusedStore.close();
    const service = new RouteJobService({ store, dependencies: { ...dependencies,
      openSearchSession: async () => ({
        concurrency: 2,
        enumerateEligibleAccessPointIds: async () => ["first", "second", "third", "fourth"],
        searchAccessPoint: async (id) => {
          searched.push(id);
          return { exact: [], nearMisses: [], truncated: false };
        },
        close: async () => undefined,
      }),
    } });
    await service.waitUntilIdle();
    expect(searched).toEqual(["second", "third", "fourth"]);
    expect(await service.get(id)).toMatchObject({ status: "completed", progress: { processedAccessPointCount: 4 } });
    store.close();
  });

  it("rejects malformed cursors and round-trips tuple cursors", () => {
    const cursor = { matchRank: 1, accessOrdinal: 2, resultOrdinal: 3, routeId: "route" };
    expect(decodeResultCursor(encodeResultCursor(cursor))).toEqual(cursor);
    expect(() => decodeResultCursor("broken")).toThrow(/cursor is invalid/i);
    expect(() => decodeResultCursor("x".repeat(2_049))).toThrow(/cursor is invalid/i);
  });
});
