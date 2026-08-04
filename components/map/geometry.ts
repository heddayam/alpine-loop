import type { Feature, Polygon } from "geojson";
import type { Bounds } from "../builder/types";

const PRECISION = 6;

export function normalizeBounds(first: [number, number], second: [number, number]): Bounds | null {
  const west = Math.min(first[0], second[0]);
  const south = Math.min(first[1], second[1]);
  const east = Math.max(first[0], second[0]);
  const north = Math.max(first[1], second[1]);
  if (![west, south, east, north].every(Number.isFinite) || west === east || south === north) return null;
  return [west, south, east, north].map((value) => Number(value.toFixed(PRECISION))) as Bounds;
}

export function boundsPolygon(bounds: Bounds): Feature<Polygon> {
  const [west, south, east, north] = bounds;
  return {
    type: "Feature",
    properties: { role: "hard-search-boundary" },
    geometry: {
      type: "Polygon",
      coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]],
    },
  };
}
