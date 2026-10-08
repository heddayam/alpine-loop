import { expect, it } from "vitest";
import type { Position, RouteSegment } from "../../src/model.js";
import { routeDrawing } from "../../src/client/route-drawing.js";

const walk = (geometry: Position[], names: (string | null | undefined)[], ids = names.map((_, index) => String(index))) => ({
  id: "selected-hike", geometry,
  segments: names.map((name, index) => ({ id: ids[index]!, name, start: index, end: index + 1 })),
});

it("groups named continuations while preserving exact geometry and the original ordered profile", () => {
  const geometry: Position[] = [[0, 0, 10], [1, 0, 20], [2, 0, 30], [3, 1, 40], [4, 1, 50]];
  const segments: RouteSegment[] = [{ id: "a", name: "Trail A", start: 0, end: 2 },
    { id: "b", name: "Trail A", start: 2, end: 3 }, { id: "c", name: "Trail B", start: 3, end: 4 }];
  const route = { id: "selected-hike", geometry, segments }, before = structuredClone(route);
  const drawing = routeDrawing(route);
  expect(drawing.features).toHaveLength(2);
  expect(drawing.features[0]!.properties).toEqual({ id: route.id, name: "Trail A" });
  expect(drawing.features[0]!.geometry.coordinates).toEqual([[[0, 0], [1, 0], [2, 0]], [[2, 0], [3, 1]]]);
  expect(drawing.features[1]!.geometry.coordinates).toEqual([[[3, 1], [4, 1]]]);
  expect(drawing.features.every(feature => Number.isSafeInteger(feature.id))).toBe(true);
  expect(new Set(drawing.features.map(feature => feature.id)).size).toBe(2);
  expect(route).toEqual(before);
});

it("keeps separate same-name portions apart even when their coordinates touch", () => {
  const route = walk([[0, 0], [1, 0], [1, 1], [1, 0], [2, 0]], ["A", "B", "C", "A"]);
  const drawing = routeDrawing(route);
  expect(drawing.features).toHaveLength(4);
  expect(drawing.features.filter(feature => feature.properties!.name === "A")).toHaveLength(2);
});

it("joins the same named trail across the arbitrary starting point of a closed loop", () => {
  const route = walk([[0, 0], [1, 0], [1, 1], [0, 0]], ["A", "B", "A"]);
  const drawing = routeDrawing(route);
  expect(drawing.features).toHaveLength(2);
  expect(drawing.features[0]!.geometry.coordinates).toEqual([[[0, 0], [1, 0]], [[1, 1], [0, 0]]]);
  route.segments[1]!.name = "A";
  expect(routeDrawing(route).features).toHaveLength(1);
});

it("uses return-walk transitions to extend a group and draws each physical stem segment once", () => {
  const route = walk([[0, 0], [1, 0], [2, 0], [2, 1], [2, 0], [1, 0], [0, 0]],
    ["A", "A", "B", "A", "A", "A"], ["stem-0", "stem-1", "loop-out", "loop-back", "stem-1", "stem-0"]);
  const drawing = routeDrawing(route);
  expect(drawing.features).toHaveLength(2);
  expect(drawing.features[0]!.geometry.coordinates).toEqual([[[0, 0], [1, 0]], [[1, 0], [2, 0]], [[2, 1], [2, 0]]]);
  expect(drawing.features.flatMap(feature => feature.geometry.coordinates)).toHaveLength(4);
});

it("keeps unnamed and unavailable segments separate and compares known labels exactly", () => {
  const route = walk([[0, 0], [1, 0], [2, 0], [3, 0], [4, 0], [5, 0], [6, 0]],
    [null, undefined, "", "A", "a", "A / B"]);
  const drawing = routeDrawing(route);
  expect(drawing.features).toHaveLength(6);
  expect(drawing.features.map(feature => feature.properties!.name))
    .toEqual(["Unnamed trail", "Trail name unavailable", "Unnamed trail", "A", "a", "A / B"]);
});

it("can still draw a route whose segment metadata is unavailable", () => {
  const drawing = routeDrawing({ id: "old-hike", geometry: [[0, 0, 10], [1, 0, 20]] });
  expect(drawing.features).toHaveLength(1);
  expect(drawing.features[0]!.id).toBeUndefined();
  expect(drawing.features[0]!.geometry.coordinates).toEqual([[[0, 0], [1, 0]]]);
});
