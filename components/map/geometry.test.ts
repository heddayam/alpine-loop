import { describe, expect, it } from "vitest";
import { boundsPolygon, normalizeBounds } from "./geometry";

describe("hard-boundary geometry", () => {
  it("normalizes a rectangle dragged in any direction", () => {
    expect(normalizeBounds([-122.13, 37.18], [-122.18, 37.15])).toEqual([-122.18, 37.15, -122.13, 37.18]);
  });

  it("rejects a zero-area or non-finite rectangle", () => {
    expect(normalizeBounds([-122.1, 37.1], [-122.1, 37.2])).toBeNull();
    expect(normalizeBounds([Number.NaN, 37.1], [-122.1, 37.2])).toBeNull();
  });

  it("creates a closed polygon used for the hard-boundary preview", () => {
    const polygon = boundsPolygon([-122.18, 37.15, -122.13, 37.18]);
    expect(polygon.properties).toEqual({ role: "hard-search-boundary" });
    expect(polygon.geometry.coordinates[0]).toEqual([
      [-122.18, 37.15], [-122.13, 37.15], [-122.13, 37.18], [-122.18, 37.18], [-122.18, 37.15],
    ]);
  });
});
