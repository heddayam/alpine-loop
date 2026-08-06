import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CreateBatchRouteJobV1, GeneratedClosedRouteV3 } from "@/lib/contracts";
import { RouteJobService, decodeResultCursor, encodeResultCursor } from "./service";
import { SQLiteRouteJobStore } from "./store";
import type { RouteJobRunnerDependencies } from "./types";

const temporary: string[] = [];
afterEach(() => temporary.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

const request: CreateBatchRouteJobV1 = {
  version: 1, packId: "fixture-pack",
  origin: { lon: -122.1, lat: 37.3, label: "Home" }, durationMinutes: 30,
  searchRegionId: "pack:fixture-pack",
  criteria: { closedRoute: { maximumRepeatedTrailPct: 35, allowMultiCycle: true }, distanceMiles: { min: 4, max: 8 }, includeUncertainAccess: true, accessPointRemoteness: ["remote"] },
  routesPerAccessPoint: 10,
};
const geometry = { type: "Polygon" as const, coordinates: [[[-123, 37], [-122, 37], [-122, 38], [-123, 38], [-123, 37]]] };

function route(id: string): GeneratedClosedRouteV3 {
  return {
    id, geometry: { type: "LineString", coordinates: [[-122.1, 37.3], [-122.11, 37.31], [-122.1, 37.3]] },
    startAccessPoint: { id: "access", name: "Access", lon: -122.1, lat: 37.3, accessState: "public", confidence: "high" },
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
    resolveJob: vi.fn(async () => ({ pack: { id: "fixture-pack", dataVersion: "v4", builtAt: "2026-01-01T00:00:00.000Z" }, searchRegion: { id: "pack:fixture-pack", name: "Fixture" } })),
    resolveDriveTime: vi.fn(async () => ({ geometry, resolvedAt: "2026-01-01T00:00:00.000Z" })),
    enumerateEligibleAccessPointIds: vi.fn(async () => ["first", "second"]),
    searchAccessPoint: vi.fn(async ({ accessPointId }) => ({ exact: [route(accessPointId)], nearMisses: [], truncated: false })),
    currentDataVersion: vi.fn(async () => "v4"),
    ...overrides,
  };
  const ids = ["00000000-0000-4000-8000-000000000010", "00000000-0000-4000-8000-000000000011"];
  const service = new RouteJobService({ store, dependencies, id: () => ids.shift()! });
  return { store, service, dependencies };
}

describe("RouteJobService", () => {
  it("runs jobs FIFO, attempts each eligible access point, and persists deterministic results", async () => {
    const { service, dependencies, store } = harness();
    const first = await service.create(request);
    const second = await service.create({ ...request, origin: { ...request.origin, label: "Other" } });
    await service.waitUntilIdle();
    expect((await service.get(first.id))?.status).toBe("completed");
    expect((await service.get(second.id))?.status).toBe("completed");
    expect(vi.mocked(dependencies.searchAccessPoint).mock.calls.map(([input]) => input.accessPointId)).toEqual(["first", "second", "first", "second"]);
    expect((await service.results(first.id)).results.map(({ route: value }) => value.id)).toEqual(["first", "second"]);
    store.close();
  });

  it("cancels active work, retains completed checkpoints, and deletes with cascade", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const { service, store } = harness({
      searchAccessPoint: vi.fn(async ({ accessPointId, signal }) => {
        if (accessPointId === "second") await Promise.race([
          blocked,
          new Promise((_, reject) => signal.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError")), { once: true })),
        ]);
        return { exact: [route(accessPointId)], nearMisses: [], truncated: false };
      }),
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

  it("rejects malformed cursors and round-trips tuple cursors", () => {
    const cursor = { matchRank: 1, accessOrdinal: 2, resultOrdinal: 3, routeId: "route" };
    expect(decodeResultCursor(encodeResultCursor(cursor))).toEqual(cursor);
    expect(() => decodeResultCursor("broken")).toThrow(/cursor is invalid/i);
  });
});
