import assert from "node:assert/strict";
import test from "node:test";
import {
  createDisplayGeometry,
  lineStringBounds,
  lineStringEndpoints,
  orientLineString,
  reverseLineString,
  validateCoordinate,
} from "../scripts/trails/spatial/geometry.mjs";
import {
  geodesicDistanceMeters,
  geodesicLineLengthMeters,
} from "../scripts/trails/spatial/length.mjs";
import {
  findSnapCandidate,
  snapLineStringEndpoints,
} from "../scripts/trails/spatial/snap.mjs";

const californiaPair = [
  [-119.538329, 37.865101], // Yosemite Valley Visitor Center
  [-119.573425, 37.745919], // Glacier Point
];

test("calculates WGS84 distance for known California coordinates", () => {
  const distance = geodesicDistanceMeters(...californiaPair);
  assert.ok(distance > 13_580 && distance < 13_590, `distance was ${distance}`);

  const line = {
    type: "LineString",
    coordinates: [californiaPair[0], [-119.55, 37.81], californiaPair[1]],
  };
  const expected = geodesicDistanceMeters(line.coordinates[0], line.coordinates[1]) +
    geodesicDistanceMeters(line.coordinates[1], line.coordinates[2]);
  assert.equal(geodesicLineLengthMeters(line), expected);
  assert.equal(geodesicLineLengthMeters(reverseLineString(line)), expected);
});

test("validates coordinates and calculates bounds and endpoints", () => {
  const geometry = {
    type: "LineString",
    coordinates: [[-119.7, 37.7, 1_200], [-119.5, 37.9, 1_300], [-119.6, 37.8, 1_250]],
  };
  assert.deepEqual(lineStringBounds(geometry), [-119.7, 37.7, -119.5, 37.9]);
  assert.deepEqual(lineStringEndpoints(geometry), {
    start: [-119.7, 37.7, 1_200],
    end: [-119.6, 37.8, 1_250],
  });
  assert.throws(() => validateCoordinate([-181, 37]), /at least -180/);
  assert.throws(() => lineStringBounds({ type: "Point", coordinates: [-119, 37] }), /LineString/);
});

test("orients and reverses LineStrings without mutating them", () => {
  const geometry = {
    type: "LineString",
    coordinates: [[-119.5, 37.9], [-119.6, 37.8], [-119.7, 37.7]],
  };
  const before = JSON.stringify(geometry);
  assert.deepEqual(orientLineString(geometry).coordinates, [...geometry.coordinates].reverse());
  assert.deepEqual(
    orientLineString(geometry, [-119.49, 37.91]).coordinates,
    geometry.coordinates,
  );
  assert.equal(JSON.stringify(geometry), before);
});

test("simplifies display geometry without changing routing geometry", () => {
  const routingGeometry = {
    type: "LineString",
    coordinates: [
      [-119.6, 37.8, 1_000],
      [-119.5999, 37.800001, 1_001],
      [-119.5998, 37.8, 1_002],
      [-119.5997, 37.801, 1_100],
    ],
  };
  const before = JSON.stringify(routingGeometry);
  const displayGeometry = createDisplayGeometry(routingGeometry, 2);

  assert.equal(JSON.stringify(routingGeometry), before);
  assert.notEqual(displayGeometry, routingGeometry);
  assert.deepEqual(displayGeometry.coordinates, [
    routingGeometry.coordinates[0],
    routingGeometry.coordinates[2],
    routingGeometry.coordinates[3],
  ]);
  assert.notEqual(displayGeometry.coordinates[0], routingGeometry.coordinates[0]);
  assert.throws(() => createDisplayGeometry(routingGeometry, -1), /toleranceMeters/);
});

test("snaps only to a unique candidate within the configured tolerance", () => {
  const endpoint = [-119.6, 37.8];
  const close = { id: "node-close", coordinate: [-119.60001, 37.8] };
  const far = { id: "node-far", coordinate: [-119.601, 37.8] };

  const snapped = findSnapCandidate(endpoint, [far, close], { toleranceMeters: 2 });
  assert.equal(snapped.status, "snapped");
  assert.equal(snapped.candidateId, "node-close");
  assert.deepEqual(snapped.coordinate, close.coordinate);

  assert.deepEqual(
    findSnapCandidate(endpoint, [far], { toleranceMeters: 20 }),
    { status: "none", coordinate: endpoint },
  );
  assert.throws(() => findSnapCandidate(endpoint, [close]), /toleranceMeters/);
});

test("reports ambiguous snap candidates in deterministic order", () => {
  const endpoint = [-119.6, 37.8];
  const candidates = [
    { id: "node-z", coordinate: [-119.60001, 37.8] },
    { id: "node-a", coordinate: [-119.59999, 37.8] },
  ];
  const first = findSnapCandidate(endpoint, candidates, { toleranceMeters: 2 });
  const second = findSnapCandidate(endpoint, [...candidates].reverse(), { toleranceMeters: 2 });

  assert.equal(first.status, "ambiguous");
  assert.deepEqual(first, second);
  assert.deepEqual(first.candidates.map(({ id }) => id), ["node-a", "node-z"]);
});

test("snaps line endpoints immutably and leaves ambiguous endpoints untouched", () => {
  const geometry = {
    type: "LineString",
    coordinates: [[-119.6, 37.8, 1_000], [-119.5, 37.9, 1_200]],
  };
  const before = JSON.stringify(geometry);
  const result = snapLineStringEndpoints(geometry, [
    { id: "start", longitude: -119.60001, latitude: 37.8 },
    { id: "end-a", longitude: -119.50001, latitude: 37.9 },
    { id: "end-b", longitude: -119.49999, latitude: 37.9 },
  ], { toleranceMeters: 2 });

  assert.equal(result.endpoints.start.status, "snapped");
  assert.equal(result.endpoints.end.status, "ambiguous");
  assert.deepEqual(result.geometry.coordinates[0], [-119.60001, 37.8, 1_000]);
  assert.deepEqual(result.geometry.coordinates[1], geometry.coordinates[1]);
  assert.deepEqual(result.ambiguities.map(({ endpoint }) => endpoint), ["end"]);
  assert.equal(JSON.stringify(geometry), before);
});
