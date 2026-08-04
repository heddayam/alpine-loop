import type { GenerateRoutesRequestV1, GenerateRoutesResponseV1 } from "@/lib/contracts";

type Bounds = GenerateRoutesRequestV1["bbox"];

export const FIXTURE_PACK_METADATA = {
  id: "fixture-pack",
  schemaVersion: "1",
  dataVersion: "fixture-v1",
  builtAt: "2026-08-04T00:00:00Z",
} satisfies GenerateRoutesResponseV1["pack"];

export const FIXTURE_PACK_COVERAGE: Bounds = [-122.19, 37.15, -122.13, 37.18];

// Inset from the pack edge so a first-time local demo reliably contains the
// committed fixture graph and remains comfortably within the area budget.
export const FIXTURE_PACK_DEMO_BOUNDS: Bounds = [-122.18, 37.155, -122.14, 37.178];

export const FIXTURE_PACK_MAXIMUM_AREA_SQUARE_KILOMETERS = 25;
