import { afterEach, describe, expect, it, vi } from "vitest";
import { ReachabilityError } from "./errors";
import { DRIVE_TIME_AREA_DEADLINE_MS, DRIVE_TIME_AREA_TTL_MS, ReachabilityService } from "./service";
import { TestClock, TestUsageStore } from "./test-helpers";
import type { ArcGisProvider, AreaGeometry, DriveTimeAreaRequest } from "./types";

const REQUEST: DriveTimeAreaRequest = {
  origin: { lon: -122.1, lat: 37.2, label: "Private origin" },
  durationMinutes: 30,
};
const GEOMETRY: AreaGeometry = {
  type: "Polygon",
  coordinates: [[[-122.2, 37.1], [-122.2, 37.2], [-122.1, 37.1], [-122.2, 37.1]]],
};

function setup() {
  const clock = new TestClock();
  const usage = new TestUsageStore();
  const provider: ArcGisProvider = {
    suggest: vi.fn(async () => [{ id: "one", label: "One", magicKey: "one" }]),
    resolve: vi.fn(async () => REQUEST.origin),
    submitServiceArea: vi.fn(async () => "provider-job"),
    pollServiceArea: vi.fn(async () => ({ state: "complete" as const, geometry: structuredClone(GEOMETRY) })),
    cancelServiceArea: vi.fn(async () => undefined),
  };
  return { clock, usage, provider, service: new ReachabilityService({ provider, usage, clock }) };
}
const signal = () => new AbortController().signal;
afterEach(() => vi.useRealTimers());

describe("drive-time area resolution", () => {
  it("reserves before every geocoding provider call", async () => {
    const context = setup();
    await expect(context.service.suggest("trailhead")).resolves.toHaveLength(1);
    expect(context.usage.reserve).toHaveBeenCalledBefore(context.provider.suggest as ReturnType<typeof vi.fn>);
    await expect(context.service.resolve("trailhead", "one")).resolves.toEqual(REQUEST.origin);
    expect(context.usage.reserve).toHaveBeenCalledTimes(2);
  });

  it("blocks provider work when quota storage fails or the cap is reached", async () => {
    const context = setup();
    context.usage.reserve.mockRejectedValueOnce(new Error("disk unavailable"));
    await expect(context.service.resolveArea(REQUEST, signal())).rejects.toMatchObject({ code: "USAGE_UNAVAILABLE" });
    context.usage.reserve.mockResolvedValueOnce(null);
    await expect(context.service.resolveArea(REQUEST, signal())).rejects.toMatchObject({ code: "USAGE_LIMIT_REACHED" });
    expect(context.provider.submitServiceArea).not.toHaveBeenCalled();
  });

  it("polls internally and reuses completed geometry without sharing labels or mutable results", async () => {
    const context = setup();
    vi.mocked(context.provider.pollServiceArea).mockResolvedValueOnce({ state: "pending" });
    const first = await context.service.resolveArea(REQUEST, signal());
    expect(first).toEqual({
      geometry: GEOMETRY, durationMinutes: 30,
      resolvedAt: "2026-08-04T12:00:00.000Z", originLabel: "Private origin",
    });
    expect(context.clock.sleeps).toEqual([1_000]);
    expect(context.usage.reserve).toHaveBeenCalledBefore(context.provider.submitServiceArea as ReturnType<typeof vi.fn>);
    first.geometry.coordinates.length = 0;
    const cached = await context.service.resolveArea({ ...REQUEST, origin: { ...REQUEST.origin, label: "New label" } }, signal());
    expect(cached).toMatchObject({ geometry: GEOMETRY, originLabel: "New label" });
    expect(context.provider.submitServiceArea).toHaveBeenCalledOnce();
    expect(context.usage.reserve).toHaveBeenCalledOnce();
    context.clock.advance(DRIVE_TIME_AREA_TTL_MS);
    await context.service.resolveArea(REQUEST, signal());
    await context.service.resolveArea({ ...REQUEST, durationMinutes: 60 }, signal());
    expect(context.provider.submitServiceArea).toHaveBeenCalledTimes(3);
  });

  it("does not cache provider failures or expose unexpected provider details", async () => {
    const context = setup();
    vi.mocked(context.provider.pollServiceArea).mockResolvedValueOnce({ state: "failed", message: "No roads nearby." });
    await expect(context.service.resolveArea(REQUEST, signal())).rejects.toMatchObject({ code: "REACHABILITY_FAILED" });
    vi.mocked(context.provider.submitServiceArea).mockRejectedValueOnce(new Error("secret origin in upstream body"));
    await expect(context.service.resolveArea(REQUEST, signal())).rejects.toEqual(expect.objectContaining({
      code: "PROVIDER_UNAVAILABLE", message: "The ArcGIS service could not be reached.",
    } satisfies Partial<ReachabilityError>));
    await expect(context.service.resolveArea(REQUEST, signal())).resolves.toMatchObject({ geometry: GEOMETRY });
    expect(context.provider.submitServiceArea).toHaveBeenCalledTimes(3);
  });

  it("aborts even if provider polling and cancellation do not settle", async () => {
    const context = setup();
    const controller = new AbortController();
    vi.mocked(context.provider.pollServiceArea).mockImplementationOnce(async () => {
      controller.abort();
      return new Promise(() => undefined);
    });
    vi.mocked(context.provider.cancelServiceArea).mockImplementationOnce(async () => new Promise(() => undefined));
    await expect(context.service.resolveArea(REQUEST, controller.signal)).rejects.toMatchObject({ code: "REQUEST_CANCELLED" });
    expect(context.provider.cancelServiceArea).toHaveBeenCalledWith("provider-job", expect.any(AbortSignal));
    await expect(context.service.resolveArea(REQUEST, signal())).resolves.toMatchObject({ geometry: GEOMETRY });
    expect(context.provider.submitServiceArea).toHaveBeenCalledTimes(2);
  });

  it("enforces the overall deadline while a provider request is stuck", async () => {
    vi.useFakeTimers();
    const context = setup();
    vi.mocked(context.provider.pollServiceArea).mockImplementationOnce(async () => new Promise(() => undefined));
    const result = context.service.resolveArea(REQUEST, signal());
    const rejected = expect(result).rejects.toMatchObject({ code: "REACHABILITY_FAILED", status: 504 });
    await vi.advanceTimersByTimeAsync(DRIVE_TIME_AREA_DEADLINE_MS);
    await rejected;
    expect(context.provider.cancelServiceArea).toHaveBeenCalledOnce();
  });

  it("does not reserve usage or return cached data for an already cancelled request", async () => {
    const context = setup();
    await context.service.resolveArea(REQUEST, signal());
    const controller = new AbortController();
    controller.abort();
    await expect(context.service.resolveArea(REQUEST, controller.signal)).rejects.toMatchObject({ code: "REQUEST_CANCELLED" });
    expect(context.usage.reserve).toHaveBeenCalledOnce();
  });
});
