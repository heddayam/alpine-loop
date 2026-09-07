import { describe, expect, it } from "vitest";
import {
  DRIVE_TIME_DURATIONS_MINUTES,
  routeCriteriaSchema,
  closedRouteTopologyV3Schema,
  generatedTrailSegmentSchema,
} from "./routes";

describe("drive-time durations", () => {
  it("documents the supported 5 through 300 minute values", () => {
    expect(DRIVE_TIME_DURATIONS_MINUTES[0]).toBe(5);
    expect(DRIVE_TIME_DURATIONS_MINUTES.at(-1)).toBe(300);
    expect(DRIVE_TIME_DURATIONS_MINUTES).toContain(30);
  });
});

const criteria = {
  closedRoute: {
    maximumRepeatedTrailPct: 35,
    allowMultiCycle: true,
  },
  distanceMiles: { min: 2, max: 5 },
  includeUncertainAccess: true,
};

describe("route criteria", () => {
  it("accepts the closed-route defaults materialized by the client", () => {
    expect(routeCriteriaSchema.parse(criteria)).toEqual(criteria);
  });

  it.each([0, 35, 100])("accepts the %i%% repetition boundary", (maximumRepeatedTrailPct) => {
    expect(routeCriteriaSchema.safeParse({
      ...criteria,
      closedRoute: { ...criteria.closedRoute, maximumRepeatedTrailPct },
    }).success).toBe(true);
  });

  it.each([-1, 101, 35.5])("rejects invalid repetition %s", (maximumRepeatedTrailPct) => {
    expect(routeCriteriaSchema.safeParse({
      ...criteria,
      closedRoute: { ...criteria.closedRoute, maximumRepeatedTrailPct },
    }).success).toBe(false);
  });

  it("rejects V2 route-shape and point-to-point fields", () => {
    expect(routeCriteriaSchema.safeParse({
      ...criteria,
      routeTypes: ["loop"],
      pointToPoint: { finishMustMatchAccessFilter: true },
    }).success).toBe(false);
  });

  it("accepts bounded experience-grade constraints", () => {
    expect(routeCriteriaSchema.safeParse({
      ...criteria,
      gradeExperience: {
        maximumClimbP90Pct: 12,
        maximumSteepClimbingSharePct: 20,
        maximumSteepRunMiles: 0.5,
        maximumDescentP90Pct: 15,
      },
    }).success).toBe(true);
  });


  it("rejects a zero-cycle route response", () => {
    const topology = { kind: "simple-loop", cycleCount: 1, cycleBlockCount: 1, repeatedTrailDistanceMeters: 0, repeatedTrailFraction: 0, sharedStemDistanceMeters: 0, connectorCount: 0 };
    expect(closedRouteTopologyV3Schema.safeParse(topology).success).toBe(true);
    expect(closedRouteTopologyV3Schema.safeParse({ ...topology, cycleCount: 0 }).success).toBe(false);
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
