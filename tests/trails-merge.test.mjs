import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { validateTrailSegment } from "../scripts/trails/model.mjs";
import {
  geometryProximityMeters,
  mergeTrailSegments,
} from "../scripts/trails/normalize/merge.mjs";
import { normalizeSegmentCandidate } from "../scripts/trails/normalize/segments.mjs";

const readFixture = async (name) => JSON.parse(await readFile(
  new URL(`./fixtures/trails/${name}.json`, import.meta.url),
));

const sourceRef = (provider, sourceId) => ({
  provider,
  sourceId,
  retrievedAt: "2026-08-03T00:00:00.000Z",
  sourceUrl: `https://example.test/${provider}/${sourceId}`,
});

function candidate(overrides = {}) {
  return {
    id: overrides.id ?? "candidate",
    fromNodeId: overrides.fromNodeId ?? "node-a",
    toNodeId: overrides.toNodeId ?? "node-b",
    geometry: overrides.geometry ?? {
      type: "LineString",
      coordinates: [[-119.721, 37.803], [-119.718, 37.805]],
    },
    name: overrides.name,
    manager: overrides.manager,
    hiking: overrides.hiking ?? "unknown",
    access: overrides.access ?? "unknown",
    status: overrides.status ?? "unknown",
    surface: overrides.surface,
    sourceRefs: overrides.sourceRefs ?? [sourceRef("osm", overrides.id ?? "candidate")],
    fieldProvenance: overrides.fieldProvenance,
  };
}

test("normalizes provisional agency segments with deterministic topology and calculated length", () => {
  const provisional = candidate({ id: "agency", sourceRefs: [sourceRef("usgs", "44")] });
  delete provisional.fromNodeId;
  delete provisional.toNodeId;
  const first = normalizeSegmentCandidate(provisional);
  const second = normalizeSegmentCandidate(provisional);

  assert.deepEqual(first, second);
  assert.match(first.fromNodeId, /^node_/);
  assert.ok(first.lengthMeters > 300);
  validateTrailSegment(first);
});

test("merges exact conflicting geometry using official permission and keeps losing evidence", async () => {
  const fixture = await readFixture("conflicting-sources");
  const result = mergeTrailSegments(fixture.candidates);

  assert.equal(result.segments.length, 1);
  const [segment] = result.segments;
  assert.equal(segment.hiking, fixture.expected.hiking);
  assert.equal(segment.status, fixture.expected.status);
  assert.deepEqual(
    segment.sourceRefs.map(({ provider }) => provider).sort(),
    fixture.expected.preservedProviders.sort(),
  );
  assert.deepEqual(
    result.provenance[segment.id].hiking.map(({ provider, value, selected }) => ({
      provider,
      value,
      selected,
    })),
    [
      { provider: "nps", value: "blocked", selected: true },
      { provider: "usgs", value: "allowed", selected: false },
    ],
  );
  assert.equal(result.conflicts.some(({ field }) => field === "hiking"), true);
  validateTrailSegment(segment);
});

test("requires geometry proximity even when normalized names and managers match", () => {
  const first = candidate({
    id: "near-one",
    name: "  Example   Falls-Trail ",
    manager: "Yosemite National Park",
  });
  const far = candidate({
    id: "far-two",
    name: "example falls trail",
    manager: "Yosemite National Park",
    geometry: {
      type: "LineString",
      coordinates: [[-120.721, 38.803], [-120.718, 38.805]],
    },
  });
  assert.equal(mergeTrailSegments([first, far]).segments.length, 2);
});

test("merges nearby normalized names but rejects nearby conflicting descriptive evidence", () => {
  const base = candidate({ id: "base", name: "Falls Trail", manager: "NPS" });
  const offset = candidate({
    id: "offset",
    name: " falls   trail ",
    manager: "nps",
    geometry: {
      type: "LineString",
      coordinates: [[-119.72096, 37.803], [-119.71796, 37.805]],
    },
  });
  assert.ok(geometryProximityMeters(base.geometry, offset.geometry) < 12);
  assert.equal(mergeTrailSegments([base, offset]).segments.length, 1);

  const conflicting = candidate({
    ...offset,
    id: "conflicting",
    name: "Different Connector",
    manager: "Different Manager",
  });
  assert.equal(mergeTrailSegments([base, conflicting]).segments.length, 2);
});

