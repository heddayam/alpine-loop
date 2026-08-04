import type { Feature, FeatureCollection, Point, Polygon } from "geojson";
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

export function boundsCorners(bounds: Bounds): FeatureCollection<Point> {
  const [west, south, east, north] = bounds;
  return {
    type: "FeatureCollection",
    features: [
      [west, south],
      [east, south],
      [east, north],
      [west, north],
    ].map((coordinates, index) => ({
      type: "Feature",
      properties: { index, role: "boundary-corner" },
      geometry: { type: "Point", coordinates },
    })),
  };
}

export function boundsDimensionsMiles(bounds: Bounds): { width: number; height: number; area: number } {
  const [west, south, east, north] = bounds;
  const middleLatitudeRadians = ((south + north) / 2) * (Math.PI / 180);
  const height = (north - south) * 69;
  const width = (east - west) * 69.172 * Math.cos(middleLatitudeRadians);
  return { width, height, area: width * height };
}

export function boundsContainBounds(outer: Bounds, inner: Bounds): boolean {
  return inner[0] >= outer[0] && inner[1] >= outer[1] && inner[2] <= outer[2] && inner[3] <= outer[3];
}
