import assert from "node:assert/strict";
import test from "node:test";
import { arcGisFeatureSetToGeoJson } from "../app/arcgis.ts";
import {
  arcGisJobState,
  buildArcGisSubmitBody,
} from "../app/api/reachability/arcgis.ts";

test("serializes a traffic-neutral outbound five-hour ArcGIS job", () => {
  const body = buildArcGisSubmitBody(
    {
      latitude: 37.7749,
      longitude: -122.4194,
      durationMinutes: 300,
      provider: "arcgis",
    },
    "secret",
  );
  const facilities = JSON.parse(body.get("facilities"));
  assert.deepEqual(facilities.features[0].geometry, { x: -122.4194, y: 37.7749 });
  assert.equal(body.get("break_values"), "300");
  assert.equal(body.get("travel_direction"), "Away from Facility");
  assert.equal(body.get("polygon_detail"), "Standard");
  assert.equal(body.has("time_of_day"), false);
});

test("maps ArcGIS job statuses", () => {
  assert.equal(arcGisJobState("esriJobExecuting"), "pending");
  assert.equal(arcGisJobState("esriJobSucceeded"), "complete");
  assert.equal(arcGisJobState("esriJobFailed"), "failed");
  assert.equal(arcGisJobState("esriJobCancelled"), "failed");
});

test("converts ArcGIS outer rings, holes, and islands to GeoJSON", () => {
  const outer = [[0, 0], [0, 10], [10, 10], [10, 0], [0, 0]];
  const hole = [[2, 2], [8, 2], [8, 8], [2, 8], [2, 2]];
  const island = [[20, 20], [20, 22], [22, 22], [22, 20], [20, 20]];
  const result = arcGisFeatureSetToGeoJson({
    features: [{ geometry: { rings: [outer, hole, island] } }],
  });
  assert.equal(result.geometry.type, "MultiPolygon");
  assert.equal(result.geometry.coordinates.length, 2);
  assert.equal(result.geometry.coordinates[0].length, 2);
});

test("rejects empty and malformed ArcGIS geometry", () => {
  assert.equal(arcGisFeatureSetToGeoJson({}), null);
  assert.equal(
    arcGisFeatureSetToGeoJson({ features: [{ geometry: { rings: [[[0, 0], [1, 1]]] } }] }),
    null,
  );
});
