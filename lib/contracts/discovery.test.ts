import { searchAreaSchema, searchAreaSnapshotSchema } from "./search";
import { describe, expect, it } from "vitest";
import {
  namedAreaSchema,
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
      mode: "drive-time",
      regionIds: [],
      origin: { lon: -122.15, lat: 37.15, label: "Current location" },
      durationMinutes: 30,
    };
    expect(searchAreaSchema.safeParse(input).success).toBe(true);
    expect(searchAreaSchema.safeParse({ ...input, durationMinutes: 31 }).success).toBe(false);
  });

  it("requires valid closed reachability geometry", () => {
    const response = {
      label: "Drive-time area",
      filterGeometry: square,
    };
    expect(searchAreaSnapshotSchema.safeParse(response).success).toBe(true);
    expect(searchAreaSnapshotSchema.safeParse({
      ...response,
      filterGeometry: { ...square, coordinates: [[...square.coordinates[0].slice(0, -1)]] },
    }).success).toBe(false);
  });
});
