import polygonClipping from "polygon-clipping";
import { createHash } from "node:crypto";
import type { CoverageUnit } from "@/lib/contracts";
import type { AreaGeometry } from "@/lib/data/area-geometry";
import { areaBounds } from "@/lib/graph/geometry";

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
/** Cell boundaries select installation work, not graph connections. Geometry suffix permits expanding a partially installed cell. */
export function installationUnits(geometry: AreaGeometry): CoverageUnit[] {
  const [west, south, east, north] = areaBounds(geometry);
  const units: CoverageUnit[] = [];
  if ((east - west) * (north - south) > 1000) throw new Error("Choose a smaller installation area (at most 1,000 square degrees per request)");
  for (let y = Math.floor((south + 90) * 4); y < Math.ceil((north + 90) * 4); y++) {
    for (let x = Math.floor((west + 180) * 4); x < Math.ceil((east + 180) * 4); x++) {
      const part = intersectCoverage(geometry, rectangle([x / 4 - 180, y / 4 - 90, (x + 1) / 4 - 180, (y + 1) / 4 - 90]));
      if (part) units.push({ id: `q-${x}-${y}-${contentId(part).slice(0, 12)}`, geometry: part, status: "pending" });
    }
  }
  return units;
}
