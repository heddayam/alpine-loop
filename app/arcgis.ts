type Position = [number, number];
type Ring = Position[];

type ArcGisFeature = {
  attributes?: Record<string, unknown>;
  geometry?: { rings?: unknown };
};

export type ArcGisFeatureSet = { features?: ArcGisFeature[] };

function isPosition(value: unknown): value is Position {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    typeof value[0] === "number" &&
    Number.isFinite(value[0]) &&
    typeof value[1] === "number" &&
    Number.isFinite(value[1])
  );
}

function closeRing(value: unknown): Ring | null {
  if (!Array.isArray(value) || value.length < 3 || !value.every(isPosition)) return null;
  const ring = value.map(([x, y]) => [x, y] as Position);
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) ring.push([...first]);
  return ring.length >= 4 ? ring : null;
}

function signedArea(ring: Ring): number {
  let area = 0;
  for (let index = 0; index < ring.length - 1; index += 1) {
    area += ring[index][0] * ring[index + 1][1] - ring[index + 1][0] * ring[index][1];
  }
  return area / 2;
}

function pointInRing([x, y]: Position, ring: Ring): boolean {
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

export function arcGisFeatureSetToGeoJson(featureSet: ArcGisFeatureSet): object | null {
  if (!Array.isArray(featureSet.features)) return null;
  const polygons: Ring[][] = [];

  for (const feature of featureSet.features) {
    const rawRings = feature.geometry?.rings;
    if (!Array.isArray(rawRings)) continue;
    const rings = rawRings.map(closeRing).filter((ring): ring is Ring => Boolean(ring));
    if (!rings.length) continue;

    let outers = rings.filter((ring) => signedArea(ring) < 0);
    let holes = rings.filter((ring) => signedArea(ring) >= 0);
    if (!outers.length) {
      const [first, ...rest] = rings;
      outers = [first];
      holes = rest;
    }

    const featurePolygons = outers.map((outer) => [outer]);
    for (const hole of holes) {
      const containing = featurePolygons
        .map((polygon, index) => ({ index, area: Math.abs(signedArea(polygon[0])) }))
        .filter(({ index }) => pointInRing(hole[0], featurePolygons[index][0]))
        .sort((left, right) => left.area - right.area)[0];
      if (containing) featurePolygons[containing.index].push(hole);
      else featurePolygons.push([hole]);
    }
    polygons.push(...featurePolygons);
  }

  if (!polygons.length) return null;
  return {
    type: "Feature",
    properties: {},
    geometry: { type: "MultiPolygon", coordinates: polygons },
  };
}
