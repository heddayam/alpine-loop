import assert from "node:assert/strict";
import test from "node:test";
import { normalizeGeoJson } from "../app/geojson.ts";

test("wraps an isochrone MultiPolygon in a GeoJSON Feature", () => {
  const geometry = {
    type: "MultiPolygon",
    coordinates: [[[[1, 2], [3, 4], [1, 2]]]],
  };

  assert.deepEqual(normalizeGeoJson(geometry), {
    type: "Feature",
    properties: {},
    geometry,
  });
});

test("preserves valid Features and FeatureCollections", () => {
  const feature = { type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [1, 2] } };
  const collection = { type: "FeatureCollection", features: [feature] };
  assert.equal(normalizeGeoJson(feature), feature);
  assert.equal(normalizeGeoJson(collection), collection);
});

test("rejects non-GeoJSON provider payloads", () => {
  assert.equal(normalizeGeoJson(undefined), null);
  assert.equal(normalizeGeoJson({ coordinates: [] }), null);
  assert.equal(normalizeGeoJson({ type: "FeatureCollection" }), null);
});
