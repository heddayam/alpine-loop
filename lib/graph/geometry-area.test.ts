import type { MultiPolygon, Polygon } from "geojson";
import { describe, expect, it } from "vitest";
import {
  coordinateIsInsideArea,
  lineIsInsideArea,
  segmentIsInsideArea,
} from "./geometry";

const polygonWithHole: Polygon = {
  type: "Polygon",
  coordinates: [
    [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]],
    [[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]],
  ],
};

describe("area geometry", () => {
  it("includes outer and hole boundaries while excluding hole interiors", () => {
    expect(coordinateIsInsideArea([0, 5], polygonWithHole)).toBe(true);
    expect(coordinateIsInsideArea([4, 5], polygonWithHole)).toBe(true);
    expect(coordinateIsInsideArea([5, 5], polygonWithHole)).toBe(false);
  });

  it("supports disjoint multipolygon islands", () => {
    const islands: MultiPolygon = {
      type: "MultiPolygon",
      coordinates: [
        [[[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]]],
        [[[8, 8], [10, 8], [10, 10], [8, 10], [8, 8]]],
      ],
    };
    expect(coordinateIsInsideArea([1, 1], islands)).toBe(true);
    expect(coordinateIsInsideArea([9, 9], islands)).toBe(true);
    expect(segmentIsInsideArea([1, 1], [9, 9], islands)).toBe(false);
  });

  it("rejects a segment that exits a concave polygon despite inside endpoints", () => {
    const concave: Polygon = {
      type: "Polygon",
      coordinates: [[
        [0, 0], [6, 0], [6, 6], [4, 6], [4, 2], [2, 2], [2, 6], [0, 6], [0, 0],
      ]],
    };
    expect(coordinateIsInsideArea([1, 5], concave)).toBe(true);
    expect(coordinateIsInsideArea([5, 5], concave)).toBe(true);
    expect(segmentIsInsideArea([1, 5], [5, 5], concave)).toBe(false);
    expect(lineIsInsideArea([[1, 1], [1, 5]], concave)).toBe(true);
  });
});
