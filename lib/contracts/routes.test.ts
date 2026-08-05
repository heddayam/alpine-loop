import { describe, expect, it } from "vitest";
import {
  DRIVE_TIME_DURATIONS_MINUTES,
  generateRoutesRequestV1Schema,
  generateRoutesRequestV2Schema,
  generateClosedRoutesRequestV3Schema,
  generateClosedRoutesResponseV3Schema,
  generateRoutesResponseV1Schema,
} from "./routes";

const validRequest = {
  version: 1 as const,
  packId: "fixture",
  bbox: [-122.2, 37.1, -122.1, 37.2] as const,
  routeTypes: ["loop" as const],
  distanceMiles: { min: 2, max: 5 },
  includeUncertainAccess: false,
  limit: 10,
};

describe("GenerateRoutesRequestV1", () => {
  it("accepts the versioned public boundary", () => {
    expect(generateRoutesRequestV1Schema.parse(validRequest).limit).toBe(10);
  });

  it.each([
    { ...validRequest, bbox: [-122.1, 37.1, -122.2, 37.2] },
    { ...validRequest, distanceMiles: { min: 6, max: 5 } },
    { ...validRequest, routeTypes: [] },
    { ...validRequest, limit: 21 },
    { ...validRequest, limit: 1.5 },
  ])("rejects invalid boundaries %#", (value) => {
    expect(generateRoutesRequestV1Schema.safeParse(value).success).toBe(false);
  });

  it("requires explicit access policy and result limit", () => {
    const incomplete: Record<string, unknown> = { ...validRequest };
    delete incomplete.includeUncertainAccess;
    delete incomplete.limit;
    expect(generateRoutesRequestV1Schema.safeParse(incomplete).success).toBe(false);
  });
});

describe("GenerateRoutesResponseV1", () => {
  it("limits near misses to three", () => {
    const response = {
      version: 1,
      requestId: "request-1",
      pack: { id: "fixture", schemaVersion: "1", dataVersion: "test", builtAt: "2026-08-04T00:00:00Z" },
      requested: 10,
      exact: [],
      nearMisses: [{}, {}, {}, {}],
      diagnostics: { elapsedMs: 1, expandedStates: 0, candidateCount: 0, exhausted: false, truncationReasons: [] },
    };
    expect(generateRoutesResponseV1Schema.safeParse(response).success).toBe(false);
  });
});

const validV2Request = {
  version: 2 as const,
  packId: "fixture",
  accessFilter: { mode: "drawn-area" as const, bbox: [-122.2, 37.1, -122.1, 37.2] as const },
  routeTypes: ["loop" as const],
  pointToPoint: { finishMustMatchAccessFilter: true },
  distanceMiles: { min: 2, max: 5 },
  includeUncertainAccess: true,
  limit: 10,
};

describe("GenerateRoutesRequestV2", () => {
  it("accepts all three access-filter modes", () => {
    expect(generateRoutesRequestV2Schema.parse(validV2Request).version).toBe(2);
    expect(generateRoutesRequestV2Schema.safeParse({
      ...validV2Request,
      accessFilter: { mode: "named-region", regionId: "osm-relation-1" },
    }).success).toBe(true);
    expect(generateRoutesRequestV2Schema.safeParse({
      ...validV2Request,
      accessFilter: {
        mode: "drive-time",
        reachabilityId: "db52ceda-c6ef-47f1-9153-dba294a9eccc",
        regionId: "osm-relation-1",
      },
    }).success).toBe(true);
  });

  it("enforces the 30-mile route cap and rejects V1 fields", () => {
    expect(generateRoutesRequestV2Schema.safeParse({
      ...validV2Request,
      distanceMiles: { min: 1, max: 30.01 },
    }).success).toBe(false);
    expect(generateRoutesRequestV2Schema.safeParse({ ...validV2Request, bbox: validRequest.bbox }).success).toBe(false);
  });

  it("documents the supported 5 through 300 minute drive values", () => {
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
