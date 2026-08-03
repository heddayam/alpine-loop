import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeRecords,
  buildNameOverlap,
  normalizeTrailName,
  renderCoverageReport,
} from "../scripts/trails/coverage-lib.mjs";

const source = {
  id: "osm",
  nameFields: ["name"],
  surfaceFields: ["surface"],
  lengthFields: ["distance"],
  statusFields: ["status"],
};

test("normalizes trail names for cross-source comparisons", () => {
  assert.equal(normalizeTrailName("The Ohlone Trail"), "ohlone");
  assert.equal(normalizeTrailName("Ohlone Regional Route"), "ohlone regional");
});

test("audits hiking evidence, geometry detail, and trailheads conservatively", () => {
  const analysis = analyzeRecords(
    [
      {
        recordType: "trail",
        properties: { name: "Example Trail", foot: "designated", surface: "dirt" },
        geometry: {
          type: "LineString",
          coordinates: [[-122, 37], [-121.9, 37.1], [-121.8, 37.2]],
        },
      },
      {
        recordType: "trail",
        properties: { name: "Closed Trail", foot: "no" },
        geometry: {
          type: "LineString",
          coordinates: [[-121.8, 37.2], [-121.7, 37.3]],
        },
      },
      { recordType: "trailhead", properties: { name: "Example Trailhead" }, geometry: null },
    ],
    source,
  );
  assert.equal(analysis.features, 2);
  assert.equal(analysis.trailheads, 1);
  assert.equal(analysis.coverage.namedPct, 100);
  assert.equal(analysis.coverage.explicitHikingAllowedPct, 50);
  assert.equal(analysis.coverage.explicitHikingBlockedPct, 50);
  assert.equal(analysis.coverage.geometryPct, 100);
  assert.equal(analysis.coverage.topologyPct, 100);
  assert.equal(analysis.coverage.sharedEndpointPct, 50);
});

test("uses stable OSM node identity as topology evidence without downloading coordinates", () => {
  const analysis = analyzeRecords(
    [
      {
        recordType: "trail",
        properties: { highway: "path" },
        geometry: null,
        nodeRefs: [10, 11, 12],
        topologyEndpoints: [10, 12],
      },
      {
        recordType: "trail",
        properties: { highway: "path" },
        geometry: null,
        nodeRefs: [12, 13],
        topologyEndpoints: [12, 13],
      },
    ],
    source,
  );
  assert.equal(analysis.coverage.geometryPct, 0);
  assert.equal(analysis.coverage.topologyPct, 100);
  assert.equal(analysis.coverage.sharedEndpointPct, 50);
  assert.equal(analysis.averageVertices, 2.5);
});

test("computes normalized-name overlap and renders a report", () => {
  const overlap = buildNameOverlap([
    { sourceId: "a", analysis: { names: ["alpha", "beta"] } },
    { sourceId: "b", analysis: { names: ["beta", "gamma"] } },
  ]);
  assert.deepEqual(overlap, [{ left: "a", right: "b", sharedNames: 1 }]);

  const markdown = renderCoverageReport({
    generatedAt: "2026-08-03T00:00:00.000Z",
    regions: [],
    sources: [{ label: "Example", url: "https://example.com" }],
  });
  assert.match(markdown, /Hiking trail source coverage spike/);
  assert.match(markdown, /https:\/\/example\.com/);
});
