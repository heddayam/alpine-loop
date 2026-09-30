import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ACCESS_ENTRY_POLICY_VERSION, type SearchIntent, type SearchRoute } from "@/lib/contracts";
import { cleanupInstallations, withInstallationPins } from "@/lib/coverage-install";
import { createRouteJobCancelHandler, createRouteJobCollectionHandlers } from "./http";
import { RouteJobService, decodeResultCursor, encodeResultCursor } from "./service";
import { SQLiteRouteJobStore } from "./store";
import type { RouteJobRunnerDependencies, RouteJobResult } from "./types";
import { retainBetterResults } from "./retain-results";

const temporary: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); temporary.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })); });

const request: SearchIntent = {
  area: { mode: "drive-time", origin: { lon: -122.1, lat: 37.3, label: "Home" }, durationMinutes: 30, regionIds: ["fixture-pack::pack:fixture-pack"] },
  criteria: { closedRoute: { maximumRepeatedTrailPct: 35 }, distanceMiles: { min: 4, max: 8 }, includeUncertainAccess: true },
};
const regionWideRequest: SearchIntent = {
  area: { mode: "named-regions", regionIds: ["fixture-pack::pack:fixture-pack"] }, criteria: request.criteria,
};
const drawnAreaRequest: SearchIntent = {
  area: { mode: "drawn-area", bbox: [-122.4, 37.1, -122.2, 37.3] }, criteria: request.criteria,
};
const plan = { installationId: "v4", accessPolicyVersion: ACCESS_ENTRY_POLICY_VERSION, area: { label: "Fixture" } };
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

  it("stops earlier entrance-policy jobs without re-enumerating or losing saved results", async () => {
    const { service, store, directory, dependencies } = harness();
    const job = await service.create(regionWideRequest);
    await service.waitUntilIdle();
    const before = (await service.results(job.id)).results;
    const db = new DatabaseSync(join(directory, "jobs.sqlite"));
    db.prepare("UPDATE route_jobs SET plan_json=?,status='queued' WHERE id=?").run(JSON.stringify({ ...plan, accessPolicyVersion: undefined }), job.id);
    vi.mocked(dependencies.openSearchSession).mockClear();
    vi.mocked(dependencies.resolveDriveTime).mockClear();
    service.start(); await service.waitUntilIdle();
    expect(await service.get(job.id)).toMatchObject({ status: "cancelled", stale: true, error: expect.stringContaining("earlier starting-point policy") });
    expect(dependencies.openSearchSession).not.toHaveBeenCalled();
    expect(dependencies.resolveDriveTime).not.toHaveBeenCalled();
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
      plan: { installationId: "v4", accessPolicyVersion: ACCESS_ENTRY_POLICY_VERSION, area: { label: "Drawn area", filterGeometry: drawnAreaGeometry } },
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

  it("publishes durable results and the matching progress snapshot while the next start runs", async () => {
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const { service, store } = harness({
      openSearchSession: async () => ({
        enumerateEligibleAccessPointIds: async () => ["first", "second"],
        searchAccessPoint: async (id) => {
          if (id === "second") await blocked;
          return { exact: [route(id)], nearMisses: [], truncated: false };
        },
        close: async () => undefined,
      }),
    });
    const job = await service.create(regionWideRequest);
    try {
      await vi.waitFor(async () => expect((await service.get(job.id))?.progress.processedAccessPointCount).toBe(1));
      const page = await service.results(job.id);
      expect(page.job).toMatchObject({ status: "running", partial: true,
        progress: { processedAccessPointCount: 1, exactRouteCount: 1 } });
      expect(page.results.map(({ route }) => route.id)).toEqual(["first"]);
    } finally { release(); await service.waitUntilIdle(); }
    const completed = await service.results(job.id);
    expect(completed.job).toMatchObject({ status: "completed", partial: false,
      progress: { processedAccessPointCount: 2, exactRouteCount: 2 } });
    expect(completed.results.map(({ route }) => route.id)).toEqual(["first", "second"]);
    store.close();
  });

  it("retains readable checkpoints when the job fails before all starts are attempted", async () => {
    const { service, store } = harness();
    await service.waitUntilIdle();
    const id = "00000000-0000-4000-8000-000000000013";
    store.create(id, regionWideRequest, plan);
    store.claimNext();
    store.initializeAccessPoints(id, ["first", "second"]);
    store.nextAccessPoint(id);
    store.completeAccessPoint(id, 0, [{ matchType: "exact", accessPointId: "first", route: route("first") }], false);
    store.finish(id, "failed", "Search session stopped unexpectedly.");
    const page = await service.results(id);
    expect(page.job).toMatchObject({ status: "failed", partial: true,
      progress: { processedAccessPointCount: 1, exactRouteCount: 1 } });
    expect(page.results.map(({ route }) => route.id)).toEqual(["first"]);
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
    expect(dependencies.openSearchSession).toHaveBeenCalledWith({ request: regionWideRequest, plan: { ...combined, accessPolicyVersion: ACCESS_ENTRY_POLICY_VERSION }, signal: expect.any(AbortSignal) });
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

  it("refills free workers but bounds uncommitted starts and checkpoints in ordinal order", async () => {
    const releases = new Map<string, () => void>();
    const started: string[] = [];
    let running = 0;
    let maximumRunning = 0;
    const { service, store } = harness({
      openSearchSession: async () => ({
        concurrency: 2,
        enumerateEligibleAccessPointIds: async () => ["first", "second", "third", "fourth", "fifth", "sixth"],
        searchAccessPoint: async (id) => {
          started.push(id);
          maximumRunning = Math.max(maximumRunning, ++running);
          await new Promise<void>((resolve) => releases.set(id, resolve));
          running--;
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
    await vi.waitFor(() => expect(started).toEqual(["first", "second", "third"]));
    releases.get("third")!();
    await vi.waitFor(() => expect(started).toEqual(["first", "second", "third", "fourth"]));
    releases.get("fourth")!();
    await vi.waitFor(() => expect(running).toBe(1));
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(completed).not.toHaveBeenCalled();
    // Two worker waves are the memory bound even if the first start stalls.
    expect(started).toEqual(["first", "second", "third", "fourth"]);
    expect((await service.results(job.id)).results).toEqual([]);
    releases.get("first")!();
    await vi.waitFor(() => expect(started).toEqual(["first", "second", "third", "fourth", "fifth", "sixth"]));
    releases.get("sixth")!();
    releases.get("fifth")!();
    await service.waitUntilIdle();
    expect(maximumRunning).toBe(2);
    expect(completed.mock.calls.map((call) => call[1])).toEqual([0, 1, 2, 3, 4, 5]);
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
    await vi.waitFor(() => expect(started).toEqual(["first", "second", "third"]));
    await service[action](job.id);
    await service.waitUntilIdle();
    expect(close).toHaveBeenCalledOnce();
    expect(started).toEqual(["first", "second", "third"]);
    if (action === "delete") expect(await service.get(job.id)).toBeNull();
    else {
      expect(await service.get(job.id)).toMatchObject({ status: "cancelled", progress: { processedAccessPointCount: 0 } });
      expect((await service.results(job.id)).results).toEqual([]);
    }
    store.close();
  });

  it("orders failed checkpoints with successful starts while refilling the failed worker", async () => {
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const started: string[] = [];
    const { service, store } = harness({
      openSearchSession: async () => ({
        concurrency: 2,
        enumerateEligibleAccessPointIds: async () => ["first", "second", "third"],
        searchAccessPoint: async (id) => {
          started.push(id);
          if (id === "first") await blocked;
          if (id === "second") throw new Error("Worker exited");
          return { exact: [route(id)], nearMisses: [], truncated: false };
        },
        close: async () => undefined,
      }),
    });
    const checkpoints: number[] = [];
    const complete = store.completeAccessPoint.bind(store), fail = store.failAccessPoint.bind(store);
    vi.spyOn(store, "completeAccessPoint").mockImplementation((...args) => { checkpoints.push(args[1]); complete(...args); });
    vi.spyOn(store, "failAccessPoint").mockImplementation((...args) => { checkpoints.push(args[1]); fail(...args); });
    const job = await service.create(regionWideRequest);
    try {
      await vi.waitFor(() => expect(started).toEqual(["first", "second", "third"]));
      expect(checkpoints).toEqual([]);
    } finally { release(); await service.waitUntilIdle(); }
    expect(checkpoints).toEqual([0, 1, 2]);
    expect(await service.get(job.id)).toMatchObject({ status: "completed", partial: true,
      progress: { processedAccessPointCount: 3 }, error: "1 trailhead search failed. Available results are retained." });
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

  it("finishes every start in a pass before automatically deepening only retryable starts", async () => {
    const started: string[] = [];
    const releases = new Map<string, () => void>();
    const { service, store, dependencies } = harness({
      openSearchSession: vi.fn(async () => ({
        concurrency: 2,
        enumerateEligibleAccessPointIds: async () => ["first", "second", "third", "fourth"],
        searchAccessPoint: async (id: string, signal: AbortSignal, attempt = 1) => {
          const key = `${id}:${attempt}`;
          started.push(key);
          await new Promise<void>(resolve => {
            releases.set(key, resolve);
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
          const completion = id === "second" ? "limited" as const
            : id === "third" || (id === "fourth" && attempt === 2) || attempt === 3 ? "exhausted" as const : "retryable" as const;
          return { exact: [], nearMisses: [], truncated: completion !== "exhausted", completion };
        },
        close: async () => undefined,
      })),
    });
    const job = await service.create(regionWideRequest);
    try {
      await vi.waitFor(() => expect(started).toEqual(["first:1", "second:1"]));
      releases.get("first:1")!();
      await vi.waitFor(() => expect(started).toContain("third:1"));
      releases.get("third:1")!();
      await vi.waitFor(() => expect(started).toContain("fourth:1"));
      releases.get("fourth:1")!();
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(started).toEqual(["first:1", "second:1", "third:1", "fourth:1"]);
      releases.get("second:1")!();
      await vi.waitFor(() => expect(started).toContain("fourth:2"));
      expect(await service.get(job.id)).toMatchObject({ status: "running", partial: true, progress: {
        searchPass: 2, processedAccessPointCount: 4, exhaustedAccessPointCount: 1, limitedAccessPointCount: 1, unfinishedAccessPointCount: 2,
      } });
      releases.get("first:2")!();
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(started).not.toContain("first:3");
      releases.get("fourth:2")!();
      await vi.waitFor(() => expect(started).toContain("first:3"));
      releases.get("first:3")!();
      await service.waitUntilIdle();
      expect(started).toEqual(["first:1", "second:1", "third:1", "fourth:1", "first:2", "fourth:2", "first:3"]);
      expect(await service.get(job.id)).toMatchObject({ status: "completed", partial: true, progress: {
        searchPass: 3, processedAccessPointCount: 4, exhaustedAccessPointCount: 3, limitedAccessPointCount: 1, unfinishedAccessPointCount: 0,
      } });
      expect(dependencies.openSearchSession).toHaveBeenCalledOnce();
    } finally { await service.cancel(job.id); releases.forEach(release => release()); await service.waitUntilIdle(); store.close(); }
  });

  it("keeps better earlier results across worse attempts and a later worker failure", async () => {
    const pair = (prefix: string, miles: number) => ["a", "b"].map((loop, index): SearchRoute => ({
      ...route(`${prefix}-${loop}`), physicalLoopId: loop, distanceMeters: miles * 1609.344,
      geometry: { type: "LineString", coordinates: [[-122, 37], [-122.1, 37.1 + index / 10], [-122, 37]] },
    }));
    const initial = pair("initial", 6.5), better = pair("better", 6), worse = pair("worse", 7.5);
    const { service, store } = harness({
      openSearchSession: async () => ({
        enumerateEligibleAccessPointIds: async () => ["first"],
        searchAccessPoint: async (_id, _signal, attempt = 1) => {
          if (attempt === 6) throw new Error("Worker exited during improvement");
          return { exact: attempt === 1 ? initial : attempt === 2 ? better.slice(0, 1) : attempt === 3 ? worse : attempt === 4 ? better : [],
            nearMisses: [], truncated: true, completion: "retryable" };
        },
        close: async () => undefined,
      }),
    });
    const completed = vi.spyOn(store, "completeAccessPoint");
    const job = await service.create(regionWideRequest);
    await service.waitUntilIdle();
    expect(completed.mock.calls.map(call => call[2].map(result => result.route.id))).toEqual([
      ["initial-a", "initial-b"], ["initial-a", "initial-b"], ["initial-a", "initial-b"], ["better-a", "better-b"], ["better-a", "better-b"],
    ]);
    expect((await service.results(job.id)).results.map(result => result.route.id)).toEqual(["better-a", "better-b"]);
    expect(await service.get(job.id)).toMatchObject({ status: "completed", partial: true,
      progress: { searchPass: 6, processedAccessPointCount: 1, limitedAccessPointCount: 1, unfinishedAccessPointCount: 0, exactRouteCount: 2 },
      error: "1 trailhead search failed. Available results are retained.",
    });
    store.close();
  });

  it.each(["cancel", "delete"] as const)("keeps durable refinement checkpoints ahead of %s and late worker completion", async action => {
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    let improving = false;
    const { service, store } = harness({
      openSearchSession: async () => ({
        enumerateEligibleAccessPointIds: async () => ["first"],
        searchAccessPoint: async (_id, signal, attempt = 1) => {
          if (attempt > 1) {
            improving = true;
            await Promise.race([blocked, new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }))]);
          }
          return { exact: [route(attempt === 1 ? "first" : "late")], nearMisses: [], truncated: attempt === 1,
            completion: attempt === 1 ? "retryable" : "exhausted" };
        },
        close: async () => { release(); },
      }),
    });
    const job = await service.create(regionWideRequest);
    await vi.waitFor(() => expect(improving).toBe(true));
    expect(await service.get(job.id)).toMatchObject({ progress: { searchPass: 2, processedAccessPointCount: 1, exactRouteCount: 1 } });
    await service[action](job.id);
    release();
    await service.waitUntilIdle();
    if (action === "delete") expect(await service.get(job.id)).toBeNull();
    else {
      expect(await service.get(job.id)).toMatchObject({ status: "cancelled", partial: true, progress: { processedAccessPointCount: 1, unfinishedAccessPointCount: 1 } });
      expect((await service.results(job.id)).results.map(result => result.route.id)).toEqual(["first"]);
    }
    store.close();
  });

  it("uses distance and violation quality to retain better close matches and deterministic ties", () => {
    const exact: RouteJobResult = { matchType: "exact", accessPointId: "first", route: route("exact") };
    const close = (id: string, delta: number): RouteJobResult => ({ matchType: "near-miss", accessPointId: "first",
      route: { ...route(id), violations: [{ constraint: "distance", value: 3, min: 4, max: 8, delta, normalizedDelta: delta / 8 }] },
    });
    const bad = close("bad", 2), good = close("good", 1);
    expect(retainBetterResults([bad], [good], request.criteria)).toEqual([good]);
    expect(retainBetterResults([good], [bad], request.criteria)).toEqual([good]);
    expect(retainBetterResults([good], [exact], request.criteria)).toEqual([exact]);
    expect(retainBetterResults([exact], [good], request.criteria)).toEqual([exact]);
    const earlier = close("a", 1);
    expect(retainBetterResults([good], [earlier], request.criteria)).toEqual([earlier]);
    expect(retainBetterResults([earlier], [good], request.criteria)).toEqual([earlier]);
  });

  it("resumes the interrupted refinement budget against the saved installation", async () => {
    const directory = mkdtempSync(join(tmpdir(), "route-job-resume-refinement-"));
    temporary.push(directory);
    const path = join(directory, "jobs.sqlite");
    let store = new SQLiteRouteJobStore(path);
    const id = "00000000-0000-4000-8000-000000000014";
    store.create(id, regionWideRequest, plan);
    store.claimNext();
    store.initializeAccessPoints(id, ["first", "second"]);
    store.nextAccessPoint(id);
    store.completeAccessPoint(id, 0, [{ matchType: "exact", accessPointId: "first", route: route("saved") }], true, {}, { attempt: 1, completion: "retryable" });
    store.nextAccessPoint(id);
    store.completeAccessPoint(id, 1, [], false, {}, { attempt: 1, completion: "exhausted" });
    store.beginNextPass(id);
    store.nextAccessPoint(id);
    store.close();
    store = new SQLiteRouteJobStore(path);
    const { dependencies, store: unused, service: idle } = harness();
    await idle.waitUntilIdle(); unused.close();
    const search = vi.fn(async () => ({ exact: [], nearMisses: [], truncated: false, completion: "exhausted" as const }));
    const pinned: string[] = [];
    const service = new RouteJobService({ store, dependencies: { ...dependencies,
      pinInstallation: (installationId, action) => { pinned.push(installationId); return dependencies.pinInstallation(installationId, action); },
      openSearchSession: async () => ({ enumerateEligibleAccessPointIds: async () => ["first", "second"], searchAccessPoint: search, close: async () => undefined }),
    } });
    await service.waitUntilIdle();
    expect(search).toHaveBeenCalledExactlyOnceWith("first", expect.any(AbortSignal), 2);
    expect(pinned).toEqual(["v4"]);
    expect(await service.get(id)).toMatchObject({ status: "completed", partial: false,
      progress: { searchPass: 2, processedAccessPointCount: 2, exhaustedAccessPointCount: 2, unfinishedAccessPointCount: 0 },
    });
    expect((await service.results(id)).results.map(result => result.route.id)).toEqual(["saved"]);
    store.close();
  });

  it.each([false, true])("does not infer retries from legacy sessions without completion (truncated: %s)", async truncated => {
    const search = vi.fn(async () => ({ exact: [], nearMisses: [], truncated, diagnostics: { hardTruncationReasons: truncated ? ["deadline"] : [] } }));
    const { service, store } = harness({ openSearchSession: async () => ({
      enumerateEligibleAccessPointIds: async () => ["first"], searchAccessPoint: search, close: async () => undefined,
    }) });
    const job = await service.create(regionWideRequest);
    await service.waitUntilIdle();
    expect(search).toHaveBeenCalledTimes(1);
    expect(await service.get(job.id)).toMatchObject({ status: "completed", partial: truncated, progress: {
      searchPass: 1, processedAccessPointCount: 1, exhaustedAccessPointCount: truncated ? 0 : 1,
      limitedAccessPointCount: truncated ? 1 : 0, unfinishedAccessPointCount: 0,
    } });
    store.close();
  });

  it("rejects malformed cursors and round-trips tuple cursors", () => {
    const cursor = { matchRank: 1, accessOrdinal: 2, resultOrdinal: 3, routeId: "route" };
    expect(decodeResultCursor(encodeResultCursor(cursor))).toEqual(cursor);
    expect(() => decodeResultCursor("broken")).toThrow(/cursor is invalid/i);
    expect(() => decodeResultCursor("x".repeat(2_049))).toThrow(/cursor is invalid/i);
  });
});
