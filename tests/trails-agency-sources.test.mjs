import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  fetchArcGisSnapshot,
  normalizeArcGisFeature,
  readArcGisSnapshot,
} from "../scripts/trails/sources/arcgis.mjs";
import { EBRPD_SOURCE, normalizeEbrpdSnapshot } from "../scripts/trails/sources/ebrpd.mjs";
import { NPS_SOURCE, normalizeNpsSnapshot } from "../scripts/trails/sources/nps.mjs";
import {
  STATE_PARKS_SOURCE,
  normalizeStateParksSnapshot,
} from "../scripts/trails/sources/state-parks.mjs";
import { USFS_SOURCE, normalizeUsfsSnapshot } from "../scripts/trails/sources/usfs.mjs";
import { USGS_SOURCE, normalizeUsgsSnapshot } from "../scripts/trails/sources/usgs.mjs";

const fixtureUrl = (provider) =>
  new URL(`./fixtures/trails/agencies/${provider}.json`, import.meta.url);

test("normalizes cached USGS fields without inferring public access", async () => {
  const snapshot = await readArcGisSnapshot(fixtureUrl("usgs"), USGS_SOURCE);
  const [segment] = normalizeUsgsSnapshot(snapshot);

  assert.equal(segment.name, "Yosemite Falls Trail");
  assert.equal(segment.hiking, "allowed");
  assert.equal(segment.access, "unknown");
  assert.equal(segment.status, "unknown");
  assert.deepEqual(segment.sourceLength, { value: 3.42, unit: "miles", field: "LENGTHMILES" });
  assert.equal(segment.sourceRefs[0].sourceId, "USGS-PERM-101");
  assert.equal(segment.fieldProvenance.hiking.field, "HIKERPEDESTRIAN");
});

test("matches audited USFS hiking acceptance fields", async () => {
  const snapshot = await readArcGisSnapshot(fixtureUrl("usfs"), USFS_SOURCE);
  const segments = normalizeUsfsSnapshot(snapshot);

  assert.deepEqual(segments.map(({ hiking }) => hiking), ["allowed", "blocked"]);
  assert.equal(segments[0].access, "unknown");
  assert.equal(segments[0].surface, "Natural");
  assert.equal(segments[0].manager, "Stanislaus National Forest");
  assert.equal(segments[1].status, "closed");
});

test("uses NPS trail-use and open-to-public fields without calling the service", async () => {
  const snapshot = await readArcGisSnapshot(fixtureUrl("nps"), NPS_SOURCE);
  const segments = normalizeNpsSnapshot(snapshot);

  assert.deepEqual(
    segments.map(({ hiking, access, status }) => ({ hiking, access, status })),
    [
      { hiking: "allowed", access: "public", status: "open" },
      { hiking: "blocked", access: "unknown", status: "closed" },
    ],
  );
});

test("keeps local-agency permission unknown when their snapshots do not encode it", async () => {
  const stateSnapshot = await readArcGisSnapshot(fixtureUrl("state-parks"), STATE_PARKS_SOURCE);
  const ebrpdSnapshot = await readArcGisSnapshot(fixtureUrl("ebrpd"), EBRPD_SOURCE);
  const [stateSegment] = normalizeStateParksSnapshot(stateSnapshot);
  const [ebrpdSegment] = normalizeEbrpdSnapshot(ebrpdSnapshot);

  assert.equal(stateSegment.hiking, "unknown");
  assert.equal(stateSegment.access, "unknown");
  assert.equal(stateSegment.manager, "Castle Rock State Park");
  assert.equal(ebrpdSegment.hiking, "unknown");
  assert.equal(ebrpdSegment.access, "unknown");
  assert.equal(ebrpdSegment.manager, "Coyote Hills Regional Park");
  assert.equal(ebrpdSegment.geometry.type, "LineString");
});

test("empty layers and malformed non-line records normalize to empty arrays", () => {
  const empty = {
    schemaVersion: 1,
    source: { provider: USGS_SOURCE.provider, url: USGS_SOURCE.url },
    retrievedAt: "2026-08-03T12:00:00.000Z",
    features: [],
  };
  assert.deepEqual(normalizeUsgsSnapshot(empty), []);
  assert.deepEqual(normalizeArcGisFeature({
    properties: { OBJECTID: 1 },
    geometry: { type: "Point", coordinates: [-119.5, 37.7] },
  }, USGS_SOURCE, { retrievedAt: empty.retrievedAt }), []);
});

