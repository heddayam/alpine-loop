import { describe, expect, it } from "vitest";
import {
  DRIVE_TIME_DURATIONS_MINUTES,
  generateClosedRoutesRequestV3Schema,
  generateClosedRoutesResponseV3Schema,
  generatedTrailSegmentSchema,
} from "./routes";

describe("drive-time durations", () => {
  it("documents the supported 5 through 300 minute values", () => {
    expect(DRIVE_TIME_DURATIONS_MINUTES[0]).toBe(5);
    expect(DRIVE_TIME_DURATIONS_MINUTES.at(-1)).toBe(300);
    expect(DRIVE_TIME_DURATIONS_MINUTES).toContain(30);
  });
});

const validV3Request = {
  version: 3 as const,
  packId: "fixture",
  accessFilter: { mode: "drawn-area" as const, bbox: [-122.2, 37.1, -122.1, 37.2] as const },
  routeFamily: "closed" as const,
  closedRoute: {
    maximumRepeatedTrailPct: 35,
    allowMultiCycle: true,
  },
  distanceMiles: { min: 2, max: 5 },
  includeUncertainAccess: true,
  searchEffort: "thorough" as const,
  limit: 10,
};

describe("GenerateClosedRoutesRequestV3", () => {
  it("accepts the closed-route defaults materialized by the client", () => {
    expect(generateClosedRoutesRequestV3Schema.parse(validV3Request)).toEqual(validV3Request);
  });

  it.each([0, 35, 100])("accepts the %i%% repetition boundary", (maximumRepeatedTrailPct) => {
    expect(generateClosedRoutesRequestV3Schema.safeParse({
      ...validV3Request,
      closedRoute: { ...validV3Request.closedRoute, maximumRepeatedTrailPct },
    }).success).toBe(true);
  });

  it.each([-1, 101, 35.5])("rejects invalid repetition %s", (maximumRepeatedTrailPct) => {
    expect(generateClosedRoutesRequestV3Schema.safeParse({
      ...validV3Request,
      closedRoute: { ...validV3Request.closedRoute, maximumRepeatedTrailPct },
    }).success).toBe(false);
  });

  it("rejects V2 route-shape and point-to-point fields", () => {
    expect(generateClosedRoutesRequestV3Schema.safeParse({
      ...validV3Request,
      routeTypes: ["loop"],
      pointToPoint: { finishMustMatchAccessFilter: true },
    }).success).toBe(false);
  });

  it.each(["quick", "thorough"])('accepts effort "%s"', (searchEffort) => {
    expect(generateClosedRoutesRequestV3Schema.safeParse({ ...validV3Request, searchEffort }).success).toBe(true);
  });

  it("accepts bounded experience-grade constraints", () => {
    expect(generateClosedRoutesRequestV3Schema.safeParse({
      ...validV3Request,
      gradeExperience: {
        maximumClimbP90Pct: 12,
        maximumSteepClimbingSharePct: 20,
        maximumSteepRunMiles: 0.5,
        maximumDescentP90Pct: 15,
      },
    }).success).toBe(true);
  });


  it("rejects a zero-cycle route response", () => {
    const response = {
      version: 3,
      requestId: "request-v3",
      pack: { id: "fixture", schemaVersion: "3", dataVersion: "fixture-v3", builtAt: "2026-08-05T00:00:00Z" },
      requested: 10,
      resolvedAccessFilter: { mode: "drawn-area", label: "Drawn area" },
      exact: [{ topology: { kind: "simple-loop", cycleCount: 0 } }],
      nearMisses: [],
      diagnostics: {},
    };
    expect(generateClosedRoutesResponseV3Schema.safeParse(response).success).toBe(false);
  });
});

describe("generated trail segments", () => {
  it("accepts explicit observations and rejects reversed distance ranges", () => {
    const segment = {
      id: "route:segment:1",
      geometry: { type: "LineString" as const, coordinates: [[-122.2, 37.2], [-122.19, 37.2]] },
      name: null,
      distanceMeters: 100,
      startDistanceMeters: 0,
      endDistanceMeters: 100,
      accessState: "unknown" as const,
      condition: { highway: "path", trailVisibility: "bad", informal: true },
      sourceFeatureId: "way/10",
      sourceIds: ["osm"],
    };
    expect(generatedTrailSegmentSchema.parse(segment)).toEqual(segment);
    expect(generatedTrailSegmentSchema.safeParse({ ...segment, endDistanceMeters: 0 }).success).toBe(false);
  });
});
