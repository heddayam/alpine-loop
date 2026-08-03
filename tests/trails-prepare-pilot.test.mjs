import assert from "node:assert/strict";
import test from "node:test";
import {
  parseOsmXml,
  selectPilotAgencyFeatures,
  selectPilotOsmElements,
} from "../scripts/trails/prepare-gate-c-pilot.mjs";

test("prepares the bounded OSM map response without Overpass", () => {
  const xml = `<?xml version="1.0"?><osm version="0.6">
    <node id="1" lon="-119.55" lat="37.73"><tag k="information" v="trailhead"/></node>
    <node id="2" lon="-119.549" lat="37.731"/>
    <node id="3" lon="-119.551" lat="37.729"/>
    <way id="10" timestamp="2026-08-03T00:00:00Z"><nd ref="1"/><nd ref="2"/><tag k="highway" v="path"/><tag k="name" v="Mist Trail"/></way>
    <way id="20"><nd ref="3"/><nd ref="1"/><tag k="highway" v="residential"/></way>
    <way id="30"><nd ref="2"/><nd ref="3"/><tag k="highway" v="path"/><tag k="name" v="Other Trail"/></way>
  </osm>`;
  const selected = selectPilotOsmElements(parseOsmXml(xml));
  assert.deepEqual(selected.filter(({ type }) => type === "way").map(({ id }) => id), ["10", "20"]);
  assert.equal(selected.find(({ id }) => id === "1").tags.information, "trailhead");
  assert.equal(selected.find(({ id }) => id === "10").info.timestamp, "2026-08-03T00:00:00Z");
});

test("selects only the named agency corridor from a cached response", () => {
  const snapshot = {
    features: [
      { properties: { TRLNAME: "Mist Trail" } },
      { properties: { TRLNAME: "John Muir Trail" } },
    ],
  };
  assert.deepEqual(selectPilotAgencyFeatures(snapshot), [snapshot.features[0]]);
});
