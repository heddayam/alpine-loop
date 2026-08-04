const GEOJSON_GEOMETRY_TYPES = new Set([
  "Point",
  "MultiPoint",
  "LineString",
  "MultiLineString",
  "Polygon",
  "MultiPolygon",
  "GeometryCollection",
]);

type GeoJsonObject = Record<string, unknown> & { type: string };

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Google currently returns the isochrone as a raw GeoJSON MultiPolygon.
 * Google Maps' data layer only accepts Features and FeatureCollections, so
 * geometry objects need a Feature wrapper before they can be rendered.
 */
export function normalizeGeoJson(value: unknown): GeoJsonObject | null {
  if (!isObject(value) || typeof value.type !== "string") return null;

  if (value.type === "FeatureCollection") {
    return Array.isArray(value.features) ? (value as GeoJsonObject) : null;
  }

  if (value.type === "Feature") {
    return isObject(value.geometry) ? (value as GeoJsonObject) : null;
  }

  if (!GEOJSON_GEOMETRY_TYPES.has(value.type)) return null;

  return {
    type: "Feature",
    properties: {},
    geometry: value,
  };
}
