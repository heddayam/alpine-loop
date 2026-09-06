import { describe, expect, it } from "vitest";
import { DEFAULT_BUILDER_VALUES, type BuilderValues } from "./types";
import { parseSearchCriteria } from "./validation";

function values(overrides: Partial<BuilderValues> = {}): BuilderValues {
  return { ...DEFAULT_BUILDER_VALUES, ...overrides };
}

describe("search criteria validation", () => {
  it("parses default hiking criteria independently of a search area", () => {
    const result = parseSearchCriteria(values());
    expect(result.success).toBe(true);
    if (result.success) expect(result).toMatchObject({
      limit: 10,
      criteria: {
      closedRoute: { maximumRepeatedTrailPct: 35, allowMultiCycle: true },
      includeUncertainAccess: true,
      },
    });
  });

  it.each(["1", "20"])("accepts route count boundary %s", (limit) => {
    expect(parseSearchCriteria(values({ limit })).success).toBe(true);
  });

  it.each(["0", "21", "1.5", "NaN"])("rejects invalid route count %s", (limit) => {
    const result = parseSearchCriteria(values({ limit }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.errors).toContain("Route count must be a whole number from 1 through 20.");
  });

  it("validates repetition and optional shared-stem limits", () => {
    const repetition = parseSearchCriteria(values({ maximumRepeatedTrailPct: "101" }));
    expect(repetition.success).toBe(false);
    if (!repetition.success) expect(repetition.errors).toContain("Maximum repeated trail must be a whole percentage from 0 through 100.");

    const stem = parseSearchCriteria(values({ maximumSharedStemEnabled: true, maximumSharedStemMiles: "2.5" }));
    expect(stem.success).toBe(true);
    if (stem.success) expect(stem.criteria).toMatchObject({
      closedRoute: { maximumSharedStemMiles: 2.5 },
    });
  });

  it("enforces the 30-mile cap", () => {
    const result = parseSearchCriteria(values({ distanceMiles: { enabled: true, min: "3", max: "31" } }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.errors).toContain("Route distance may not exceed 30 miles.");
  });

});
