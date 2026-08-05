import { describe, expect, it, vi } from "vitest";
import type { ReachabilityRequest } from "@/lib/contracts";
import { ReachabilityError } from "./errors";
import { MemoryReachabilityJobStore, REACHABILITY_JOB_TTL_MS } from "./jobs";
import { ReachabilityService } from "./service";
import { TestClock, TestUsageStore } from "./test-helpers";
import type { ArcGisProvider, AreaGeometry } from "./types";

const ID = "db52ceda-c6ef-47f1-9153-dba294a9eccc";
const REQUEST: ReachabilityRequest = {
  version: 1,
  packId: "fixture",
  origin: { lon: -122.1, lat: 37.2, label: "Private origin" },
  durationMinutes: 30,
};
const GEOMETRY: AreaGeometry = {
  type: "Polygon" as const,
  coordinates: [[[-122.2, 37.1], [-122.2, 37.2], [-122.1, 37.1], [-122.2, 37.1]]],
};

function provider(): ArcGisProvider {
  return {
    suggest: vi.fn(async () => [{ id: "one", label: "One", magicKey: "one" }]),
    resolve: vi.fn(async () => REQUEST.origin),
    submitServiceArea: vi.fn(async () => "provider-job"),
    pollServiceArea: vi.fn(async (): Promise<{ state: "pending" }> => ({ state: "pending" })),
    cancelServiceArea: vi.fn(async () => undefined),
  };
}

function setup(overrides: { provider?: ArcGisProvider; usage?: TestUsageStore } = {}) {
  const clock = new TestClock();
  const arcgis = overrides.provider ?? provider();
  const usage = overrides.usage ?? new TestUsageStore();
  const jobs = new MemoryReachabilityJobStore(clock);
  return {
    clock,
    provider: arcgis,
    usage,
    service: new ReachabilityService({
      provider: arcgis,
      usage,
      jobs,
      clock,
      id: () => ID,
    }),
  };
}

describe("reachability orchestration", () => {
  it("reserves before every geocoding provider call", async () => {
    const context = setup();
    await expect(context.service.suggest("trailhead")).resolves.toHaveLength(1);
    expect(context.usage.reserve).toHaveBeenCalledBefore(context.provider.suggest as ReturnType<typeof vi.fn>);
    await expect(context.service.resolve("trailhead", "one")).resolves.toEqual(REQUEST.origin);
    expect(context.usage.reserve).toHaveBeenCalledTimes(2);
  });

  it("fails closed without contacting ArcGIS when quota storage is unavailable", async () => {
    const usage = new TestUsageStore();
    usage.reserve.mockRejectedValue(new Error("disk unavailable"));
    const context = setup({ usage });

    await expect(context.service.submit(REQUEST)).rejects.toMatchObject({ code: "USAGE_UNAVAILABLE" });
    expect(context.provider.submitServiceArea).not.toHaveBeenCalled();
  });

  it("fails closed at the monthly cap", async () => {
    const usage = new TestUsageStore();
    usage.reserve.mockResolvedValue(null);
    const context = setup({ usage });

    await expect(context.service.submit(REQUEST)).rejects.toMatchObject({ code: "USAGE_LIMIT_REACHED" });
    expect(context.provider.submitServiceArea).not.toHaveBeenCalled();
  });

  it("submits asynchronously, reuses live work, and completes on poll", async () => {
    const arcgis = provider();
    vi.mocked(arcgis.pollServiceArea).mockResolvedValue({ state: "complete", geometry: GEOMETRY });
    const context = setup({ provider: arcgis });

    await expect(context.service.submit(REQUEST)).resolves.toEqual({
      status: "pending",
      requestId: ID,
      pollAfterMs: 1_000,
    });
    await expect(context.service.submit(REQUEST)).resolves.toEqual({
      status: "pending",
      requestId: ID,
      pollAfterMs: 1_000,
    });
    expect(arcgis.submitServiceArea).toHaveBeenCalledOnce();

    await expect(context.service.poll(ID)).resolves.toEqual({
      status: "complete",
      requestId: ID,
      provider: "arcgis",
      durationMinutes: 30,
      resolvedAt: "2026-08-04T12:00:00.000Z",
      geometry: GEOMETRY,
    });
    await expect(context.service.poll(ID)).resolves.toMatchObject({ status: "complete" });
    expect(arcgis.pollServiceArea).toHaveBeenCalledOnce();
    expect(context.service.resolveCompleted(ID, REQUEST.packId)).toEqual({
      geometry: GEOMETRY,
      durationMinutes: 30,
      resolvedAt: "2026-08-04T12:00:00.000Z",
      originLabel: "Private origin",
    });
    expect(arcgis.pollServiceArea).toHaveBeenCalledOnce();
  });

  it("distinguishes pending and cross-pack resolution without contacting ArcGIS", async () => {
    const context = setup();
    await context.service.submit(REQUEST);
    expect(() => context.service.resolveCompleted(ID, REQUEST.packId)).toThrowError(
      expect.objectContaining({ code: "REACHABILITY_PENDING" }),
    );
    expect(() => context.service.resolveCompleted(ID, "different-pack")).toThrowError(
      expect.objectContaining({ code: "REACHABILITY_PACK_MISMATCH" }),
    );
    expect(context.provider.pollServiceArea).not.toHaveBeenCalled();
  });

  it("returns distinct failed, missing, and expired errors", async () => {
    const failedProvider = provider();
    vi.mocked(failedProvider.pollServiceArea).mockResolvedValue({ state: "failed", message: "No roads nearby." });
    const failed = setup({ provider: failedProvider });
    await failed.service.submit(REQUEST);
    await expect(failed.service.poll(ID)).rejects.toMatchObject({ code: "REACHABILITY_FAILED" });
    await expect(failed.service.poll("7e20fc45-e3e2-4ef0-ab22-da382ce3a0a1")).rejects.toMatchObject({ code: "REACHABILITY_NOT_FOUND" });

    const expired = setup();
    await expired.service.submit(REQUEST);
    expired.clock.advance(REACHABILITY_JOB_TTL_MS);
    await expect(expired.service.poll(ID)).rejects.toMatchObject({ code: "REACHABILITY_EXPIRED" });
  });

  it("cancels an upstream pending job and removes local location state", async () => {
    const context = setup();
    await context.service.submit(REQUEST);
    await expect(context.service.cancel(ID)).resolves.toBeUndefined();
    expect(context.provider.cancelServiceArea).toHaveBeenCalledWith("provider-job", undefined);
    await expect(context.service.poll(ID)).rejects.toMatchObject({ code: "REACHABILITY_NOT_FOUND" });
  });

  it("propagates cancellation without rewriting it as a provider outage", async () => {
    const arcgis = provider();
    vi.mocked(arcgis.submitServiceArea).mockRejectedValue(new DOMException("Aborted", "AbortError"));
    const context = setup({ provider: arcgis });
    await expect(context.service.submit(REQUEST)).rejects.toMatchObject({ code: "REQUEST_CANCELLED" });
  });

  it("does not expose provider details through unexpected errors", async () => {
    const arcgis = provider();
    vi.mocked(arcgis.submitServiceArea).mockRejectedValue(new Error("secret origin in upstream body"));
    const context = setup({ provider: arcgis });
    await expect(context.service.submit(REQUEST)).rejects.toEqual(expect.objectContaining({
      code: "PROVIDER_UNAVAILABLE",
      message: "The ArcGIS service could not be reached.",
    } satisfies Partial<ReachabilityError>));
  });
});
