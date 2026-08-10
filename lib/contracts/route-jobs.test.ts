import { describe, expect, it } from "vitest";
import { createBatchRouteJobV1Schema, routeJobStatusSchema } from "./route-jobs";

const validRequest = {
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
} as const;
const regionWideRequest = {
  version: validRequest.version,
  packId: validRequest.packId,
  searchRegionId: validRequest.searchRegionId,
  criteria: validRequest.criteria,
  routesPerAccessPoint: validRequest.routesPerAccessPoint,
} as const;

describe("CreateBatchRouteJobV1", () => {
  it("accepts a complete immutable launch snapshot", () => {
    expect(createBatchRouteJobV1Schema.parse(validRequest)).toEqual(validRequest);
  });

  it("accepts a reviewed-region-wide launch without drive-time inputs", () => {
    expect(createBatchRouteJobV1Schema.parse(regionWideRequest)).toEqual(regionWideRequest);
  });

  it("requires origin and drive time to be provided together", () => {
    expect(createBatchRouteJobV1Schema.safeParse({ ...regionWideRequest, durationMinutes: validRequest.durationMinutes }).success).toBe(false);
    expect(createBatchRouteJobV1Schema.safeParse({ ...regionWideRequest, origin: validRequest.origin }).success).toBe(false);
  });

  it("fixes the per-access-point result cap at ten", () => {
    expect(createBatchRouteJobV1Schema.safeParse({ ...validRequest, routesPerAccessPoint: 3 }).success).toBe(false);
  });

  it("does not accept an explicit start, effort, or global result limit", () => {
    expect(createBatchRouteJobV1Schema.safeParse({
      ...validRequest,
      startAccessPointId: "trailhead-a",
      searchEffort: "quick",
      limit: 20,
    }).success).toBe(false);
  });

  it("requires a reviewed region", () => {
    expect(createBatchRouteJobV1Schema.safeParse({ ...validRequest, searchRegionId: "" }).success).toBe(false);
  });
});

describe("RouteJobStatus", () => {
  it.each(["queued", "resolving-drive-time", "running", "completed", "cancelled", "failed", "deleting"])(
    "accepts %s",
    (status) => expect(routeJobStatusSchema.safeParse(status).success).toBe(true),
  );
});
