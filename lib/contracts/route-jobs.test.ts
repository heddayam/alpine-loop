import { describe, expect, it } from "vitest";
import { searchAreaSchema, searchIntentSchema, searchRequestSchema } from "./search";

const criteria = {
  closedRoute: { maximumRepeatedTrailPct: 35, allowMultiCycle: true },
  distanceMiles: { min: 4, max: 8 }, includeUncertainAccess: true,
};
const area = { mode: "named-regions", regionIds: ["opaque-region"] };

describe("geographic requests", () => {
  it("requires an unambiguous area and does not silently broaden invalid choices", () => {
    expect(searchAreaSchema.safeParse({ mode: "named-regions", regionIds: [] }).success).toBe(false);
    expect(searchAreaSchema.safeParse({ ...area, bbox: [-122, 37, -121, 38] }).success).toBe(false);
    expect(searchAreaSchema.safeParse({ mode: "drawn-area", bbox: [-122, 37, -121, 38], origin: {} }).success).toBe(false);
  });
  it("keeps execution controls out of a retained intent", () => {
    expect(searchIntentSchema.parse({ area, criteria })).toEqual({ area, criteria });
    expect(searchIntentSchema.safeParse({ area, criteria, limit: 20 }).success).toBe(false);
    expect(searchRequestSchema.parse({ area, criteria }).limit).toBe(10);
    for (const limit of [0, 21]) expect(searchRequestSchema.safeParse({ area, criteria, limit }).success).toBe(false);
  });
});
