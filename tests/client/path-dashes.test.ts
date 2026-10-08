import { expect, it } from "vitest";
import type { MultiLineString } from "geojson";
import type { Bounds, RoutePath } from "../../src/model.js";
import { dashedPaths } from "../../src/client/path-dashes.js";

const path: RoutePath = { id: "trail", routeIds: ["hike"], geometry: [[0, 0], [1, 0]] };
const bounds: Bounds = [-1, -1, 2, 1];
const lines = (data: ReturnType<typeof dashedPaths>) => (data.features[1]!.geometry as MultiLineString).coordinates;

it("anchors dashes through fractional zoom and retains the full path for gap hit testing", () => {
  const data = dashedPaths([path], 9, bounds), dashes = lines(data);
  expect(dashedPaths([path], 9.99, bounds)).toEqual(data);
  expect(data.features[0]!.geometry.coordinates).toEqual([path.geometry]);
  expect(data.features[0]!.properties).toEqual({ id: "hike", hit: true });
  // At zoom 9, one degree spans 728.18 px: short 2px marks with 5px gaps.
  expect((dashes[0]![1]![0]! - dashes[0]![0]![0]!) * (512 * 2 ** 9) / 360).toBeCloseTo(2, 7);
  expect((dashes[1]![0]![0]! - dashes[0]![1]![0]!) * (512 * 2 ** 9) / 360).toBeCloseTo(5, 7);
});

it("keeps dash phase when clipping or passing duplicate vertices and corners", () => {
  const dashes = lines(dashedPaths([path], 9, bounds));
  const clipped = lines(dashedPaths([path], 9, [0.4, -1, 0.6, 1]));
  const interior = (line: number[][]) => line[0]![0]! > 0.4 + 1e-10 && line.at(-1)![0]! < 0.6 - 1e-10;
  expect(clipped.filter(interior)).toEqual(dashes.filter(interior));
  const corner = 360 / (512 * 2 ** 9);
  const bent: RoutePath = { ...path, geometry: [[0, 0], [0, 0], [corner, 0], [corner, 0.1]] };
  const first = lines(dashedPaths([bent], 9, bounds))[0]!;
  expect(first).toHaveLength(3);
  expect(first[1]).toEqual([corner, 0]);
  expect(first[2]![0]).toBeCloseTo(corner, 10);
  expect(bent.geometry).toHaveLength(4);
});

it("bounds close-zoom work to the viewport even on a long crossing segment", () => {
  const dashes = lines(dashedPaths([path], 22, [0.5, -0.00001, 0.50001, 0.00001]));
  expect(dashes.length).toBeGreaterThan(1);
  expect(dashes.length).toBeLessThan(10);
  for (const line of dashes) for (const point of line) {
    expect(point[0]).toBeGreaterThanOrEqual(0.5 - 1e-10);
    expect(point[0]).toBeLessThanOrEqual(0.50001 + 1e-10);
  }
});
