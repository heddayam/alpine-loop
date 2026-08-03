import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAccessPoints,
  DEFAULT_ACCESS_POINT_OPTIONS,
} from "../scripts/trails/graph/access-points.mjs";
import { validateAccessPoint } from "../scripts/trails/model.mjs";

const retrievedAt = "2026-08-03T00:00:00.000Z";
const ref = (provider, sourceId) => ({
  provider,
  sourceId,
  retrievedAt,
  sourceUrl: `https://example.test/${provider}/${sourceId}`,
});

const nodes = [
  {
    id: "node-west",
    longitude: -119.91,
    latitude: 37.88,
    sourceNodeIds: ["osm:1"],
    incidentSegmentIds: ["segment-public"],
  },
  {
    id: "node-east",
    longitude: -119.908,
    latitude: 37.88,
    sourceNodeIds: ["osm:2"],
    incidentSegmentIds: ["segment-public", "segment-private"],
  },
  {
    id: "node-private",
    longitude: -119.906,
    latitude: 37.88,
    sourceNodeIds: ["osm:3"],
    incidentSegmentIds: ["segment-private"],
  },
];

const segments = [
  {
    id: "segment-public",
    fromNodeId: "node-west",
    toNodeId: "node-east",
    geometry: {
      type: "LineString",
      coordinates: [[-119.91, 37.88], [-119.908, 37.88]],
    },
    hiking: "allowed",
    access: "public",
    status: "open",
    lengthMeters: 176,
    sourceRefs: [ref("usfs", "trail/1")],
  },
  {
    id: "segment-private",
    fromNodeId: "node-east",
    toNodeId: "node-private",
    geometry: {
      type: "LineString",
      coordinates: [[-119.908, 37.88], [-119.906, 37.88]],
    },
    hiking: "blocked",
    access: "private",
    status: "closed",
    lengthMeters: 176,
    sourceRefs: [ref("usfs", "trail/2")],
  },
];

test("merges nearby official and OSM trailheads without losing provenance", () => {
  const input = {
    nodes,
    segments,
    candidates: [
      {
        longitude: -119.91,
        latitude: 37.88,
        name: "Meadow Trailhead",
        type: "trailhead",
        connectedNodeIds: ["node-west"],
        sourceRefs: [ref("usfs", "trailhead/7")],
      },
      {
        type: "Feature",
        geometry: { type: "Point", coordinates: [-119.9099, 37.88] },
        properties: { highway: "trailhead", name: "Meadow TH" },
        sourceRefs: [ref("osm", "node/1")],
      },
    ],
  };
  const first = buildAccessPoints(input);
  const second = buildAccessPoints({ ...input, candidates: [...input.candidates].reverse() });

  assert.deepEqual(first, second);
  assert.equal(first.accessPoints.length, 1);
  const [point] = first.accessPoints;
  validateAccessPoint(point);
  assert.equal(point.type, "trailhead");
  assert.equal(point.confidence, "official");
  assert.equal(point.name, "Meadow Trailhead");
  assert.deepEqual(point.connectedNodeIds, ["node-west"]);
  assert.deepEqual(point.sourceRefs.map(({ provider }) => provider), ["osm", "usfs"]);
  assert.deepEqual(first.issues, []);
});

test("omits explicitly private, ineligible, and disconnected candidates", () => {
  const result = buildAccessPoints({
    nodes,
    segments,
    candidates: [
      {
        longitude: -119.91,
        latitude: 37.88,
        type: "trailhead",
        confidence: "official",
        access: "private",
        sourceRefs: [ref("nps", "private/1")],
      },
      {
        longitude: -119.91,
        latitude: 37.88,
        type: "parking",
        access: "unknown",
        sourceRefs: [ref("osm", "node/parking-unknown")],
      },
      {
        longitude: -119.9,
        latitude: 37.88,
        type: "trailhead",
        confidence: "official",
        sourceRefs: [ref("usfs", "trailhead/far")],
      },
      {
        longitude: -119.906,
        latitude: 37.88,
        type: "trailhead",
        confidence: "official",
        connectedNodeIds: ["node-private"],
        sourceRefs: [ref("usfs", "trailhead/restricted")],
      },
    ],
  });

  assert.deepEqual(result.accessPoints, []);
  assert.deepEqual(result.issues.map(({ type }) => type).sort(), [
    "disconnected-candidate",
    "disconnected-candidate",
    "ineligible-candidate",
    "private-candidate",
  ]);
});

test("connects explicitly public parking only within the walking threshold", () => {
  const nearLongitude = -119.9079;
  const result = buildAccessPoints({
    nodes,
    segments,
    candidates: [
      {
        longitude: nearLongitude,
        latitude: 37.88,
        name: "Public Lot",
        type: "parking",
        access: "public",
        sourceRefs: [ref("osm", "node/parking-near")],
      },
      {
        longitude: -119.905,
        latitude: 37.88,
        name: "Too Far Lot",
        tags: { amenity: "parking", access: "public" },
        sourceRefs: [ref("osm", "node/parking-far")],
      },
    ],
  }, { walkingDistanceMeters: 50 });

  assert.equal(result.accessPoints.length, 1);
  assert.equal(result.accessPoints[0].name, "Public Lot");
  assert.equal(result.accessPoints[0].type, "parking");
  assert.equal(result.accessPoints[0].confidence, "mapped");
  assert.deepEqual(result.accessPoints[0].connectedNodeIds, ["node-east"]);
  assert.equal(result.issues[0].type, "disconnected-candidate");
});

test("derives low-confidence points only from asserted usable public-road nodes", () => {
  const result = buildAccessPoints({
    nodes,
    segments,
    candidates: [],
    publicRoadNodeIds: ["node-private", "node-west", "missing", "node-west"],
  });

  assert.equal(result.accessPoints.length, 1);
  assert.equal(result.accessPoints[0].type, "derived");
  assert.equal(result.accessPoints[0].confidence, "derived");
  assert.deepEqual(result.accessPoints[0].connectedNodeIds, ["node-west"]);
  assert.deepEqual(result.accessPoints[0].sourceRefs, [ref("usfs", "trail/1")]);
});

test("reports ambiguous graph snaps and validates distance options", () => {
  const midpoint = (-119.91 + -119.908) / 2;
  const result = buildAccessPoints({
    nodes: nodes.slice(0, 2),
    candidates: [{
      longitude: midpoint,
      latitude: 37.88,
      type: "trailhead",
      confidence: "official",
      sourceRefs: [ref("usfs", "trailhead/ambiguous")],
    }],
  }, { trailheadSnapMeters: 100 });

  assert.deepEqual(result.accessPoints, []);
  assert.equal(result.issues[0].type, "ambiguous-connection");
  assert.deepEqual(result.issues[0].nodeIds, ["node-east", "node-west"]);
  assert.throws(
    () => buildAccessPoints({ nodes, candidates: [] }, { walkingDistanceMeters: -1 }),
    /walkingDistanceMeters/,
  );
  assert.equal(DEFAULT_ACCESS_POINT_OPTIONS.walkingDistanceMeters, 200);
});
