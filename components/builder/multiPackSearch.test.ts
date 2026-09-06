import { describe, expect, it } from "vitest";
import type { AreaGeometry } from "@/lib/graph";
import {
  combineAreaGeometries,
  reconcileSelectedPackIds,
  unionBounds,
} from "./multiPackSearch";

describe("multi-pack search helpers", () => {
  it("unions one or more bounds", () => {
    expect(unionBounds([[-122, 37, -121, 38], [-123, 36, -121.5, 39]])).toEqual([-123, 36, -121, 39]);
    expect(unionBounds([[-122, 37, -121, 38]])).toEqual([-122, 37, -121, 38]);
    expect(() => unionBounds([])).toThrow("At least one bounds");
  });

  it("combines polygon coordinates without replacing them with bounding boxes", () => {
    const polygon: AreaGeometry = {
      type: "Polygon",
      coordinates: [[[-123, 37], [-122.8, 37.4], [-122.6, 37], [-123, 37]]],
    };
    const multiPolygon: AreaGeometry = {
      type: "MultiPolygon",
      coordinates: [
        [[[-122, 36], [-121.8, 36.2], [-121.6, 36], [-122, 36]]],
        [[[-121.5, 35], [-121.3, 35.2], [-121.1, 35], [-121.5, 35]]],
      ],
    };

    expect(combineAreaGeometries([])).toBeUndefined();
    expect(combineAreaGeometries([polygon])).toEqual(polygon);
    expect(combineAreaGeometries([polygon, multiPolygon])).toEqual({
      type: "MultiPolygon",
      coordinates: [polygon.coordinates, ...multiPolygon.coordinates],
    });
  });

  it("reconciles URL candidates in catalog order with an available fallback", () => {
    expect(reconcileSelectedPackIds(["south", "missing", "north", "south"], ["north", "central", "south"])).toEqual(["north", "south"]);
    expect(reconcileSelectedPackIds(["missing"], ["north", "south"], "south")).toEqual(["south"]);
    expect(reconcileSelectedPackIds([], ["north", "south"], "missing")).toEqual(["north"]);
    expect(reconcileSelectedPackIds([], ["north", "south"], "north", true)).toEqual([]);
    expect(() => reconcileSelectedPackIds([], [])).toThrow("At least one available pack");
  });
});
