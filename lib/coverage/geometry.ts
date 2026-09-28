import polygonClipping from "polygon-clipping";
import { createHash } from "node:crypto";
import type { AreaGeometry } from "@/lib/data/area-geometry";
import { areaBounds, coordinateIsInsideArea } from "@/lib/graph/geometry";

type Multi = Parameters<typeof polygonClipping.union>[0];
function coordinates(geometry: AreaGeometry): Multi {
  return structuredClone(geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates) as Multi;
}
function shape(value: ReturnType<typeof polygonClipping.union>): AreaGeometry | null {
  return value.length ? { type: "MultiPolygon", coordinates: value } : null;
}
export function unionCoverage(geometries: readonly AreaGeometry[]): AreaGeometry {
  if (!geometries.length) throw new Error("Coverage cannot be empty");
  return shape(polygonClipping.union(coordinates(geometries[0]!), ...geometries.slice(1).map(coordinates)))!;
}
export function intersectCoverage(a: AreaGeometry, b: AreaGeometry): AreaGeometry | null {
  return shape(polygonClipping.intersection(coordinates(a), coordinates(b)));
}
export function subtractCoverage(a: AreaGeometry, b: AreaGeometry): AreaGeometry | null {
  return shape(polygonClipping.difference(coordinates(a), coordinates(b)));
}
export function rectangle([west, south, east, north]: readonly number[]): AreaGeometry {
  return { type: "Polygon", coordinates: [[[west!, south!], [east!, south!], [east!, north!], [west!, north!], [west!, south!]]] };
}
export function contentId(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
/** Polygon contact includes shared boundaries, which have no polygon-clipping area.
 * This selects upstream providers conservatively; it never joins trail nodes.
 */
export function coverageTouches(a: AreaGeometry, b: AreaGeometry): boolean {
  const left = areaBounds(a), right = areaBounds(b);
  if (left[2] < right[0] || right[2] < left[0] || left[3] < right[1] || right[3] < left[1]) return false;
  if (intersectCoverage(a, b)) return true;
  const boundaryTouches = (from: AreaGeometry, to: AreaGeometry) => {
    const polygons = from.type === "Polygon" ? [from.coordinates] : from.coordinates;
    return polygons.some(polygon => polygon.some(ring => ring.some(point => coordinateIsInsideArea([point[0]!, point[1]!], to))));
  };
  return boundaryTouches(a, b) || boundaryTouches(b, a);
}