test("normalization is deterministic and splits multipart line geometry", () => {
  const feature = {
    properties: { OBJECTID: 44, NAME: "Forked Trail" },
    geometry: {
      type: "MultiLineString",
      coordinates: [
        [[-119.7, 37.7], [-119.6, 37.7]],
        [[-119.6, 37.7], [-119.5, 37.8]],
      ],
    },
  };
  const options = { retrievedAt: "2026-08-03T12:00:00.000Z" };
  const first = normalizeArcGisFeature(feature, USGS_SOURCE, options);
  const second = normalizeArcGisFeature(feature, USGS_SOURCE, options);
  assert.equal(first.length, 2);
  assert.deepEqual(first, second);
  assert.notEqual(first[0].id, first[1].id);
});

test("reads snapshots from disk and rejects mismatched providers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "alpine-agency-test-"));
  const path = join(directory, "snapshot.json");
  const snapshot = {
    schemaVersion: 1,
    source: { provider: "usgs", url: USGS_SOURCE.url },
    retrievedAt: "2026-08-03T12:00:00.000Z",
    features: [],
  };
  await writeFile(path, JSON.stringify(snapshot));
  assert.deepEqual(await readArcGisSnapshot(path, USGS_SOURCE), snapshot);
  await assert.rejects(() => readArcGisSnapshot(path, NPS_SOURCE), /provider.*does not match/);
});

test("fetches ArcGIS snapshots by complete object-ID pages with stable ordering", async () => {
  const calls = [];
  const response = (payload) => ({ ok: true, json: async () => payload });
  const fetchImpl = async (request) => {
    const url = new URL(request);
    calls.push(url);
    if (url.pathname.endsWith("/37")) {
      return response({ objectIdField: "OBJECTID", maxRecordCount: 2 });
    }
    if (url.searchParams.get("returnIdsOnly") === "true") {
      return response({ objectIds: [3, 1, 2] });
    }
    const ids = url.searchParams.get("objectIds").split(",");
    return response({
      type: "FeatureCollection",
      features: ids.reverse().map((id) => ({
        type: "Feature",
        properties: { OBJECTID: Number(id), NAME: `Trail ${id}` },
        geometry: {
          type: "LineString",
          coordinates: [[-119.7, 37.7], [-119.6 + Number(id) / 100, 37.8]],
        },
      })),
    });
  };

  const snapshot = await fetchArcGisSnapshot(USGS_SOURCE, {
    bbox: [-120.1, 37.55, -119.35, 38.15],
    fetchImpl,
    pageSize: 2,
    retrievedAt: "2026-08-03T12:00:00.000Z",
  });
  assert.deepEqual(snapshot.features.map((feature) => feature.properties.OBJECTID), [1, 2, 3]);
  assert.equal(calls.filter((url) => url.searchParams.has("objectIds")).length, 2);
  assert.equal(calls.some((url) => url.searchParams.get("resultOffset")), false);
});

test("falls back to ordered offsets when a layer cannot return object IDs", async () => {
  const offsets = [];
  const response = (payload) => ({ ok: true, json: async () => payload });
  const fetchImpl = async (request) => {
    const url = new URL(request);
    if (url.pathname.endsWith("/37")) {
      return response({ objectIdField: "OBJECTID", maxRecordCount: 2 });
    }
    if (url.searchParams.get("returnIdsOnly") === "true") return response({});
    const offset = Number(url.searchParams.get("resultOffset"));
    offsets.push(offset);
    if (offset > 1) return response({ features: [] });
    return response({
      exceededTransferLimit: offset === 0,
      features: [{
        type: "Feature",
        properties: { OBJECTID: offset + 1 },
        geometry: {
          type: "LineString",
          coordinates: [[-119.7, 37.7], [-119.6, 37.8]],
        },
      }],
    });
  };
  const snapshot = await fetchArcGisSnapshot(USGS_SOURCE, {
    fetchImpl,
    pageSize: 2,
    retrievedAt: "2026-08-03T12:00:00.000Z",
  });
  assert.deepEqual(offsets, [0, 1]);
  assert.deepEqual(snapshot.features.map((feature) => feature.properties.OBJECTID), [1, 2]);
});

test("does not treat flaky network behavior as part of offline normalization", async () => {
  const snapshot = await readArcGisSnapshot(fixtureUrl("usgs"), USGS_SOURCE);
  const before = normalizeUsgsSnapshot(snapshot);
  const after = normalizeUsgsSnapshot(snapshot);
  assert.deepEqual(after, before);
});
