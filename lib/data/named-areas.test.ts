import { describe, expect, it } from "vitest";
import { edgeInsideCoverage, pointInArea } from "./area-geometry";
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
  it("treats exterior and hole boundaries as included while excluding hole interiors", () => {
    expect(pointInArea([1, 1], polygon)).toBe(true);
    expect(pointInArea([3, 3], polygon)).toBe(false);
    expect(pointInArea([2, 3], polygon)).toBe(true);
    expect(pointInArea([0, 3], polygon)).toBe(true);
    expect(edgeInsideCoverage({ geometry: [[1, 3], [5, 3]] }, polygon)).toBe(false);
  });

  it("rejects a segment that exits and re-enters concave pack coverage", () => {
    const concave: NormalizedNamedArea["geometry"] = {
      type: "Polygon",
      coordinates: [[
        [0, 0], [6, 0], [6, 6], [4, 6], [4, 2], [2, 2], [2, 6], [0, 6], [0, 0],
      ]],
    };
    expect(pointInArea([1, 5], concave)).toBe(true);
    expect(pointInArea([5, 5], concave)).toBe(true);
    expect(edgeInsideCoverage({ geometry: [[1, 5], [5, 5]] }, concave)).toBe(false);
  });

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
    expect(pointInArea([12.5, 12.5], island.geometry)).toBe(true);
    expect(pointInArea([11.5, 11.5], island.geometry)).toBe(false);
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
