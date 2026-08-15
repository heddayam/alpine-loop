import path from "node:path";
import { describe, expect, it } from "vitest";
import type { SourceSnapshot } from "../adapters";
import { readUsgsNationalDigitalTrails } from "./usgs";

const snapshot: SourceSnapshot = {
  id: "usgs-trails",
  authority: "U.S. Geological Survey",
  dataset: "Fixture trails",
  version: "v1",
  retrievedAt: "2026-08-10T00:00:00.000Z",
  url: "https://example.test/trails.geojson",
  license: "Public domain",
  contentHash: `sha256:${"a".repeat(64)}`,
  localPath: path.resolve("lib/data/official-trails/fixtures/usgs-trails.geojson"),
};

describe("USGS National Digital Trails adapter", () => {
  it("normalizes stable provenance and conservatively gates hiking eligibility", async () => {
    const features = await readUsgsNationalDigitalTrails(snapshot);

    expect(features).toHaveLength(4);
    expect(features[0]).toMatchObject({
      externalId: "2#1",
      name: "Snow Route",
      eligible: false,
      eligibilityReason: "not-terrestrial",
      accessState: "unknown",
      sourceRefs: ["usgs-trails"],
    });
    expect(features.find(({ externalId }) => externalId === "trail-one#1")).toMatchObject({
      name: "Fixture Trail",
      trailNumber: "42",
      eligible: true,
      eligibilityReason: null,
      flags: expect.arrayContaining([
        "official-trail-feature:trail-one",
        "official-source-feature:source-1",
        "official-originator:U.S. Forest Service",
        "trail-number:42",
      ]),
    });
    expect(features.filter(({ eligibilityReason }) => eligibilityReason === "hiking-not-explicit")).toHaveLength(2);
  });
});
