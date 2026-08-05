import { describe, expect, it } from "vitest";
import { DEFAULT_BUILDER_VALUES, type BuilderValues } from "./types";
import { buildGenerateRoutesRequest, isBoundsInsideBounds, isPointInsideBounds } from "./validation";

const bounds = [-122.18, 37.15, -122.13, 37.18] as const;

function values(overrides: Partial<BuilderValues> = {}): BuilderValues {
  return { ...DEFAULT_BUILDER_VALUES, ...overrides };
}

describe("builder request validation", () => {
  it("defaults to 10 routes and includes uncertain access", () => {
    const result = buildGenerateRoutesRequest(values(), [...bounds]);
    expect(result).toEqual(expect.objectContaining({ success: true }));
    if (result.success) {
      expect(result.request.limit).toBe(10);
      expect(result.request.includeUncertainAccess).toBe(true);
      expect(result.request).not.toHaveProperty("elevationGainFeet");
    }
  });

  it.each(["1", "20"])("accepts route count boundary %s", (limit) => {
    expect(buildGenerateRoutesRequest(values({ limit }), [...bounds]).success).toBe(true);
  });

  it.each(["0", "21", "1.5", "NaN"])("rejects invalid route count %s", (limit) => {
    const result = buildGenerateRoutesRequest(values({ limit }), [...bounds]);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.errors).toContain("Route count must be a whole number from 1 through 20.");
  });

  it("requires a rectangle and at least one route shape", () => {
    const result = buildGenerateRoutesRequest(values({ routeTypes: [] }), null);
    expect(result).toEqual({
      success: false,
      errors: ["Draw a search rectangle on the map first.", "Choose at least one route shape."],
    });
  });

  it("rejects reversed, negative, and non-finite ranges", () => {
    const result = buildGenerateRoutesRequest(values({
      distanceMiles: { enabled: true, min: "8", max: "3" },
      elevationGainFeet: { enabled: true, min: "-1", max: "100" },
      maximumElevationFeet: { enabled: true, min: "one", max: "200" },
    }), [...bounds]);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors).toEqual(expect.arrayContaining([
        "Distance minimum must not exceed its maximum.",
        "Elevation gain cannot be negative.",
        "Maximum elevation must use finite numbers.",
      ]));
    }
  });

  it("only treats points on or within the hard boundary as inside", () => {
    expect(isPointInsideBounds(-122.18, 37.15, [...bounds])).toBe(true);
    expect(isPointInsideBounds(-122.13, 37.18, [...bounds])).toBe(true);
    expect(isPointInsideBounds(-122.181, 37.16, [...bounds])).toBe(false);
  });

  it("rejects a rectangle that leaves installed pack coverage", () => {
    const outside = [-122.2, 37.15, -122.13, 37.18] as const;
    expect(isBoundsInsideBounds([...outside], [...bounds])).toBe(false);
    const result = buildGenerateRoutesRequest(values(), [...outside]);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors).toContain("Keep the search rectangle inside the shaded installed-pack coverage.");
    }
  });
});
