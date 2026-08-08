import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CreateBatchRouteJobV1, RouteJobResult } from "@/lib/contracts";
import { SQLiteRouteJobStore } from "./store";

const temporary: string[] = [];
afterEach(() => temporary.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

const request: CreateBatchRouteJobV1 = {
  version: 1,
  packId: "fixture-pack",
  origin: { lon: -122.1, lat: 37.3, label: "Home" },
  durationMinutes: 30,
  searchRegionId: "pack:fixture-pack",
  criteria: {
    closedRoute: { maximumRepeatedTrailPct: 35, allowMultiCycle: true },
    distanceMiles: { min: 4, max: 8 },
    includeUncertainAccess: true,
  },
  routesPerAccessPoint: 10,
};

function route(id: string) {
  return {
    id,
    geometry: { type: "LineString" as const, coordinates: [[-122.1, 37.3], [-122.11, 37.31], [-122.1, 37.3]] as [number, number][] },
    startAccessPoint: { id: "access", name: "Access", lon: -122.1, lat: 37.3, accessState: "public" as const, confidence: "high" as const },
    distanceMeters: 6_000,
    elevationGainMeters: 200,
    elevationLossMeters: 200,
    minimumElevationMeters: 100,
    maximumElevationMeters: 300,
    steepestSustainedGradePct: 8,
    topology: { kind: "simple-loop" as const, cycleCount: 1, cycleBlockCount: 1, repeatedTrailDistanceMeters: 0, repeatedTrailFraction: 0, sharedStemDistanceMeters: 0, connectorCount: 0 },
    trailNames: ["Fixture"],
    warnings: [],
    source: { freshness: "2026-01-01T00:00:00.000Z", confidence: "high" as const, sourceIds: ["fixture"] },
  };
}

function setup(now: () => Date = () => new Date("2026-01-01T00:00:00.000Z")) {
  const directory = mkdtempSync(join(tmpdir(), "route-job-store-"));
  temporary.push(directory);
  const path = join(directory, "jobs.sqlite");
  return { path, store: new SQLiteRouteJobStore(path, now) };
}

const resolved = {
  pack: { id: "fixture-pack", dataVersion: "fixture-v4", builtAt: "2026-01-01T00:00:00.000Z" },
  searchRegion: { id: "pack:fixture-pack", name: "Fixture Region" },
};

describe("SQLiteRouteJobStore", () => {
  it("recovers active jobs and running checkpoints for deterministic resume", () => {
    const { path, store } = setup();
    store.create("00000000-0000-4000-8000-000000000001", request, resolved);
    expect(store.claimNext()?.status).toBe("resolving-drive-time");
    store.saveDriveTime("00000000-0000-4000-8000-000000000001", {
      geometry: { type: "Polygon", coordinates: [[[-123, 37], [-122, 37], [-122, 38], [-123, 38], [-123, 37]]] },
      resolvedAt: "2026-01-01T00:00:01.000Z",
    });
    const id = "00000000-0000-4000-8000-000000000001";
    store.initializeAccessPoints(id, ["b", "a"]);
    expect(store.nextAccessPoint(id)).toEqual({ ordinal: 0, accessPointId: "b" });
    store.completeAccessPoint(id, 0, [{ matchType: "exact", accessPointId: "b", route: route("saved") }], false);
    expect(store.nextAccessPoint(id)).toEqual({ ordinal: 1, accessPointId: "a" });
    store.close();

    const reopened = new SQLiteRouteJobStore(path);
    expect(reopened.getStored(id)).toMatchObject({ status: "queued", geometry: { type: "Polygon" } });
    expect(reopened.toPublic(id, false)?.progress.processedAccessPointCount).toBe(1);
    expect(reopened.pageResults(id, undefined, 50).results.map(({ route: result }) => result.id)).toEqual(["saved"]);
    expect(reopened.claimNext()?.status).toBe("running");
    expect(reopened.nextAccessPoint(id)).toEqual({ ordinal: 1, accessPointId: "a" });
    reopened.close();
  });

  it("finalizes an interrupted cancellation instead of leaving it unclaimable in the queue", () => {
    const { path, store } = setup();
    const id = "00000000-0000-4000-8000-000000000004";
    store.create(id, request, resolved);
    expect(store.claimNext()?.status).toBe("resolving-drive-time");
    store.saveDriveTime(id, {
      geometry: { type: "Polygon", coordinates: [[[-123, 37], [-122, 37], [-122, 38], [-123, 38], [-123, 37]]] },
      resolvedAt: "2026-01-01T00:00:01.000Z",
    });
    store.initializeAccessPoints(id, ["first", "second"]);
    store.completeAccessPoint(id, 0, [{ matchType: "exact", accessPointId: "first", route: route("saved") }], false);
    expect(store.nextAccessPoint(id)).toEqual({ ordinal: 1, accessPointId: "second" });
    expect(store.requestCancel(id)).toBe("requested");
    store.close();

    const reopened = new SQLiteRouteJobStore(path);
    expect(reopened.getStored(id)?.status).toBe("cancelled");
    expect(reopened.toPublic(id, false)).toMatchObject({
      status: "cancelled",
      partial: true,
      progress: { eligibleAccessPointCount: 2, processedAccessPointCount: 1, exactRouteCount: 1 },
    });
    expect(reopened.claimNext()).toBeNull();
    reopened.close();
  });

  it("updates the job heartbeat when a checkpoint starts", () => {
    let current = new Date("2026-01-01T00:00:00.000Z");
    const { store } = setup(() => current);
    const id = "00000000-0000-4000-8000-000000000005";
    store.create(id, request, resolved);
    store.initializeAccessPoints(id, ["first"]);
    current = new Date("2026-01-01T00:00:05.000Z");
    store.nextAccessPoint(id);
    expect(store.toPublic(id, false)?.updatedAt).toBe("2026-01-01T00:00:05.000Z");
    store.close();
  });

  it("checkpoints results atomically and paginates exact matches before near misses", () => {
    const { store } = setup();
    const id = "00000000-0000-4000-8000-000000000002";
    store.create(id, request, resolved);
    store.initializeAccessPoints(id, ["first", "second"]);
    const near: RouteJobResult = {
      matchType: "near-miss", accessPointId: "first",
      route: { ...route("near"), geometry: { type: "LineString", coordinates: [[-122.1, 37.3], [-122.12, 37.32], [-122.1, 37.3]] }, violations: [{ constraint: "distance", value: 3, min: 4, max: 8, delta: 1, normalizedDelta: 0.125 }] },
    };
    const exact: RouteJobResult = { matchType: "exact", accessPointId: "second", route: route("exact") };
    store.completeAccessPoint(id, 0, [near], true);
    store.completeAccessPoint(id, 1, [exact], false);
    store.finish(id, "completed");
    const first = store.pageResults(id, undefined, 1);
    expect(first.results.map(({ matchType }) => matchType)).toEqual(["exact"]);
    expect(first.next).toBeDefined();
    expect(store.pageResults(id, first.next, 1).results.map(({ matchType }) => matchType)).toEqual(["near-miss"]);
    expect(store.toPublic(id, true)).toMatchObject({
      stale: true,
      progress: { eligibleAccessPointCount: 2, processedAccessPointCount: 2, exactRouteCount: 1, nearMissRouteCount: 1, truncatedAccessPointCount: 1 },
    });
    store.close();
  });

  it("retains one result for identical geometry across access points and prefers exact", () => {
    const { store } = setup();
    const id = "00000000-0000-4000-8000-000000000012";
    store.create(id, request, resolved);
    store.initializeAccessPoints(id, ["first", "second", "third"]);
    const duplicateNear: RouteJobResult = {
      matchType: "near-miss", accessPointId: "first",
      route: { ...route("near-duplicate"), violations: [{ constraint: "distance", value: 3, min: 4, max: 8, delta: 1, normalizedDelta: 0.125 }] },
    };
    store.completeAccessPoint(id, 0, [duplicateNear], false);
    store.completeAccessPoint(id, 1, [{ matchType: "exact", accessPointId: "second", route: route("exact-duplicate") }], false);
    store.completeAccessPoint(id, 2, [{ matchType: "exact", accessPointId: "third", route: route("later-duplicate") }], false);
    expect(store.pageResults(id, undefined, 50).results.map(({ matchType, route: result }) => [matchType, result.id]))
      .toEqual([["exact", "exact-duplicate"]]);
    store.close();
  });

  it("cascades checkpoints and results when a terminal job is deleted", () => {
    const { store } = setup();
    const id = "00000000-0000-4000-8000-000000000003";
    store.create(id, request, resolved);
    store.initializeAccessPoints(id, ["first"]);
    store.completeAccessPoint(id, 0, [{ matchType: "exact", accessPointId: "first", route: route("exact") }], false);
    expect(store.requestDelete(id)).toBe("deleted");
    expect(store.getStored(id)).toBeNull();
    expect(store.pageResults(id, undefined, 50).results).toEqual([]);
    store.close();
  });
});
