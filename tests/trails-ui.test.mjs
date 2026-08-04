import assert from "node:assert/strict";
import test from "node:test";
import {
  buildTrailAccessMarkerModels,
  formatContractValue,
  formatElevationRange,
  formatSourceDate,
  formatTrailLength,
} from "../app/trails/ui.ts";

const sourceRef = {
  provider: "nps",
  sourceId: "trail-1",
  sourceUpdatedAt: "2026-07-30T12:30:00Z",
  retrievedAt: "2026-08-03T01:02:03Z",
  sourceUrl: "https://example.test/trail-1",
};

function trail(id, name, accessPoints) {
  return {
    id,
    name,
    bounds: [-120, 37, -119, 38],
    dataConfidence: "high",
    hiking: "allowed",
    access: "public",
    status: "open",
    notices: [],
    accessPoints,
    sourceRefs: [sourceRef],
    geometryUrl: `/api/trails/fixture/${id}/geometry`,
  };
}

test("deduplicates shared access markers and highlights selected trail access", () => {
  const shared = {
    id: "access-1",
    name: "Valley trailhead",
    type: "trailhead",
    confidence: "mapped",
    longitude: -119.5,
    latitude: 37.7,
    sourceRefs: [sourceRef],
  };
  const derived = {
    ...shared,
    id: "access-2",
    name: undefined,
    type: "derived",
    confidence: "derived",
  };

  assert.deepEqual(
    buildTrailAccessMarkerModels([
      trail("trail-a", "Trail A", [shared]),
      trail("trail-b", "Trail B", [shared, derived]),
    ], "trail-b"),
    [
      {
        ...shared,
        trailIds: ["trail-a", "trail-b"],
        trailNames: ["Trail A", "Trail B"],
        selected: true,
      },
      {
        ...derived,
        trailIds: ["trail-b"],
        trailNames: ["Trail B"],
        selected: true,
      },
    ],
  );
});

test("formats only API-backed distance, elevation, enum, and source date values", () => {
  assert.equal(formatTrailLength(), "Unavailable");
  assert.equal(formatTrailLength(750), "750 m");
  assert.equal(formatTrailLength(3218.688), "2.0 mi");
  assert.equal(formatElevationRange(), "Unavailable");
  assert.equal(formatElevationRange({ minMeters: 1234.4, maxMeters: 2987.6 }), "1,234–2,988 m");
  assert.equal(formatContractValue("unknown"), "Unknown");
  assert.equal(formatContractValue("derived-access"), "Derived Access");
  assert.equal(formatSourceDate("2026-07-30T12:30:00Z"), "2026-07-30");
  assert.equal(formatSourceDate("unavailable"), "unavailable");
});
