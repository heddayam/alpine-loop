import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyOsmWay,
  isHikingRelevantWay,
  readOsmSnapshot,
} from "../scripts/trails/sources/osm.mjs";
import { buildOsmTopology } from "../scripts/trails/graph/topology.mjs";
import { validateTrailNode, validateTrailSegment } from "../scripts/trails/model.mjs";

const fixturePath = new URL("./fixtures/trails/osm/topology.json", import.meta.url);

test("reads an offline OSM fixture with ordered way-node and hiking-route membership", async () => {
  const snapshot = await readOsmSnapshot(fixturePath);

  assert.deepEqual(snapshot.ways.map((way) => way.id), ["100", "101"]);
  assert.deepEqual(snapshot.ways[0].nodeIds, ["1", "2", "3"]);
  assert.equal(snapshot.ways[0].surface, "fine_gravel");
  assert.equal(snapshot.ways[0].sacScale, "mountain_hiking");
  assert.equal(snapshot.ways[0].hiking, "allowed");
  assert.deepEqual(snapshot.ways[0].fieldProvenance.surface, {
    tag: "surface",
    rawValue: "Fine Gravel",
  });
  assert.equal(snapshot.ways[1].visibility, "good");
  assert.equal(snapshot.ways[1].hiking, "allowed");
  assert.deepEqual(snapshot.ways[1].hikingRouteMemberships, [{
    id: "900",
    name: "Example Falls Route",
    network: "lwn",
    ref: "EFR",
    role: "alternative",
  }]);
});

test("filters lifecycle and explicit restrictions, with an opt-in blocked policy", async () => {
  const excluded = await readOsmSnapshot(fixturePath);
  assert.deepEqual(excluded.ways.map((way) => way.id), ["100", "101"]);
  await assert.rejects(
    () => readOsmSnapshot(fixturePath, { restrictedWayPolicy: "keep" }),
    /restrictedWayPolicy/,
  );

  const marked = await readOsmSnapshot(fixturePath, { restrictedWayPolicy: "mark" });
  assert.deepEqual(marked.ways.map((way) => way.id), ["100", "101", "102", "103"]);
  assert.deepEqual(
    marked.ways.filter((way) => ["102", "103"].includes(way.id)).map((way) => way.hiking),
    ["blocked", "blocked"],
  );
  assert.equal(marked.ways.find((way) => way.id === "102").access, "private");
  assert.equal(isHikingRelevantWay({ type: "way", tags: { highway: "path", foot: "no" } }), false);
  assert.equal(isHikingRelevantWay({ type: "way", tags: { highway: "path", status: "closed" } }), false);
  assert.equal(isHikingRelevantWay({
    type: "way",
    tags: { highway: "path", status: "closed" },
  }, { restrictedWayPolicy: "mark" }), true);
  assert.deepEqual(classifyOsmWay({ highway: "path" }), {
    hiking: "unknown",
    access: "unknown",
    status: "unknown",
  });
  assert.deepEqual(classifyOsmWay({ highway: "path", status: "closed" }), {
    hiking: "blocked",
    access: "unknown",
    status: "closed",
  });
});

test("emits deterministic canonical edges and retains shared OSM nodes", async () => {
  const first = buildOsmTopology(await readOsmSnapshot(fixturePath));
  const second = buildOsmTopology(await readOsmSnapshot(fixturePath));

  assert.deepEqual(first, second);
  assert.equal(first.nodes.length, 4);
  assert.equal(first.segments.length, 3);
  first.nodes.forEach(validateTrailNode);
  first.segments.forEach(validateTrailSegment);

  const shared = first.nodes.find((node) => node.sourceNodeIds.includes("osm:2"));
  assert.equal(shared.incidentSegmentIds.length, 3);
  assert.deepEqual(first.wayMetadata.find((way) => way.wayId === "100").nodeIds, ["1", "2", "3"]);
  assert.deepEqual(first.wayMetadata.find((way) => way.wayId === "101").fieldProvenance.hiking, {
    relationIds: ["900"],
  });
  assert.deepEqual(first.issues, []);
});

test("reports incomplete extracts instead of inventing topology", () => {
  const snapshot = {
    retrievedAt: "2026-08-03T00:00:00.000Z",
    nodes: [{ id: "1", longitude: -119.6, latitude: 37.7 }],
    ways: [{
      id: "77",
      nodeIds: ["1", "2"],
      hiking: "unknown",
      access: "unknown",
      status: "unknown",
      hikingRouteMemberships: [],
    }],
  };
  const graph = buildOsmTopology(snapshot);
  assert.equal(graph.segments.length, 0);
  assert.deepEqual(graph.issues[0].missingNodeIds, ["2"]);
  assert.throws(() => buildOsmTopology(snapshot, { strict: true }), /missing OSM node/);
});
