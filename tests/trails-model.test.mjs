import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  createAccessPointId,
  createNamedTrailId,
  createNodeId,
  createSegmentId,
  createStableId,
  validateAccessPoint,
  validateNamedTrail,
  validateRecord,
  validateSourceRef,
  validateTrailNode,
  validateTrailSegment,
} from "../scripts/trails/model.mjs";
import {
  REGIONS,
  getRegion,
  requireRegion,
} from "../scripts/trails/regions.mjs";

const fixtureUrl = (name) => new URL(`./fixtures/trails/${name}.json`, import.meta.url);
const readFixture = async (name) => JSON.parse(await readFile(fixtureUrl(name), "utf8"));

const sourceRef = {
  provider: "usgs",
  sourceId: "trail/42",
  retrievedAt: "2026-08-03T00:00:00.000Z",
  sourceUrl: "https://example.gov/trails/42",
};
const geometry = {
  type: "LineString",
  coordinates: [[-119.6, 37.7], [-119.59, 37.71]],
};

test("validates every canonical record represented by offline fixtures", async () => {
  const named = await readFixture("named-trail");
  validateSourceRef(named.sourceRef);
  named.nodes.forEach((node) => validateTrailNode(node));
  validateTrailSegment(named.segment);
  validateAccessPoint(named.accessPoint);
  validateNamedTrail(named.namedTrail);

  for (const name of ["unnamed-segment", "restricted-segment"]) {
    validateTrailSegment((await readFixture(name)).segment);
  }
  validateAccessPoint((await readFixture("disconnected-access-point")).accessPoint);
  (await readFixture("conflicting-sources")).candidates.forEach(validateTrailSegment);
});

test("rejects malformed coordinates and invalid enum values", () => {
  const segment = {
    id: "segment_test",
    fromNodeId: "node_a",
    toNodeId: "node_b",
    geometry,
    hiking: "allowed",
    access: "unknown",
    status: "open",
    lengthMeters: 100,
    sourceRefs: [sourceRef],
  };

  assert.throws(
    () => validateTrailSegment({ ...segment, geometry: { ...geometry, coordinates: [[181, 0], [0, 0]] } }),
    /longitude|at most 180/,
  );
  assert.throws(
    () => validateTrailSegment({ ...segment, hiking: "sometimes" }),
    /hiking.*allowed, blocked, unknown/,
  );
  assert.throws(
    () => validateAccessPoint({
      id: "access_bad",
      longitude: -119,
      latitude: Number.NaN,
      type: "parking",
      confidence: "mapped",
      connectedNodeIds: [],
      sourceRefs: [sourceRef],
    }),
    /latitude.*finite number/,
  );
});

test("stable IDs ignore refresh metadata and line direction", () => {
  const refreshedSourceRef = {
    ...sourceRef,
    retrievedAt: "2027-01-01T00:00:00.000Z",
    sourceUrl: "https://mirror.example.gov/trails/42",
  };
  const reversedGeometry = {
    type: "LineString",
    coordinates: [...geometry.coordinates].reverse(),
  };

  const first = createSegmentId([sourceRef], geometry);
  assert.equal(first, createSegmentId([sourceRef], geometry));
  assert.equal(first, createSegmentId([refreshedSourceRef], reversedGeometry));
  assert.notEqual(first, createSegmentId([{ ...sourceRef, sourceId: "trail/43" }], geometry));
});

test("stable ID helpers normalize unordered identity fields", () => {
  const secondRef = { ...sourceRef, provider: "nps", sourceId: "yose/7" };
  assert.equal(
    createStableId("test", { sourceRefs: [sourceRef, secondRef], alpha: 1, beta: 2 }),
    createStableId("test", { beta: 2, alpha: 1, sourceRefs: [secondRef, sourceRef] }),
  );
  assert.equal(
    createNodeId({ sourceNodeIds: ["osm:2", "osm:1"], longitude: -119.6, latitude: 37.7 }),
    createNodeId({ sourceNodeIds: ["osm:1", "osm:2"], longitude: -119.6, latitude: 37.7 }),
  );
  assert.equal(
    createAccessPointId([sourceRef], { longitude: -119.6, latitude: 37.7 }),
    createAccessPointId([sourceRef], { longitude: -119.6, latitude: 37.7 }),
  );
  assert.equal(
    createNamedTrailId([sourceRef], "  Example   Trail ", ["segment_b", "segment_a"]),
    createNamedTrailId([sourceRef], "example trail", ["segment_a", "segment_b"]),
  );
});

test("provides validation dispatch and all five immutable region definitions", () => {
  assert.equal(validateRecord("SourceRef", sourceRef), sourceRef);
  assert.deepEqual(
    REGIONS.map(({ id }) => id),
    [
      "yosemite-stanislaus",
      "bay-midpen",
      "bay-east",
      "sierra-national-forest",
      "tahoe-eldorado",
    ],
  );
  assert.equal(getRegion("bay-east")?.bbox[0], -122.1);
  assert.deepEqual(
    Object.fromEntries(REGIONS.map(({ id, agencyProviders }) => [id, agencyProviders])),
    {
      "yosemite-stanislaus": ["usgs", "usfs", "nps"],
      "bay-midpen": ["usgs", "state-parks"],
      "bay-east": ["usgs", "nps", "state-parks", "ebrpd"],
      "sierra-national-forest": ["usgs", "usfs"],
      "tahoe-eldorado": ["usgs", "usfs", "state-parks"],
    },
  );
  assert.equal(requireRegion("yosemite-stanislaus"), REGIONS[0]);
  assert.equal(Object.isFrozen(REGIONS[0].bbox), true);
  assert.equal(Object.isFrozen(REGIONS[0].agencyProviders), true);
  assert.throws(() => requireRegion("missing"), /Unknown trail region/);
});
