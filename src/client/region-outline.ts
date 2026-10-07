import { union, type Geom } from "polyclip-ts";
import type { Boundary } from "../data-format.js";

/** Dissolve display boundaries without changing the prepared search sections. */
export function mergedRegionBoundary(boundaries: Boundary[]): Boundary {
  const [first, ...rest] = boundaries;
  if (!first) return { type: "MultiPolygon", coordinates: [] };
  if (!rest.length) return first;
  return {
    type: "MultiPolygon",
    coordinates: union(
      first.coordinates as Geom,
      ...rest.map((boundary) => boundary.coordinates as Geom),
    ),
  };
}
