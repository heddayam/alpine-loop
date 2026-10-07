import { describe, expect, it } from "vitest";
import type { Boundary } from "../../src/data-format.js";
import { mergedRegionBoundary } from "../../src/client/region-outline.js";

const rectangle = (left: number, right: number): Boundary => ({
  type: "MultiPolygon",
  coordinates: [[[[left, 0], [right, 0], [right, 1], [left, 1], [left, 0]]]],
});

describe("selected region outline", () => {
  it("removes a shared edge even when one side has extra vertices", () => {
    const left = rectangle(0, 1);
    left.coordinates[0]![0]!.splice(2, 0, [1, 0.5]);
    const original = structuredClone(left);
    expect(mergedRegionBoundary([left, rectangle(1, 2)]).coordinates).toEqual([
      [[[0, 0], [2, 0], [2, 1], [0, 1], [0, 0]]],
    ]);
    expect(left).toEqual(original);
  });

  it("preserves disconnected regions and holes", () => {
    const region = rectangle(0, 3);
    region.coordinates[0]!.push([[1, 0.2], [2, 0.2], [2, 0.8], [1, 0.8], [1, 0.2]]);
    const merged = mergedRegionBoundary([region, rectangle(4, 5)]);
    expect(merged.coordinates).toHaveLength(2);
    expect(merged.coordinates.map((polygon) => polygon.length).sort()).toEqual([1, 2]);
  });

  it("clears an empty selection and leaves a single region intact", () => {
    expect(mergedRegionBoundary([]).coordinates).toEqual([]);
    const region = rectangle(0, 1);
    expect(mergedRegionBoundary([region])).toBe(region);
  });
});
