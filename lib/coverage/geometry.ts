import polygonClipping from "polygon-clipping";
import { createHash } from "node:crypto";
import type { AreaGeometry } from "@/lib/data/area-geometry";

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
/** Overlay roundoff can leave sub-millimetre residues in otherwise contained polygons.
 * Bound the total omitted area, including holes; never substitute bbox/vertex checks.
 * 1e-14 square degrees is at most 0.000124 m², below input geometry precision.
 * https://locationtech.github.io/jts/jts-faq.html#D7
 */
export function containsCoverage(outer: AreaGeometry, inner: AreaGeometry): boolean {
  const missing = subtractCoverage(inner, outer);
  if (!missing) return true;
  const polygons = missing.type === "Polygon" ? [missing.coordinates] : missing.coordinates;
  const area = polygons.reduce((total, polygon) => total + polygon.reduce((sum, ring, index) => {
    const [x, y] = ring[0]!;
    let signed = 0;
    for (let i = 1; i < ring.length; i++) signed += (ring[i-1]![0]-x)*(ring[i]![1]-y) - (ring[i]![0]-x)*(ring[i-1]![1]-y);
    return sum + (index === 0 ? 1 : -1) * Math.abs(signed / 2);
  }, 0), 0);
  return area <= 1e-14;
}
export function rectangle([west, south, east, north]: readonly number[]): AreaGeometry {
  return { type: "Polygon", coordinates: [[[west!, south!], [east!, south!], [east!, north!], [west!, north!], [west!, south!]]] };
}
export function contentId(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
