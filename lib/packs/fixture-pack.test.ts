import { describe, expect, it } from "vitest";
import { FIXTURE_PACK_COVERAGE, FIXTURE_PACK_TRAIL_NETWORK } from "./fixture-pack";

describe("fixture trail context", () => {
  it("renders only source-backed mapped segments, not synthetic solver scaffolding", () => {
    expect(FIXTURE_PACK_TRAIL_NETWORK.features).toHaveLength(3);
    expect(FIXTURE_PACK_TRAIL_NETWORK.features.every(({ geometry }) => geometry.coordinates.length > 2)).toBe(true);
    expect(FIXTURE_PACK_TRAIL_NETWORK.features.every(({ properties }) =>
      String(properties?.sourceId).startsWith("openstreetmap:way/"),
    )).toBe(true);
  });

  it("keeps every visible trail coordinate inside installed demo coverage", () => {
    const [west, south, east, north] = FIXTURE_PACK_COVERAGE;
    for (const feature of FIXTURE_PACK_TRAIL_NETWORK.features) {
      for (const [lon, lat] of feature.geometry.coordinates) {
        expect(lon).toBeGreaterThanOrEqual(west);
        expect(lon).toBeLessThanOrEqual(east);
        expect(lat).toBeGreaterThanOrEqual(south);
        expect(lat).toBeLessThanOrEqual(north);
      }
    }
  });
});
