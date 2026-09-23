import { describe, expect, it, vi } from "vitest";
import { coordinateIsInsideArea } from "@/lib/graph/geometry";
import type { DriveTimeAreaRequest } from "./types";
import { ArcGisClient, buildServiceAreaSubmitBody } from "./arcgis";
import { TestClock } from "./test-helpers";

const REQUEST: DriveTimeAreaRequest = {
  origin: { lon: -122.15, lat: 37.15, label: "Private origin label" },
  durationMinutes: 300,
};

function json(payload: unknown, status = 200): Response {
  return Response.json(payload, { status });
}

describe("ArcGIS client", () => {
  it("serializes a traffic-neutral outbound WGS84 service-area job", () => {
    const body = buildServiceAreaSubmitBody(REQUEST, "secret");
    const facilities = JSON.parse(String(body.get("facilities"))) as {
      spatialReference: { wkid: number };
      features: Array<{ geometry: { x: number; y: number } }>;
    };
    expect(facilities.spatialReference).toEqual({ wkid: 4326 });
    expect(facilities.features[0].geometry).toEqual({ x: -122.15, y: 37.15 });
    expect(body.get("break_values")).toBe("300");
    expect(body.get("break_units")).toBe("Minutes");
    expect(body.get("travel_direction")).toBe("Away from Facility");
    expect(body.get("impedance")).toBe("Minutes");
    expect(body.get("time_impedance")).toBe("Minutes");
    expect(body.get("polygon_detail")).toBe("Standard");
    expect(body.get("context")).toBe(JSON.stringify({ outSR: { wkid: 4326 } }));
    expect(body.has("time_of_day")).toBe(false);
  });

  it("requests separate rings for a nonzero minimum", () => {
    const body = buildServiceAreaSubmitBody({ ...REQUEST, minDurationMinutes: 60 }, "secret");
    expect(body.get("break_values")).toBe("60 300");
    expect(body.get("polygon_overlap_type")).toBe("Rings");
    expect(buildServiceAreaSubmitBody({ ...REQUEST, minDurationMinutes: 0 }, "secret").get("break_values")).toBe("300");
  });

  it("retrieves only the requested band and rejects an unmatched provider result", async () => {
    const outer = [[0, 0], [0, 10], [10, 10], [10, 0], [0, 0]];
    const inner = [[2, 2], [8, 2], [8, 8], [2, 8], [2, 2]];
    const features = [
      { attributes: { FromBreak: 0, ToBreak: 60 }, geometry: { rings: [[...inner].reverse()] } },
      { attributes: { FromBreak: 60, ToBreak: 300 }, geometry: { rings: [outer, inner] } },
    ];
    const fetcher = vi.fn()
      .mockResolvedValueOnce(json({ jobStatus: "esriJobSucceeded" }))
      .mockResolvedValueOnce(json({ value: { spatialReference: { wkid: 4326 }, features } }))
      .mockResolvedValueOnce(json({ jobStatus: "esriJobSucceeded" }))
      .mockResolvedValueOnce(json({ value: { features: [features[0]] } }));
    const client = new ArcGisClient({ fetch: fetcher, clock: new TestClock(), routingApiKey: "key" });
    const band = { ...REQUEST, minDurationMinutes: 60 as const };
    const result = await client.pollServiceArea("provider-job", undefined, band);
    expect(result).toEqual({ state: "complete", geometry: { type: "Polygon", coordinates: [outer, inner] } });
    if (result.state !== "complete") throw new Error("Expected completed band");
    expect(coordinateIsInsideArea([1, 1], result.geometry)).toBe(true);
    expect(coordinateIsInsideArea([5, 5], result.geometry)).toBe(false);
    expect(coordinateIsInsideArea([15, 15], result.geometry)).toBe(false);
    await expect(client.pollServiceArea("bad-job", undefined, band)).rejects.toMatchObject({ code: "INVALID_PROVIDER_RESPONSE" });
  });

  it("normalizes suggest and resolve responses without exposing the key in output", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(json({ suggestions: [{ text: "Castle Rock State Park", magicKey: "key-1" }] }))
      .mockResolvedValueOnce(json({ candidates: [{
        address: "Castle Rock State Park, California",
        location: { x: -122.13, y: 37.23 },
      }] }));
    const client = new ArcGisClient({
      fetch: fetcher,
      clock: new TestClock(),
      geocodingApiKey: "geocode-secret",
      routingApiKey: "routing-secret",
    });

    const suggestions = await client.suggest("Castle Rock");
    expect(suggestions).toEqual([{
      id: "key-1",
      label: "Castle Rock State Park",
      magicKey: "key-1",
    }]);
    await expect(client.resolve("Castle Rock", "key-1")).resolves.toEqual({
      lon: -122.13,
      lat: 37.23,
      label: "Castle Rock State Park, California",
    });
    expect(String(fetcher.mock.calls[0][0])).toContain("token=geocode-secret");
    expect(JSON.stringify(suggestions)).not.toContain("geocode-secret");
  });

  it("retries transient idempotent reads with the injected clock", async () => {
    const clock = new TestClock();
    const fetcher = vi.fn()
      .mockResolvedValueOnce(json({}, 503))
      .mockResolvedValueOnce(json({ suggestions: [] }));
    const client = new ArcGisClient({ fetch: fetcher, clock, geocodingApiKey: "key" });

    await expect(client.suggest("trailhead")).resolves.toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(clock.sleeps).toEqual([100]);
  });

  it("does not retry a service-area submission that might have succeeded upstream", async () => {
    const clock = new TestClock();
    const fetcher = vi.fn().mockResolvedValue(json({}, 503));
    const client = new ArcGisClient({ fetch: fetcher, clock, routingApiKey: "key" });

    await expect(client.submitServiceArea(REQUEST)).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
      retryable: true,
    });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(clock.sleeps).toEqual([]);
  });

  it("polls pending jobs and retrieves successful normalized geometry", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(json({ jobStatus: "esriJobExecuting" }))
      .mockResolvedValueOnce(json({ jobStatus: "esriJobSucceeded" }))
      .mockResolvedValueOnce(json({ value: {
        spatialReference: { latestWkid: 4326 },
        features: [{ geometry: { rings: [[
          [-122.2, 37.1], [-122.2, 37.2], [-122.1, 37.1], [-122.2, 37.1],
        ]] } }],
      } }));
    const client = new ArcGisClient({ fetch: fetcher, clock: new TestClock(), routingApiKey: "key" });

    await expect(client.pollServiceArea("provider-job")).resolves.toEqual({ state: "pending" });
    await expect(client.pollServiceArea("provider-job")).resolves.toMatchObject({
      state: "complete",
      geometry: { type: "Polygon" },
    });
  });

  it("maps authorization, malformed response, and cancellation to stable errors", async () => {
    const unauthorized = new ArcGisClient({
      fetch: vi.fn().mockResolvedValue(json({}, 403)),
      clock: new TestClock(),
      geocodingApiKey: "key",
    });
    await expect(unauthorized.suggest("trailhead")).rejects.toMatchObject({ code: "PROVIDER_UNAUTHORIZED" });

    const malformed = new ArcGisClient({
      fetch: vi.fn().mockResolvedValue(json({ suggestions: [{ text: "missing key" }] })),
      clock: new TestClock(),
      geocodingApiKey: "key",
    });
    await expect(malformed.suggest("trailhead")).rejects.toMatchObject({ code: "INVALID_PROVIDER_RESPONSE" });

    const controller = new AbortController();
    controller.abort();
    const neverFetch = vi.fn();
    const cancelled = new ArcGisClient({ fetch: neverFetch, clock: new TestClock(), geocodingApiKey: "key" });
    await expect(cancelled.suggest("trailhead", controller.signal)).rejects.toMatchObject({ code: "REQUEST_CANCELLED" });
    expect(neverFetch).not.toHaveBeenCalled();
  });
});
