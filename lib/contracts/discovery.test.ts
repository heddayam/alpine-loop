import { describe, expect, it } from "vitest";
import {
  namedAreaSchema,
  reachabilityRequestSchema,
  reachabilityResponseSchema,
} from "./discovery";

const square = {
  type: "Polygon" as const,
  coordinates: [[
    [-122.2, 37.1],
    [-122.1, 37.1],
    [-122.1, 37.2],
    [-122.2, 37.1],
  ]],
};

describe("discovery contracts", () => {
  it("accepts a sourced installed named area", () => {
    expect(namedAreaSchema.parse({
      id: "osm-relation-1",
      name: "Fixture Preserve",
      kind: "preserve",
      bbox: [-122.2, 37.1, -122.1, 37.2],
      sourceIds: ["fixture-osm"],
      geometry: square,
    }).name).toBe("Fixture Preserve");
  });

  it("accepts only the supported drive-time values", () => {
    const input = {
      version: 1,
      packId: "fixture",
      origin: { lon: -122.15, lat: 37.15, label: "Current location" },
      durationMinutes: 30,
    };
    expect(reachabilityRequestSchema.safeParse(input).success).toBe(true);
    expect(reachabilityRequestSchema.safeParse({ ...input, durationMinutes: 31 }).success).toBe(false);
  });

  it("requires valid closed reachability geometry", () => {
    const response = {
      status: "complete",
      requestId: "db52ceda-c6ef-47f1-9153-dba294a9eccc",
      provider: "arcgis",
      durationMinutes: 30,
      resolvedAt: "2026-08-04T00:00:00Z",
      geometry: square,
    };
    expect(reachabilityResponseSchema.safeParse(response).success).toBe(true);
    expect(reachabilityResponseSchema.safeParse({
      ...response,
      geometry: { ...square, coordinates: [[...square.coordinates[0].slice(0, -1)]] },
    }).success).toBe(false);
  });
});
