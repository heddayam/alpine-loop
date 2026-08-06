import { describe, expect, it } from "vitest";
import {
  DRIVE_TIME_DURATIONS_MINUTES,
  generateClosedRoutesRequestV3Schema,
  generateClosedRoutesResponseV3Schema,
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
  accessPointRemoteness: ["remote", "rural", "populated", "unknown"] as const,
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

  it("accepts any non-empty unique access-point area selection", () => {
    expect(generateClosedRoutesRequestV3Schema.safeParse({
      ...validV3Request,
      accessPointRemoteness: ["remote"],
    }).success).toBe(true);
    expect(generateClosedRoutesRequestV3Schema.safeParse({
      ...validV3Request,
      accessPointRemoteness: [],
    }).success).toBe(false);
    expect(generateClosedRoutesRequestV3Schema.safeParse({
      ...validV3Request,
      accessPointRemoteness: ["remote", "remote"],
    }).success).toBe(false);
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
