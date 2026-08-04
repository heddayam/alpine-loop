import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_REPRESENTATIVE_ACCESS_POINTS,
  MAX_TRAIL_SEARCH_RESPONSE_BYTES,
  searchTrails,
} from "../app/trails/search.ts";
import {
  MAX_LOW_ZOOM_ACCESS_MARKERS,
  visibleTrailAccessMarkerModels,
} from "../app/trails/ui.ts";

const ACCESS_POINT_COUNT = 24_029;
const TRAIL_COUNT = 406;
const sourceRef = {
  provider: "fixture",
  sourceId: "regional-shape",
  retrievedAt: "2026-08-03T00:00:00.000Z",
  sourceUrl: "https://example.test/regional-shape",
};

function regionalShapeFixture() {
  const accessPoints = [];
  const namedTrails = [];
  const summaries = {};
  let accessIndex = 0;
  for (let trailIndex = 0; trailIndex < TRAIL_COUNT; trailIndex += 1) {
    const pointsForTrail = Math.floor(ACCESS_POINT_COUNT / TRAIL_COUNT) +
      Number(trailIndex < ACCESS_POINT_COUNT % TRAIL_COUNT);
    const accessPointIds = [];
    for (let pointIndex = 0; pointIndex < pointsForTrail; pointIndex += 1) {
      const id = `access_${accessIndex.toString(16).padStart(6, "0")}`;
      accessPointIds.push(id);
      const confidence = pointIndex === 0 ? "official" : pointIndex === 1 ? "mapped" : "derived";
      accessPoints.push({
        type: "Feature",
        id,
        geometry: {
          type: "Point",
          coordinates: [-123 + trailIndex * 0.002, 36 + pointIndex * 0.0004],
        },
        properties: {
          id,
          type: confidence === "derived" ? "derived" : "trailhead",
          confidence,
          connectedNodeIds: [`node_${accessIndex.toString(16).padStart(6, "0")}`],
          sourceRefs: [sourceRef],
        },
      });
      accessIndex += 1;
    }
    const trailId = `named-trail_${trailIndex.toString(16).padStart(4, "0")}`;
    namedTrails.push({
      id: trailId,
      name: `Regional Trail ${trailIndex.toString().padStart(3, "0")}`,
      segmentIds: [`segment_${trailIndex.toString(16).padStart(4, "0")}`],
      accessPointIds,
      bounds: [-123, 36, -122, 37],
      sourceRefs: [sourceRef],
      dataConfidence: "medium",
    });
    summaries[trailId] = {
      hiking: "allowed",
      access: "public",
      status: "open",
      routeClass: "hiking",
    };
  }
  assert.equal(accessPoints.length, ACCESS_POINT_COUNT);
  return {
    manifest: {
      schemaVersion: 2,
      generatedAt: "2026-08-03T00:00:00.000Z",
      region: { id: "regional-shape", label: "Regional shape", bounds: [-124, 35, -121, 38] },
    },
    namedTrails,
    accessPoints,
    summaries,
    shardPaths: {},
    partitionPrefixLength: 2,
  };
}

test("24,029-access regional shape stays within response and low-zoom marker budgets", (context) => {
  const catalog = regionalShapeFixture();
  const request = {
    regionId: "regional-shape",
    driveTimePolygon: {
      type: "Polygon",
      coordinates: [[[-124, 35], [-121, 35], [-121, 38], [-124, 38], [-124, 35]]],
    },
    limit: 500,
  };
  const response = searchTrails(catalog, request);
  const repeated = searchTrails({
    ...catalog,
    namedTrails: [...catalog.namedTrails].reverse(),
    accessPoints: [...catalog.accessPoints].reverse(),
  }, request);

  assert.deepEqual(repeated, response);
  assert.equal(response.count, TRAIL_COUNT);
  assert.equal(response.trails.reduce((total, trail) => total + trail.accessPointCount, 0), ACCESS_POINT_COUNT);
  assert.ok(response.trails.every(({ accessPoints }) =>
    accessPoints.length <= MAX_REPRESENTATIVE_ACCESS_POINTS));
  const responseBytes = new TextEncoder().encode(JSON.stringify(response)).byteLength;
  assert.ok(
    responseBytes <= MAX_TRAIL_SEARCH_RESPONSE_BYTES,
    `${responseBytes} response bytes exceeded ${MAX_TRAIL_SEARCH_RESPONSE_BYTES}`,
  );
  context.diagnostic(`regional search response: ${responseBytes} bytes`);

  const markers = visibleTrailAccessMarkerModels(response.trails, response.trails.at(-1).id, 9);
  assert.equal(markers.length, MAX_LOW_ZOOM_ACCESS_MARKERS);
  assert.equal(markers[0].selected, true);
  context.diagnostic(`low-zoom markers: ${markers.length}`);
});
