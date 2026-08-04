import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_TRAIL_SEARCH_REQUEST_BYTES,
  MAX_TRAIL_SEARCH_VERTICES,
  loadTrailSegments,
  normalizeDriveTimeGeometry,
  parseTrailSearchRequest,
  pointInDriveTimeGeometry,
  searchTrails,
  trailGeometryFeatureCollection,
} from "../app/trails/search.ts";

const sourceRef = {
  provider: "fixture",
  sourceId: "1",
  retrievedAt: "2026-08-03T00:00:00.000Z",
  sourceUrl: "https://example.test/source",
};

function accessPoint(id, longitude, latitude, confidence = "mapped") {
  return {
    type: "Feature",
    id,
    geometry: { type: "Point", coordinates: [longitude, latitude] },
    properties: {
      id,
      type: confidence === "derived" ? "derived" : "trailhead",
      confidence,
      connectedNodeIds: [`node-${id}`],
      sourceRefs: [sourceRef],
    },
  };
}

function trail(id, name, accessPointIds, segmentIds = [`segment_${id.at(-1)}000`]) {
  return {
    id,
    name,
    accessPointIds,
    segmentIds,
    bounds: [0, 0, 2, 2],
    lengthMeters: 1200,
    sourceRefs: [sourceRef],
    dataConfidence: "medium",
  };
}

function summary(overrides = {}) {
  return {
    hiking: "allowed",
    access: "public",
    status: "open",
    routeClass: "hiking",
    elevation: { minMeters: 100, maxMeters: 250 },
    ...overrides,
  };
}

const driveTimePolygon = {
  type: "Polygon",
  coordinates: [[[-1, -1], [3, -1], [3, 3], [-1, 3], [-1, -1]]],
};

function fixtureCatalog() {
  const namedTrails = [
    trail("named-trail_a", "Inside Trail", ["inside"]),
    trail("named-trail_b", "Line-only Intersection", ["outside"]),
    trail("named-trail_c", "Unknown Trail", ["derived"]),
    trail("named-trail_d", "Closed Trail", ["inside"]),
    trail("named-trail_e", "Climbing Approach", ["inside"]),
    trail("named-trail_f", "Suppressed Trail", ["inside"]),
  ];
  return {
    manifest: {
      schemaVersion: 1,
      generatedAt: "2026-08-03T00:00:00.000Z",
      region: { id: "fixture-region", label: "Fixture", bounds: [-2, -2, 5, 5] },
    },
    namedTrails,
    accessPoints: [
      accessPoint("inside", 1, 1),
      accessPoint("outside", 4, 4),
      accessPoint("derived", 2, 2, "derived"),
    ],
    summaries: {
      "named-trail_a": summary(),
      "named-trail_b": summary(),
      "named-trail_c": summary({ hiking: "unknown", access: "unknown" }),
      "named-trail_d": summary({ status: "closed" }),
      "named-trail_e": summary({ routeClass: "advanced-climbing" }),
      "named-trail_f": summary({ suppressed: true }),
    },
    shardPaths: { a: "segments/a.ndjson", b: "segments/b.ndjson" },
    partitionPrefixLength: 1,
  };
}

test("normalizes Polygon, MultiPolygon, Feature, and FeatureCollection inputs", () => {
  assert.deepEqual(normalizeDriveTimeGeometry({ type: "Feature", geometry: driveTimePolygon }), driveTimePolygon);
  const collection = normalizeDriveTimeGeometry({
    type: "FeatureCollection",
    features: [
      { type: "Feature", geometry: driveTimePolygon },
      { type: "Feature", geometry: { ...driveTimePolygon, coordinates: [[[9, 9], [10, 9], [10, 10], [9, 10], [9, 9]]] } },
    ],
  });
  assert.equal(collection.type, "MultiPolygon");
  assert.equal(collection.coordinates.length, 2);
  assert.equal(normalizeDriveTimeGeometry({ type: "LineString", coordinates: [] }), null);
});

test("uses boundary-inclusive point-in-polygon behavior while respecting holes", () => {
  const withHole = {
    type: "Polygon",
    coordinates: [
      [[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]],
      [[1, 1], [3, 1], [3, 3], [1, 3], [1, 1]],
    ],
  };
  assert.equal(pointInDriveTimeGeometry([0, 2], withHole), true);
  assert.equal(pointInDriveTimeGeometry([2, 2], withHole), false);
  assert.equal(pointInDriveTimeGeometry([1, 2], withHole), true);
  assert.equal(pointInDriveTimeGeometry([5, 2], withHole), false);
});

