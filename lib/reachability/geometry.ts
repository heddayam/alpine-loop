import { areaGeometrySchema } from "@/lib/contracts";
import type { AreaGeometry, LinearRing, Position } from "./types";

type ArcGisFeatureSet = {
  spatialReference?: unknown;
  features?: Array<{ geometry?: { rings?: unknown } }>;
};

function isPosition(value: unknown): value is Position {
  return Array.isArray(value)
    && value.length === 2
    && typeof value[0] === "number"
    && Number.isFinite(value[0])
    && value[0] >= -180
    && value[0] <= 180
    && typeof value[1] === "number"
    && Number.isFinite(value[1])
    && value[1] >= -90
    && value[1] <= 90;
}

function normalizeRing(value: unknown): LinearRing | null {
  if (!Array.isArray(value) || value.length < 3 || !value.every(isPosition)) return null;
  const ring = value.map(([lon, lat]) => [lon, lat] as Position);
  const first = ring[0];
  const last = ring.at(-1);
  if (!last || first[0] !== last[0] || first[1] !== last[1]) ring.push([...first]);
  if (ring.length < 4 || Math.abs(signedArea(ring)) < Number.EPSILON) return null;
  return ring;
}

function signedArea(ring: LinearRing): number {
  let area = 0;
  for (let index = 0; index < ring.length - 1; index += 1) {
    area += ring[index][0] * ring[index + 1][1]
      - ring[index + 1][0] * ring[index][1];
  }
  return area / 2;
}

function pointInRing([x, y]: Position, ring: LinearRing): boolean {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
    const [xi, yi] = ring[index];
    const [xj, yj] = ring[previous];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function wkid(value: unknown): number | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const candidate = record.latestWkid ?? record.wkid;
  return typeof candidate === "number" ? candidate : undefined;
}

/** Converts an ArcGIS WGS84 feature set to strict Polygon/MultiPolygon GeoJSON. */
export function normalizeArcGisArea(value: unknown): AreaGeometry | null {
  if (!value || typeof value !== "object") return null;
  const featureSet = value as ArcGisFeatureSet;
  const spatialReference = wkid(featureSet.spatialReference);
  if (spatialReference !== undefined && spatialReference !== 4326) return null;
  if (!Array.isArray(featureSet.features) || featureSet.features.length === 0) return null;

  const polygons: LinearRing[][] = [];
  for (const feature of featureSet.features) {
    const rawRings = feature.geometry?.rings;
    if (!Array.isArray(rawRings) || rawRings.length === 0) return null;
    const rings = rawRings.map(normalizeRing);
    if (rings.some((ring) => ring === null)) return null;
    const validRings = rings as LinearRing[];

    let outers = validRings.filter((ring) => signedArea(ring) < 0);
    let holes = validRings.filter((ring) => signedArea(ring) > 0);
    if (outers.length === 0) {
      const [largest, ...remaining] = [...validRings].sort(
        (left, right) => Math.abs(signedArea(right)) - Math.abs(signedArea(left)),
      );
      outers = [largest];
      holes = remaining;
    }

    const featurePolygons = outers.map((outer) => [outer]);
    for (const hole of holes) {
      const containing = featurePolygons
        .map((polygon, index) => ({ index, area: Math.abs(signedArea(polygon[0])) }))
        .filter(({ index }) => pointInRing(hole[0], featurePolygons[index][0]))
        .sort((left, right) => left.area - right.area)[0];
      if (!containing) return null;
      featurePolygons[containing.index].push(hole);
    }
    polygons.push(...featurePolygons);
  }

  const geometry: AreaGeometry = polygons.length === 1
    ? { type: "Polygon", coordinates: polygons[0] }
    : { type: "MultiPolygon", coordinates: polygons };
  const parsed = areaGeometrySchema.safeParse(geometry);
  return parsed.success ? parsed.data : null;
}
