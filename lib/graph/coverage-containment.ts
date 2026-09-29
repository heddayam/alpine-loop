import polygonClipping from "polygon-clipping";
import type { AreaGeometry } from "./geometry";

/** Overlay roundoff can leave sub-millimetre residues in otherwise contained polygons.
 * Bound the total omitted area, including holes; never substitute bbox/vertex checks.
 * 1e-14 square degrees is at most 0.000124 m², below input geometry precision.
 * https://locationtech.github.io/jts/jts-faq.html#D7
 */
export function containsCoverage(outer: AreaGeometry, inner: AreaGeometry): boolean {
  const coordinates = (geometry: AreaGeometry) => structuredClone(
    geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates,
  ) as Parameters<typeof polygonClipping.difference>[0];
  const missing = polygonClipping.difference(coordinates(inner), coordinates(outer));
  const area = missing.reduce((total, polygon) => total + polygon.reduce((sum, ring, index) => {
    const [x, y] = ring[0]!;
    let signed = 0;
    for (let i = 1; i < ring.length; i++) signed += (ring[i-1]![0]-x)*(ring[i]![1]-y) - (ring[i]![0]-x)*(ring[i-1]![1]-y);
    return sum + (index === 0 ? 1 : -1) * Math.abs(signed / 2);
  }, 0), 0);
  return area <= 1e-14;
}
