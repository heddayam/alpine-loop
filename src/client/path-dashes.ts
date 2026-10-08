import type { FeatureCollection, MultiLineString } from "geojson";
import type { Bounds, RoutePath } from "../model.js";

type Point = [number, number];
const project = ([lng, lat]: Point): Point => [
  (lng + 180) / 360,
  (1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2,
];
const unproject = ([x, y]: Point): Point => [
  x * 360 - 180, Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180 / Math.PI,
];
function append(lines: Point[][], first: Point, last: Point) {
  const previous = lines.at(-1), tail = previous?.at(-1);
  if (tail && Math.abs(tail[0] - first[0]) < 1e-10 && Math.abs(tail[1] - first[1]) < 1e-10) previous!.push(last);
  else lines.push([first, last]);
}

// Cut actual geometry so dash endpoints stay on the same terrain during zoom.
// Refresh density only after a gesture, at integer zooms. Clip before cutting:
// a close view of a long trail must not generate millions of offscreen dashes.
export function dashedPaths(paths: RoutePath[], zoom: number, bounds: Bounds): FeatureCollection<MultiLineString> {
  const level = Math.floor(zoom), scale = 512 * 2 ** level;
  // Short marks at overview scale; longer dashes only when inspecting terrain.
  const dashPixels = level < 11 ? 2 : level < 13 ? 3 : 4;
  const dash = dashPixels / scale, period = (dashPixels + (level < 11 ? 5 : 8)) / scale;
  const [west, north] = project([bounds[0], bounds[3]]);
  const [east, south] = project([bounds[2], bounds[1]]);
  return {
    type: "FeatureCollection",
    features: paths.flatMap(path => {
      const lines: Point[][] = [], hits: Point[][] = [];
      let distance = 0;
      for (let i = 1; i < path.geometry.length; i++) {
        const a = project(path.geometry[i - 1]!), b = project(path.geometry[i]!);
        const dx = b[0] - a[0], dy = b[1] - a[1], length = Math.hypot(dx, dy);
        if (!length) continue;
        let from = 0, to = 1;
        for (const [origin, delta, min, max] of [[a[0], dx, west, east], [a[1], dy, north, south]] as const) {
          if (delta === 0) {
            if (origin < min || origin > max) to = -1;
          } else {
            const t1 = (min - origin) / delta, t2 = (max - origin) / delta;
            from = Math.max(from, Math.min(t1, t2));
            to = Math.min(to, Math.max(t1, t2));
          }
        }
        const point = (offset: number): Point => {
          const t = offset / length;
          return t <= 0 ? path.geometry[i - 1]! : t >= 1 ? path.geometry[i]! : unproject([a[0] + dx * t, a[1] + dy * t]);
        };
        if (from < to) {
          append(hits, point(from * length), point(to * length));
          const start = distance + from * length, end = distance + to * length;
          for (let n = Math.floor(start / period); n * period < end; n++) {
            const lo = Math.max(start, n * period), hi = Math.min(end, n * period + dash);
            if (hi <= lo) continue;
            append(lines, point(lo - distance), point(hi - distance));
          }
        }
        distance += length;
      }
      const properties = { id: path.routeIds[0] };
      if (!hits.length) return [];
      return [
        { type: "Feature" as const, properties: { ...properties, hit: true }, geometry: { type: "MultiLineString" as const, coordinates: hits } },
        { type: "Feature" as const, properties: { ...properties, hit: false }, geometry: { type: "MultiLineString" as const, coordinates: lines } },
      ];
    }),
  };
}
