import { describe, expect, it } from "vitest";
import { DEFAULT_BUILDER_VALUES, type BuilderValues } from "./types";
import { buildGenerateRoutesRequest, isBoundsInsideBounds, isPointInsideBounds } from "./validation";

const bounds = [-122.18, 37.15, -122.13, 37.18] as const;
const filter = { mode: "drawn-area" as const, bbox: [...bounds] as [number, number, number, number] };

function values(overrides: Partial<BuilderValues> = {}): BuilderValues {
  return { ...DEFAULT_BUILDER_VALUES, ...overrides };
}

describe("builder V3 request validation", () => {
  it("builds the default closed-route request", () => {
    const result = buildGenerateRoutesRequest(values(), filter);
    expect(result.success).toBe(true);
    if (result.success) expect(result.request).toMatchObject({
      version: 3,
      accessFilter: filter,
      routeFamily: "closed",
      closedRoute: { maximumRepeatedTrailPct: 35, allowMultiCycle: true },
      searchEffort: "thorough",
      limit: 10,
      includeUncertainAccess: true,
      accessPointRemoteness: ["remote", "rural", "populated", "unknown"],
    });
  });

  it.each(["1", "20"])("accepts route count boundary %s", (limit) => {
    expect(buildGenerateRoutesRequest(values({ limit }), filter).success).toBe(true);
  });

  it.each(["0", "21", "1.5", "NaN"])("rejects invalid route count %s", (limit) => {
    const result = buildGenerateRoutesRequest(values({ limit }), filter);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.errors).toContain("Route count must be a whole number from 1 through 20.");
  });

  it("requires a complete filter", () => {
    expect(buildGenerateRoutesRequest(values(), null)).toEqual({
      success: false,
      errors: ["Choose and complete a trailhead filter first."],
    });
  });

  it("validates repetition and optional shared-stem limits", () => {
    const repetition = buildGenerateRoutesRequest(values({ maximumRepeatedTrailPct: "101" }), filter);
    expect(repetition.success).toBe(false);
    if (!repetition.success) expect(repetition.errors).toContain("Maximum repeated trail must be a whole percentage from 0 through 100.");

    const stem = buildGenerateRoutesRequest(values({ maximumSharedStemEnabled: true, maximumSharedStemMiles: "2.5", searchEffort: "quick" }), filter);
    expect(stem.success).toBe(true);
    if (stem.success) expect(stem.request).toMatchObject({
      closedRoute: { maximumSharedStemMiles: 2.5 },
      searchEffort: "quick",
    });
  });

  it("enforces the 30-mile cap", () => {
    const result = buildGenerateRoutesRequest(values({ distanceMiles: { enabled: true, min: "3", max: "31" } }), filter);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.errors).toContain("Route distance may not exceed 30 miles.");
  });

  it("accepts named and drive-time filters", () => {
    expect(buildGenerateRoutesRequest(values(), { mode: "named-region", regionId: "osm-relation-1" }).success).toBe(true);
    expect(buildGenerateRoutesRequest(values(), { mode: "drive-time", reachabilityId: "3d594650-3436-4f8b-a0e8-38d13fc148ca", regionId: "park-1" }).success).toBe(true);
  });

  it("keeps boundary-inclusive point checks while allowing filter bounds beyond coverage", () => {
    expect(isPointInsideBounds(-122.18, 37.15, [...bounds])).toBe(true);
    expect(isPointInsideBounds(-122.181, 37.16, [...bounds])).toBe(false);
    expect(isBoundsInsideBounds([-122.2, 37.15, -122.13, 37.18], [...bounds])).toBe(false);
    expect(buildGenerateRoutesRequest(values(), { mode: "drawn-area", bbox: [-122.2, 37.15, -122.13, 37.18] }).success).toBe(true);
  });
});
