import { describe, expect, it } from "vitest";
import { normalizeArcGisArea } from "./geometry";

describe("ArcGIS service-area geometry normalization", () => {
  it("preserves outer rings, holes, and islands as strict GeoJSON", () => {
    const outer = [[0, 0], [0, 10], [10, 10], [10, 0], [0, 0]];
    const hole = [[2, 2], [8, 2], [8, 8], [2, 8], [2, 2]];
    const island = [[20, 20], [20, 22], [22, 22], [22, 20], [20, 20]];
    expect(normalizeArcGisArea({
      spatialReference: { wkid: 4326 },
      features: [{ geometry: { rings: [outer, hole, island] } }],
    })).toEqual({
      type: "MultiPolygon",
      coordinates: [[outer, hole], [island]],
    });
  });

  it("closes valid open rings and emits Polygon for one area", () => {
    expect(normalizeArcGisArea({
      features: [{ geometry: { rings: [[[0, 0], [0, 1], [1, 0]]] } }],
    })).toEqual({
      type: "Polygon",
      coordinates: [[[0, 0], [0, 1], [1, 0], [0, 0]]],
    });
  });

  it.each([
    null,
    {},
    { spatialReference: { wkid: 3857 }, features: [{ geometry: { rings: [] } }] },
    { features: [] },
    { features: [{ geometry: { rings: [[[0, 0], [1, 1]]] } }] },
    { features: [{ geometry: { rings: [[[0, 0], [0, 1], [181, 0], [0, 0]]] } }] },
    { features: [{ geometry: { rings: [[[0, 0], [0, 1], [1, 0], [0, 0]], [[20, 20], [21, 20], [20, 21], [20, 20]]] } }] },
  ])("rejects malformed, non-WGS84, or unassignable geometry", (input) => {
    expect(normalizeArcGisArea(input)).toBeNull();
  });
});
