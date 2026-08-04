import assert from "node:assert/strict";
import test from "node:test";
import {
  GATE_C_REGION,
  REGION_REFRESH_CONFIG,
  regionalAgencySources,
  selectBoundedOsmElements,
} from "../scripts/trails/prepare-gate-c-region.mjs";

test("selects source snapshots entirely from immutable region configuration", () => {
  const providers = (regionId) => regionalAgencySources(regionId).map(([provider]) => provider);
  assert.deepEqual(providers("yosemite-stanislaus"), ["usgs", "usfs", "nps"]);
  assert.deepEqual(providers("bay-midpen"), ["usgs", "state-parks"]);
  assert.deepEqual(providers("bay-east"), ["usgs", "nps", "state-parks", "ebrpd"]);
  assert.deepEqual(providers("sierra-national-forest"), ["usgs", "usfs"]);
  assert.deepEqual(providers("tahoe-eldorado"), ["usgs", "usfs", "state-parks"]);
  assert.equal(GATE_C_REGION.osmPbfUrl, REGION_REFRESH_CONFIG.osmPbfUrl);
  assert.equal(GATE_C_REGION.regionId, "yosemite-stanislaus");
  assert.throws(() => regionalAgencySources("unknown"), /Unknown trail region/);
});

test("prepares a bounded OSM extract with only intersecting public-road evidence", () => {
  const node = (id, lon, lat, tags = {}) => ({ type: "node", id, lon, lat, tags });
  const elements = [
    node(1, -119.8, 37.8),
    node(2, -119.79, 37.8),
    node(3, -119.81, 37.8, { amenity: "parking", access: "public" }),
    node(4, -118, 35),
    node(5, -119.82, 37.8),
    { type: "way", id: 10, refs: [1, 2], tags: { highway: "path", name: "Bounded Trail" } },
    { type: "way", id: 20, refs: [3, 1], tags: { highway: "residential" } },
    { type: "way", id: 21, refs: [3, 5], tags: { highway: "residential" } },
    { type: "way", id: 30, refs: [2, 4], tags: { highway: "path" } },
    { type: "relation", id: 40, members: [{ type: "way", ref: 10, role: "" }],
      tags: { type: "route", route: "hiking", name: "Bounded Route" } },
  ];
  const selected = selectBoundedOsmElements(elements, [-120.1, 37.55, -119.35, 38.15]);
  assert.deepEqual(selected.filter(({ type }) => type === "way").map(({ id }) => id), ["10", "20"]);
  assert.deepEqual(selected.filter(({ type }) => type === "node").map(({ id }) => id), ["1", "2", "3"]);
  assert.deepEqual(selected.filter(({ type }) => type === "relation").map(({ id }) => id), ["40"]);
});
