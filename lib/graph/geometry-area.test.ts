import type { MultiPolygon, Polygon } from "geojson";
import { describe, expect, it } from "vitest";
import {
  areaBounds,
  coordinateIsInsideArea,
  lineIsInsideArea,
  prepareAreaGeometry,
  segmentIntersectsArea,
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

  it("detects positive-length segment contact through coverage, not a hole or corner tangent", () => {
    expect(segmentIntersectsArea([-1, 5], [11, 5], polygonWithHole)).toBe(true);
    expect(segmentIntersectsArea([4.5, 4.5], [5.5, 5.5], polygonWithHole)).toBe(false);
    expect(segmentIntersectsArea([-1, 1], [1, -1], polygonWithHole)).toBe(false);
    expect(segmentIntersectsArea([-1, 0], [5, 0], polygonWithHole)).toBe(true);
    expect(segmentIntersectsArea([1, 1], [1, 1], polygonWithHole)).toBe(false);
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

  it("computes bounds for detailed areas without spreading every coordinate onto the stack", () => {
    const coordinates = Array.from({ length: 150_000 }, (_, index) => [
      -123 + index / 150_000,
      36 + (index % 10) / 10,
    ]);
    coordinates.push(coordinates[0]!);
    const detailed: Polygon = { type: "Polygon", coordinates: [coordinates] };

    expect(areaBounds(detailed)).toEqual([-123, 36, -122.00000666666666, 36.9]);
  });

  it("keeps prepared boundaries inclusive without bridging holes, concavities or islands", () => {
    const prepared = prepareAreaGeometry(polygonWithHole);
    expect(prepared.containsPoint([4, 5])).toBe(true);
    expect(prepared.containsPoint([5, 5])).toBe(false);
    expect(prepared.containsSegment([1, 5], [9, 5])).toBe(false);
    expect(prepared.containsSegment([0, 0], [10, 0])).toBe(true);
    expect(prepared.containsSegment([1, 1], [1, 1])).toBe(true);
    expect(prepared.containsPoint([NaN, 1])).toBe(false);
    expect(prepared.containsSegment([1, 1], [Infinity, 1])).toBe(false);
    const islands: MultiPolygon = {type: "MultiPolygon", coordinates: [
      polygonWithHole.coordinates,
      [[[20, 0], [30, 0], [30, 10], [28, 10], [28, 2], [22, 2], [22, 10], [20, 10], [20, 0]]],
    ]};
    const indexed = prepareAreaGeometry(islands);
    expect(indexed.containsSegment([1, 1], [21, 1])).toBe(false);
    expect(indexed.containsSegment([21, 9], [29, 9])).toBe(false);
    expect(indexed.containsSegment([21, 1], [29, 1])).toBe(true);
  });

  it("matches one-shot predicates across detailed rings, tolerances and short or parallel segments", () => {
    let seed = 1729;
    const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
    const ring = Array.from({length: 128}, (_, i) => {
      const angle = i * 2 * Math.PI / 128;
      const radius = i % 2 ? 5 : 10;
      return [radius * Math.cos(angle), radius * Math.sin(angle)];
    });
    ring.push(ring[0]);
    // Repeated points and an unclosed ring also retain the one-shot behavior.
    const shapes: Polygon[] = [polygonWithHole, {type: "Polygon", coordinates: [ring]},
      {type: "Polygon", coordinates: [[[0, 0], [10, 0], [10, 0], [10, 10], [0, 10]]]}];
    for (const shape of shapes) for (const scale of [1, 1e-3, 1e-6]) {
      const geometry: Polygon = {type: "Polygon", coordinates: shape.coordinates.map((ring) =>
        ring.map(([x, y]) => [-121 + x * scale, 48 + y * scale]))};
      const prepared = prepareAreaGeometry(geometry);
      const points: [number, number][] = Array.from({length: 200}, () =>
        [-121 + (random() * 24 - 12) * scale, 48 + (random() * 24 - 12) * scale]);
      for (const ring of geometry.coordinates) for (const [x, y] of ring) {
        for (const offset of [0, -1e-10, 1e-10, 1e-7]) points.push([x + offset, y + offset]);
      }
      for (let i = 0; i < points.length; i++) {
        const start = points[i], end = points[(i * 31 + 17) % points.length];
        expect(prepared.containsPoint(start)).toBe(coordinateIsInsideArea(start, geometry));
        expect(prepared.containsSegment(start, end)).toBe(segmentIsInsideArea(start, end, geometry));
        const nearby: [number, number] = [start[0] + 1e-7, start[1]];
        expect(prepared.containsSegment(start, nearby)).toBe(segmentIsInsideArea(start, nearby, geometry));
      }
    }
  });

  it("prepares an independent snapshot and accepts empty areas", () => {
    const geometry = structuredClone(polygonWithHole);
    const prepared = prepareAreaGeometry(geometry);
    geometry.coordinates.length = 0;
    expect(prepared.containsPoint([1, 1])).toBe(true);
    expect(prepared.containsSegment([1, 1], [3, 1])).toBe(true);
    expect(prepareAreaGeometry(geometry).containsPoint([1, 1])).toBe(false);
    expect(prepareAreaGeometry({type: "Polygon", coordinates: [[]]}).containsSegment([0, 0], [1, 1])).toBe(false);
  });
});
