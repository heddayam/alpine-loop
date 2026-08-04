import { describe, expect, it } from "vitest";
import { generateRoutesRequestV1Schema, generateRoutesResponseV1Schema } from "./routes";

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
