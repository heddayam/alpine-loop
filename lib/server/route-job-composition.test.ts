import { getEventListeners } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CreateBatchRouteJobV1, ReachabilityRequest, ReachabilityResponse } from "@/lib/contracts";
import type { RegisteredRoutePack } from "./pack-registry";
import { resolveBatchDriveTime, resolveBatchRouteJob } from "./route-job-composition";

const requestId = "00000000-0000-4000-8000-000000000099";
const request: ReachabilityRequest = {
  version: 1,
  packId: "fixture-pack",
  origin: { lon: -122.1, lat: 37.3, label: "Home" },
  durationMinutes: 30,
};
const geometry: Extract<ReachabilityResponse, { status: "complete" }>["geometry"] = {
  type: "Polygon" as const,
  coordinates: [[[-123, 37], [-122, 37], [-122, 38], [-123, 38], [-123, 37]]],
};
const drawnRequest: CreateBatchRouteJobV1 = {
  version: 1,
  packId: "fixture-pack",
  drawnAreaBbox: [-122.4, 37.1, -122.2, 37.3],
  criteria: {
    closedRoute: { maximumRepeatedTrailPct: 35, allowMultiCycle: true },
    distanceMiles: { min: 4, max: 8 },
    includeUncertainAccess: true,
  },
  routesPerAccessPoint: 10,
};

function batchPack(overrides: Partial<RegisteredRoutePack> = {}): RegisteredRoutePack {
  return {
    id: "fixture-pack",
    schemaVersion: "3",
    dataVersion: "fixture-v3",
    builtAt: "2026-01-01T00:00:00.000Z",
    kind: "installed",
    sourceFreshness: "2026-01-01T00:00:00.000Z",
    sourceConfidence: "high",
    fallbackSourceIds: ["fixture"],
    coverageBbox: [-123, 37, -122, 38],
    coverage: geometry,
    maximumAreaSquareKilometers: 100,
    loadRepository: vi.fn(),
    ...overrides,
  };
}

afterEach(() => vi.useRealTimers());

describe("resolveBatchDriveTime", () => {
  it("resolves a drawn-area job without consulting a reviewed-region catalog", async () => {
    const getSearchRegion = vi.fn();

    await expect(resolveBatchRouteJob(batchPack({ getSearchRegion }), drawnRequest)).resolves.toEqual({
      pack: { id: "fixture-pack", dataVersion: "fixture-v3", builtAt: "2026-01-01T00:00:00.000Z" },
      searchRegion: { id: "drawn-area", name: "Drawn area" },
    });
    expect(getSearchRegion).not.toHaveBeenCalled();
  });

  it("polls through pending responses with injectable delays", async () => {
    const pending: ReachabilityResponse = { status: "pending", requestId, pollAfterMs: 500 };
    const complete = {
      status: "complete",
      requestId,
      provider: "arcgis",
      durationMinutes: 30,
      resolvedAt: "2026-08-06T12:00:00.000Z",
      geometry,
    } satisfies ReachabilityResponse;
    const service = {
      submit: vi.fn(async () => pending),
      poll: vi.fn()
        .mockResolvedValueOnce(pending)
        .mockResolvedValueOnce(complete),
    };
    const delay = vi.fn(async () => undefined);

    await expect(resolveBatchDriveTime(service, request, new AbortController().signal, { delay }))
      .resolves.toEqual({ geometry, resolvedAt: complete.resolvedAt });
    expect(delay).toHaveBeenCalledTimes(2);
    expect(delay).toHaveBeenNthCalledWith(1, 500, expect.any(AbortSignal));
    expect(service.poll).toHaveBeenCalledTimes(2);
  });

  it("removes completed polling-delay abort listeners", async () => {
    vi.useFakeTimers();
    const pending: ReachabilityResponse = { status: "pending", requestId, pollAfterMs: 1 };
    const complete = {
      status: "complete",
      requestId,
      provider: "arcgis",
      durationMinutes: 30,
      resolvedAt: "2026-08-06T12:00:00.000Z",
      geometry,
    } satisfies ReachabilityResponse;
    let pollingSignal: AbortSignal | undefined;
    const service = {
      submit: vi.fn(async () => pending),
      poll: vi.fn(async (_requestId: string, signal: AbortSignal) => {
        pollingSignal = signal;
        return service.poll.mock.calls.length < 3 ? pending : complete;
      }),
    };

    const resolution = resolveBatchDriveTime(service, request, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(3);
    await resolution;

    expect(pollingSignal).toBeDefined();
    expect(getEventListeners(pollingSignal!, "abort")).toHaveLength(0);
  });

  it("bounds total resolution time without cancelling a shared provider job", async () => {
    vi.useFakeTimers();
    const service = {
      submit: vi.fn(() => new Promise<ReachabilityResponse>(() => undefined)),
      poll: vi.fn(),
      cancel: vi.fn(),
    };

    const resolution = resolveBatchDriveTime(service, request, new AbortController().signal, {
      deadlineMs: 5_000,
    });
    const rejection = expect(resolution).rejects.toThrow("Drive-time resolution exceeded 5000 ms");
    await vi.advanceTimersByTimeAsync(5_000);

    await rejection;
    expect(service.poll).not.toHaveBeenCalled();
    expect(service.cancel).not.toHaveBeenCalled();
  });
});
