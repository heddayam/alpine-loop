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
    accessPointRemoteness: ["remote"],
  },
  routesPerAccessPoint: 10,
} as const;

describe("CreateBatchRouteJobV1", () => {
  it("accepts a complete immutable launch snapshot", () => {
    expect(createBatchRouteJobV1Schema.parse(validRequest)).toEqual(validRequest);
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

  it("requires a reviewed region and at least one remoteness class", () => {
    expect(createBatchRouteJobV1Schema.safeParse({ ...validRequest, searchRegionId: "" }).success).toBe(false);
    expect(createBatchRouteJobV1Schema.safeParse({
      ...validRequest,
      criteria: { ...validRequest.criteria, accessPointRemoteness: [] },
    }).success).toBe(false);
  });
});

describe("RouteJobStatus", () => {
  it.each(["queued", "resolving-drive-time", "running", "completed", "cancelled", "failed", "deleting"])(
    "accepts %s",
    (status) => expect(routeJobStatusSchema.safeParse(status).success).toBe(true),
  );
});
