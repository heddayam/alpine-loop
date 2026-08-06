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
    accessPointRemoteness: ["remote"],
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

function setup() {
  const directory = mkdtempSync(join(tmpdir(), "route-job-store-"));
  temporary.push(directory);
  const path = join(directory, "jobs.sqlite");
  return { path, store: new SQLiteRouteJobStore(path, () => new Date("2026-01-01T00:00:00.000Z")) };
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
    store.initializeAccessPoints("00000000-0000-4000-8000-000000000001", ["b", "a"]);
    expect(store.nextAccessPoint("00000000-0000-4000-8000-000000000001")).toEqual({ ordinal: 0, accessPointId: "b" });
    store.close();

    const reopened = new SQLiteRouteJobStore(path);
    expect(reopened.getStored("00000000-0000-4000-8000-000000000001")?.status).toBe("queued");
    expect(reopened.claimNext()?.status).toBe("running");
    expect(reopened.nextAccessPoint("00000000-0000-4000-8000-000000000001")).toEqual({ ordinal: 0, accessPointId: "b" });
    reopened.close();
  });

  it("checkpoints results atomically and paginates exact matches before near misses", () => {
    const { store } = setup();
    const id = "00000000-0000-4000-8000-000000000002";
    store.create(id, request, resolved);
    store.initializeAccessPoints(id, ["first", "second"]);
    const near: RouteJobResult = {
      matchType: "near-miss", accessPointId: "first",
      route: { ...route("near"), violations: [{ constraint: "distance", value: 3, min: 4, max: 8, delta: 1, normalizedDelta: 0.125 }] },
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