test("keeps unnamed segments routable and removes duplicate records deterministically", async () => {
  const fixture = await readFixture("unnamed-segment");
  const first = mergeTrailSegments([fixture.segment, structuredClone(fixture.segment)]);
  const reversed = mergeTrailSegments([structuredClone(fixture.segment), fixture.segment]);

  assert.equal(first.segments.length, 1);
  assert.equal(first.segments[0].name, undefined);
  assert.equal(first.segments[0].fromNodeId, fixture.segment.fromNodeId);
  assert.deepEqual(first, reversed);
  validateTrailSegment(first.segments[0]);
});

test("land-manager access and status beat OSM while raw source fields survive", () => {
  const osm = candidate({
    id: "osm-way",
    access: "public",
    status: "open",
    sourceRefs: [sourceRef("osm", "way/11")],
    fieldProvenance: { access: { tag: "access", rawValue: "yes" } },
  });
  const official = candidate({
    id: "nps-feature",
    access: "private",
    status: "seasonal",
    sourceRefs: [sourceRef("nps", "feature/7")],
    fieldProvenance: { access: { field: "OPEN_PUBLIC", rawValue: "No" } },
  });
  const result = mergeTrailSegments([osm, official]);
  const [segment] = result.segments;

  assert.equal(segment.access, "private");
  assert.equal(segment.status, "seasonal");
  assert.deepEqual(
    result.provenance[segment.id].access.find(({ provider }) => provider === "osm").sourceField,
    { tag: "access", rawValue: "yes" },
  );
  assert.equal(result.conflicts.some(({ field }) => field === "access"), true);
  assert.equal(result.conflicts.some(({ field }) => field === "status"), true);
});

test("explicit OSM permission is a fallback when an official source is unknown", () => {
  const official = candidate({
    id: "official-unknown",
    sourceRefs: [sourceRef("nps", "feature/unknown")],
  });
  const osm = candidate({
    id: "osm-explicit",
    hiking: "allowed",
    access: "public",
    status: "open",
    sourceRefs: [sourceRef("osm", "way/explicit")],
  });
  const result = mergeTrailSegments([official, osm]);
  const [segment] = result.segments;

  assert.equal(segment.hiking, "allowed");
  assert.equal(segment.access, "public");
  assert.equal(segment.status, "open");
  assert.equal(result.provenance[segment.id].lengthMeters[0].provider, "alpine-search");
});

test("deduplicates refreshed references by provider/source identity", () => {
  const old = candidate({
    id: "old",
    sourceRefs: [{
      ...sourceRef("usgs", "same-feature"),
      retrievedAt: "2026-08-01T00:00:00.000Z",
      sourceUrl: "https://example.test/old-layer",
    }],
  });
  const refreshed = candidate({
    id: "refreshed",
    sourceRefs: [{
      ...sourceRef("USGS", "same-feature"),
      retrievedAt: "2026-08-03T00:00:00.000Z",
      sourceUrl: "https://example.test/new-layer",
    }],
  });
  const [segment] = mergeTrailSegments([old, refreshed]).segments;

  assert.equal(segment.sourceRefs.length, 1);
  assert.equal(segment.sourceRefs[0].retrievedAt, "2026-08-03T00:00:00.000Z");
});

test("keeps OSM topology orientation with reversed official geometry provenance", () => {
  const osm = candidate({
    id: "osm-oriented",
    fromNodeId: "osm-west",
    toNodeId: "osm-east",
    sourceRefs: [sourceRef("osm", "way/oriented")],
  });
  const official = candidate({
    id: "usgs-reversed",
    fromNodeId: "agency-east",
    toNodeId: "agency-west",
    geometry: {
      type: "LineString",
      coordinates: [...osm.geometry.coordinates].reverse(),
    },
    sourceRefs: [sourceRef("usgs", "feature/reversed")],
  });
  const result = mergeTrailSegments([official, osm]);
  const [segment] = result.segments;

  assert.equal(segment.fromNodeId, "osm-west");
  assert.equal(segment.toNodeId, "osm-east");
  assert.deepEqual(segment.geometry.coordinates, osm.geometry.coordinates);
  assert.equal(
    result.provenance[segment.id].geometry.find(({ provider }) => provider === "usgs").selected,
    true,
  );
});
