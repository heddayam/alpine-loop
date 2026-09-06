import { describe, expect, it } from "vitest";
import type { NamedArea } from "@/lib/contracts";
import { resolvedDrawnAreaAccessFilter, resolvedNamedRegionAccessFilter } from "./access-filter";

const coverage = {
  type: "Polygon" as const,
  coordinates: [[[-2, -2], [12, -2], [12, 12], [-2, 12], [-2, -2]]],
};
const region: NamedArea = {
  id: "osm:relation/42",
  name: "Fixture Region",
  kind: "preserve",
  bbox: [0, 0, 10, 10],
  sourceIds: ["osm"],
  geometry: {
    type: "Polygon",
    coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]],
  },
};

describe("resolvedNamedRegionAccessFilter", () => {
  it("uses only the reviewed named-region geometry as the access predicate", () => {
    expect(resolvedNamedRegionAccessFilter({ coverage }, region)).toEqual({
      summary: {
        mode: "named-region",
        label: "Fixture Region",
        region: { id: "osm:relation/42", name: "Fixture Region" },
      },
      predicates: [region.geometry],
      coverage,
      filterGeometry: region.geometry,
    });
  });

  it("builds an exact drawn-area access predicate without a reviewed-region refinement", () => {
    const bbox: [number, number, number, number] = [-122.4, 37.1, -122.2, 37.3];
    const geometry = {
      type: "Polygon" as const,
      coordinates: [[
        [-122.4, 37.1], [-122.2, 37.1], [-122.2, 37.3], [-122.4, 37.3], [-122.4, 37.1],
      ]],
    };

    expect(resolvedDrawnAreaAccessFilter({ coverage }, bbox)).toEqual({
      summary: { mode: "drawn-area", label: "Drawn area" },
      predicates: [geometry],
      coverage,
      filterGeometry: geometry,
    });
  });
});
