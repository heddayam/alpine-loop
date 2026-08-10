import { describe, expect, it } from "vitest";
import type { NamedArea } from "@/lib/contracts";
import { resolvedNamedRegionAccessFilter } from "./access-filter";

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
});
