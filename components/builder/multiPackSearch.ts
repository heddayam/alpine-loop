import type { AreaGeometry } from "@/lib/graph";
import type { Bounds } from "./types";

export function unionBounds(bounds: Bounds[]): Bounds {
  if (bounds.length === 0) throw new Error("At least one bounds value is required");

  return bounds.slice(1).reduce<Bounds>(
    ([west, south, east, north], [nextWest, nextSouth, nextEast, nextNorth]) => [
      Math.min(west, nextWest),
      Math.min(south, nextSouth),
      Math.max(east, nextEast),
      Math.max(north, nextNorth),
    ],
    bounds[0]!,
  );
}

export function combineAreaGeometries(geometries: AreaGeometry[]): AreaGeometry | undefined {
  if (geometries.length === 0) return undefined;

  const polygons = geometries.flatMap((geometry) =>
    geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates,
  );

  if (polygons.length === 1) return { type: "Polygon", coordinates: polygons[0]! };
  return { type: "MultiPolygon", coordinates: polygons };
}

export function reconcileSelectedPackIds(
  urlCandidates: readonly string[],
  availablePackIds: readonly string[],
  fallbackPackId?: string,
  allowEmpty = false,
): string[] {
  const orderedAvailable = [...new Set(availablePackIds)];
  if (orderedAvailable.length === 0) throw new Error("At least one available pack is required");

  const candidates = new Set(urlCandidates);
  const selected = orderedAvailable.filter((packId) => candidates.has(packId));
  if (selected.length > 0) return selected;
  if (allowEmpty) return [];
  if (fallbackPackId && orderedAvailable.includes(fallbackPackId)) return [fallbackPackId];
  return [orderedAvailable[0]!];
}