test("validates bounded trail search requests", () => {
  assert.deepEqual(parseTrailSearchRequest({ regionId: "fixture-region", geoJson: driveTimePolygon }), {
    ok: true,
    request: {
      regionId: "fixture-region",
      driveTimePolygon,
      limit: 500,
    },
  });
  assert.equal(parseTrailSearchRequest({ regionId: "../bad", geoJson: driveTimePolygon }).ok, false);
  assert.equal(parseTrailSearchRequest({ regionId: "fixture-region", geoJson: driveTimePolygon, limit: 501 }).ok, false);
  assert.equal(parseTrailSearchRequest({ regionId: "fixture-region", geoJson: { type: "Polygon", coordinates: [] } }).ok, false);
});

test("allows production-scale long-range contours within the vertex safety cap", () => {
  const coordinates = Array.from({ length: 87_159 }, (_, index) => {
    const angle = (index / 87_158) * Math.PI * 2;
    return [-119.5 + Math.cos(angle), 37.5 + Math.sin(angle)];
  });
  coordinates[coordinates.length - 1] = coordinates[0];
  const payload = {
    regionId: "fixture-region",
    driveTimePolygon: { type: "Polygon", coordinates: [coordinates] },
  };

  assert.ok(Buffer.byteLength(JSON.stringify(payload)) > 512 * 1024);
  assert.equal(MAX_TRAIL_SEARCH_REQUEST_BYTES, 8 * 1024 * 1024);
  assert.equal(MAX_TRAIL_SEARCH_VERTICES, 200_000);
  assert.equal(parseTrailSearchRequest(payload).ok, true);
});

test("rejects drive-time geometry beyond the bounded vertex ceiling", () => {
  const coordinates = Array.from({ length: MAX_TRAIL_SEARCH_VERTICES + 1 }, () => [0, 0]);
  assert.equal(normalizeDriveTimeGeometry({
    type: "Polygon",
    coordinates: [coordinates],
  }), null);
});

test("requires a reachable access point and applies conservative default hiking policy", () => {
  const response = searchTrails(fixtureCatalog(), {
    regionId: "fixture-region",
    driveTimePolygon,
    limit: 500,
  });
  assert.equal(response.count, 2);
  assert.deepEqual(response.trails.map(({ name }) => name), ["Inside Trail", "Unknown Trail"]);
  assert.equal(response.trails.some((result) => "geometry" in result), false);
  assert.equal(response.trails[0].geometryUrl, "/api/trails/fixture-region/named-trail_a/geometry");
  assert.equal(response.trails[1].hiking, "unknown");
  assert.match(response.trails[1].notices.join(" "), /permission is unknown/i);
  assert.equal(response.trails[1].accessPoints[0].confidence, "derived");
});

test("supports metadata name search without changing the reachable count contract", () => {
  const response = searchTrails(fixtureCatalog(), {
    regionId: "fixture-region",
    driveTimePolygon,
    query: "unknown",
    limit: 1,
  });
  assert.equal(response.count, 1);
  assert.equal(response.trails[0].name, "Unknown Trail");
});

test("loads only selected geometry shards and preserves trail segment order", async () => {
  const catalog = fixtureCatalog();
  catalog.namedTrails[0].segmentIds = ["segment_a001", "segment_b001", "segment_a002"];
  const calls = [];
  const segments = await loadTrailSegments(catalog, "named-trail_a", async (shard, ids) => {
    calls.push([shard, [...ids].sort()]);
    return [...ids].reverse().map((id) => ({
      id,
      fromNodeId: "node-a",
      toNodeId: "node-b",
      geometry: { type: "LineString", coordinates: [[0, 0], [1, 1]] },
      hiking: "allowed",
      access: "public",
      status: "open",
      lengthMeters: 100,
      maxGradePct: 240,
      sourceRefs: [sourceRef],
    }));
  });
  assert.deepEqual(calls, [
    ["a", ["segment_a001", "segment_a002"]],
    ["b", ["segment_b001"]],
  ]);
  assert.deepEqual(segments.map(({ id }) => id), ["segment_a001", "segment_b001", "segment_a002"]);
  const geoJson = trailGeometryFeatureCollection("fixture-region", catalog.namedTrails[0], segments);
  assert.equal(geoJson.type, "FeatureCollection");
  assert.equal(geoJson.features.length, 3);
  assert.equal("maxGradePct" in geoJson.features[0].properties, false);
});

test("loads v2 geometry using the catalog-declared two-character partition width", async () => {
  const catalog = fixtureCatalog();
  catalog.partitionPrefixLength = 2;
  catalog.shardPaths = { a0: "segments/a0.ndjson", a1: "segments/a1.ndjson" };
  catalog.namedTrails[0].segmentIds = ["segment_a001", "segment_a101"];
  const calls = [];
  const segments = await loadTrailSegments(catalog, "named-trail_a", async (shard, ids) => {
    calls.push([shard, [...ids]]);
    return [...ids].map((id) => ({ id }));
  });
  assert.deepEqual(calls, [
    ["a0", ["segment_a001"]],
    ["a1", ["segment_a101"]],
  ]);
  assert.deepEqual(segments.map(({ id }) => id), ["segment_a001", "segment_a101"]);
});
