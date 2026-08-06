import { describe, expect, it } from "vitest";
import { validateAndSortNamedAreas } from "./named-areas";
import type { NormalizedNamedArea } from "./types";

const polygon: NormalizedNamedArea["geometry"] = {
  type: "Polygon",
  coordinates: [
    [[0, 0], [6, 0], [6, 6], [0, 6], [0, 0]],
    [[2, 2], [4, 2], [4, 4], [2, 4], [2, 2]],
  ],
};

const area: NormalizedNamedArea = {
  id: "osm:relation/1",
  name: "Example Preserve",
  kind: "preserve",
  aliases: ["  example   preserve ", "Example Open Space"],
  bbox: [0, 0, 6, 6],
  geometry: polygon,
  sourceIds: ["osm"],
};

describe("named-area validation", () => {
  it("preserves multipolygon islands and sorts aliases and output deterministically", () => {
    const island: NormalizedNamedArea = {
      id: "osm:relation/2",
      name: "Two Islands",
      kind: "protected-area",
      aliases: [],
      bbox: [10, 10, 13, 13],
      geometry: {
        type: "MultiPolygon",
        coordinates: [
          [[[10, 10], [11, 10], [11, 11], [10, 11], [10, 10]]],
          [[[12, 12], [13, 12], [13, 13], [12, 13], [12, 12]]],
        ],
      },
      sourceIds: ["osm"],
    };
    const first = validateAndSortNamedAreas([island, area], new Set(["osm"]));
    const second = validateAndSortNamedAreas([area, island], new Set(["osm"]));
    expect(first).toEqual(second);
    expect(first[0]?.aliases).toEqual(["Example Open Space", "Example Preserve"]);
  });

  it("rejects duplicate IDs, duplicate geometry, invalid geometry, bbox drift, and unknown sources", () => {
    expect(() => validateAndSortNamedAreas([area, { ...area }], new Set(["osm"]))).toThrow("Duplicate named area ID");
    expect(() => validateAndSortNamedAreas([area, { ...area, id: "osm:relation/9" }], new Set(["osm"])))
      .toThrow("duplicate geometry");
    expect(() => validateAndSortNamedAreas([{
      ...area,
      geometry: { type: "Polygon", coordinates: [[[0, 0], [1, 1], [2, 2], [0, 0]]] },
      bbox: [0, 0, 2, 2],
    }], new Set(["osm"]))).toThrow("zero area");
    expect(() => validateAndSortNamedAreas([{ ...area, bbox: [0, 0, 5, 5] }], new Set(["osm"])))
      .toThrow("bbox does not match");
    expect(() => validateAndSortNamedAreas([area], new Set(["different-source"])))
      .toThrow("references unknown source osm");
  });
});
