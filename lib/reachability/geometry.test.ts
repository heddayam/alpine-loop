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

  it.each([
    {},
    { FromBreak: 0, ToBreak: 60 },
    { FromBreak: "30", ToBreak: 60 },
    { FromBreak: 30, ToBreak: 90 },
  ])("never substitutes another contour for a missing requested band (%j)", (attributes) => {
    expect(normalizeArcGisArea({ features: [{ attributes, geometry: {
      rings: [[[0, 0], [0, 10], [10, 0], [0, 0]]],
    } }] }, { origin: { lon: 0, lat: 0, label: "Origin" }, minDurationMinutes: 30, durationMinutes: 60 })).toBeNull();
  });

  it("rejects a malformed matching band even when a valid inner contour exists", () => {
    expect(normalizeArcGisArea({ features: [
      { attributes: { FromBreak: 0, ToBreak: 30 }, geometry: { rings: [[[0, 0], [0, 10], [10, 0], [0, 0]]] } },
      { attributes: { FromBreak: 30, ToBreak: 60 }, geometry: { rings: [] } },
    ] }, { origin: { lon: 0, lat: 0, label: "Origin" }, minDurationMinutes: 30, durationMinutes: 60 })).toBeNull();
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
