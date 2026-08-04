import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";
import {
  MAX_RUNTIME_SHARD_GZIP_BYTES,
  MAX_RUNTIME_SHARD_RAW_BYTES,
  contentTypeForArtifact,
  createBuildId,
  defaultArtifactPolicy,
  stableJson,
} from "../scripts/trails/artifact-contract.mjs";
import {
  TrailPublicationError,
  publishRegionalBuild,
  rollbackRegionalBuild,
} from "../scripts/trails/versioned-publisher.mjs";
import {
  TrailRuntimeCatalogError,
  loadActiveRegionalTrailCatalog,
  loadVerifiedTrailGeometry,
  readVerifiedRuntimeArtifactBytes,
} from "../app/trails/active-catalog.ts";
import {
  TrailArtifactNotFoundError,
} from "../app/trails/storage.ts";
import { locateTrailArtifact } from "../app/trails/artifact-locator.ts";
import { parseSelectedSegmentNdjson } from "../app/trails/segment-reader.ts";
import { searchTrails, trailAccessPointDetails } from "../app/trails/search.ts";
import {
  buildRegionArtifacts,
  writeRegionArtifacts,
} from "../scripts/trails/build-region.mjs";
import { buildTrailSearchIndex } from "../scripts/trails/build-search-index.mjs";

const REGION_ID = "fixture-region";
const RETRIEVED_AT = "2026-08-04T12:00:00.000Z";
const REVIEWED_AT = "2026-08-04T13:00:00.000Z";
const ACTIVATED_AT = "2026-08-04T14:00:00.000Z";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function jsonBytes(value) {
  return Buffer.from(`${stableJson(value)}\n`);
}

function metadata(path, bytes, records) {
  return {
    path,
    records,
    rawBytes: bytes.byteLength,
    compressedBytes: gzipSync(bytes, { level: 9 }).byteLength,
    contentEncoding: "identity",
    contentType: contentTypeForArtifact(path),
    sha256: sha256(bytes),
    ...defaultArtifactPolicy(path),
  };
}

async function writeFixtureBuild(root, variant, { accepted = true } = {}) {
  const segmentId = `segment_aa0${variant}`;
  const trailId = `named-trail_aa0${variant}`;
  const accessId = `access-aa0${variant}`;
  const sourceRef = {
    provider: "fixture",
    sourceId: String(variant),
    retrievedAt: RETRIEVED_AT,
    sourceUrl: "https://example.test/trails",
  };
  const segment = {
    id: segmentId,
    fromNodeId: "node-a",
    toNodeId: "node-b",
    geometry: { type: "LineString", coordinates: [[-120, 37], [-119.99, 37.01]] },
    name: `Fixture Trail ${variant}`,
    hiking: "allowed",
    access: "public",
    status: "open",
    lengthMeters: 1_000 + variant,
    sourceRefs: [sourceRef],
  };
  const trailGeometryPath = `trail-geometry/aa/${trailId}.ndjson`;
  const values = {
    "named-trails.json": {
      schemaVersion: 2,
      regionId: REGION_ID,
      trails: [{
        id: trailId,
        name: `Fixture Trail ${variant}`,
        segmentIds: [segmentId],
        accessPointIds: [accessId],
        bounds: [-120, 37, -119.99, 37.01],
        lengthMeters: 1_000 + variant,
        sourceRefs: [sourceRef],
        dataConfidence: "high",
      }],
    },
    "access-points.geojson": {
      type: "FeatureCollection",
      schemaVersion: 2,
      regionId: REGION_ID,
      features: [{
        type: "Feature",
        id: accessId,
        geometry: { type: "Point", coordinates: [-120, 37] },
        properties: {
          id: accessId,
          name: "Fixture Trailhead",
          type: "trailhead",
          confidence: "official",
          connectedNodeIds: ["node-a"],
          sourceRefs: [sourceRef],
        },
      }],
    },
    "segments/index.json": {
      schemaVersion: 2,
      regionId: REGION_ID,
      partitioning: { algorithm: "segment-id-hex-prefix", prefixLength: 2 },
      shards: { aa: { path: "segments/aa.ndjson", records: 1 } },
    },
    "segments/aa.ndjson": `${stableJson(segment)}\n`,
    "trail-geometry/index.json": {
      schemaVersion: 2,
      regionId: REGION_ID,
      objects: { [trailId]: { path: trailGeometryPath, records: 1 } },
    },
    [trailGeometryPath]: `${stableJson(segment)}\n`,
    "segment-provenance/index.json": {
      schemaVersion: 2,
      regionId: REGION_ID,
      partitioning: { algorithm: "segment-id-hex-prefix", prefixLength: 2 },
      shards: {},
    },
  };
  const recordCounts = {
    "named-trails.json": 1,
    "access-points.geojson": 1,
    "segments/index.json": 1,
    "segments/aa.ndjson": 1,
    "trail-geometry/index.json": 1,
    [trailGeometryPath]: 1,
    "segment-provenance/index.json": 0,
  };
  const files = Object.fromEntries(Object.entries(values).map(([path, value]) =>
    [path, typeof value === "string" ? Buffer.from(value) : jsonBytes(value)]));
  const artifacts = Object.fromEntries(Object.entries(files).map(([path, bytes]) =>
    [path, metadata(path, bytes, recordCounts[path])]));
  const sourceSnapshots = [{
    id: "fixture-input",
    sha256: sha256(`fixture-${variant}`),
    retrievedAt: RETRIEVED_AT,
  }];
  const buildId = createBuildId({ regionId: REGION_ID, sourceSnapshots, artifacts });
  const manifest = {
    schemaVersion: 2,
    buildId,
    generatedAt: RETRIEVED_AT,
    region: { id: REGION_ID, label: "Fixture Region", bounds: [-121, 36, -119, 38] },
    sourceSnapshots,
    decisions: {
      qa: accepted
        ? { decision: "pass", decidedAt: REVIEWED_AT, notes: [] }
        : { decision: "pending", decidedAt: null, notes: [] },
      review: accepted
        ? { decision: "accepted", reviewer: "fixture-reviewer", decidedAt: REVIEWED_AT, notes: [] }
        : { decision: "pending", reviewer: null, decidedAt: null, notes: [] },
    },
    delivery: {
      lazyTrailGeometryIndex: "trail-geometry/index.json",
      partitioning: { algorithm: "segment-id-hex-prefix", prefixLength: 2 },
      shardSizeTargets: {
        rawBytes: MAX_RUNTIME_SHARD_RAW_BYTES,
        compressedBytes: MAX_RUNTIME_SHARD_GZIP_BYTES,
        exceptions: [],
      },
    },
    artifacts,
  };
  const manifestBytes = jsonBytes(manifest);
  const searchIndex = {
    schemaVersion: 1,
    regionId: REGION_ID,
    source: {
      generatedAt: RETRIEVED_AT,
      manifestSha256: sha256(manifestBytes),
      namedTrailsSha256: artifacts["named-trails.json"].sha256,
      segmentsIndexSha256: artifacts["segments/index.json"].sha256,
      trailGeometryIndexSha256: artifacts["trail-geometry/index.json"].sha256,
      segmentPartitionPrefixLength: 2,
    },
    trails: {
      [trailId]: {
        hiking: "allowed",
        access: "public",
        status: "open",
        routeClass: "hiking",
      },
    },
  };

  for (const [path, bytes] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), bytes);
  }
  await writeFile(join(root, "manifest.json"), manifestBytes);
  await writeFile(join(root, "search-index.json"), jsonBytes(searchIndex));
  return { buildId, manifest, trailId, accessId };
}

async function streamBytes(body) {
  return Buffer.from(await new Response(body).arrayBuffer());
}

class MemoryPublicationStore {
  constructor() {
    this.objects = new Map();
    this.events = [];
    this.failNextSuffix = null;
    this.nextVersion = 1;
    this.beforeNextCurrent = null;
  }

  async get(key) {
    const object = this.objects.get(key);
    this.events.push({ operation: "get", key });
    if (!object) throw new TrailArtifactNotFoundError(key);
    return {
      key,
      body: new ReadableStream({ start(controller) { controller.enqueue(object.bytes); controller.close(); } }),
      size: object.bytes.byteLength,
      headers: new Headers(object.httpMetadata),
      customMetadata: object.customMetadata,
      httpMetadata: object.httpMetadata,
      version: object.version,
      etag: object.etag,
    };
  }

  async putImmutable(key, body, options) {
    this.events.push({ operation: "putImmutable", key });
    if (this.failNextSuffix && key.endsWith(this.failNextSuffix)) {
      this.failNextSuffix = null;
      throw new Error("injected immutable upload failure");
    }
    if (this.objects.has(key)) return "already-present";
    const bytes = await streamBytes(body);
    this.objects.set(key, { bytes, ...options });
    return "created";
  }

  async putCurrent(key, body, options) {
    this.events.push({ operation: "putCurrent", key });
    if (this.beforeNextCurrent) {
      const callback = this.beforeNextCurrent;
      this.beforeNextCurrent = null;
      await callback(key);
    }
    const existing = this.objects.get(key);
    if ((options.expectedVersion === null && existing) ||
        (options.expectedVersion !== null &&
         (existing?.etag ?? existing?.version) !== options.expectedVersion)) {
      return "conflict";
    }
    const bytes = body instanceof Uint8Array ? body : await streamBytes(body);
    this.objects.set(key, {
      bytes: new Uint8Array(bytes),
      ...options,
      version: `r2-version-${this.nextVersion}`,
      etag: `etag-${this.nextVersion++}`,
    });
    return "updated";
  }

  pointer() {
    const object = this.objects.get(`trails/${REGION_ID}/current.json`);
    return object ? JSON.parse(Buffer.from(object.bytes).toString("utf8")) : null;
  }

  corrupt(key) {
    const object = this.objects.get(key);
    const bytes = new Uint8Array(object.bytes);
    bytes[Math.floor(bytes.length / 2)] ^= 1;
    this.objects.set(key, { ...object, bytes });
  }
}

async function withFixture(t, variant, options) {
  const root = await mkdtemp(join(tmpdir(), "trails-publisher-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = await writeFixtureBuild(root, variant, options);
  return { root, ...fixture };
}

test("publishes and resolves an accepted v2 catalog without listing storage", async (t) => {
  const fixture = await withFixture(t, 1);
  const store = new MemoryPublicationStore();
  const result = await publishRegionalBuild({
    artifactDirectory: fixture.root,
    store,
    activatedAt: ACTIVATED_AT,
    activatedBy: "release-reviewer",
  });

  assert.equal(result.activated, true);
  assert.equal(result.buildId, fixture.buildId);
  assert.deepEqual(store.events.at(-1), {
    operation: "putCurrent",
    key: `trails/${REGION_ID}/current.json`,
  });
  assert.equal("list" in store, false);
  const active = await loadActiveRegionalTrailCatalog(store, REGION_ID);
  assert.equal(active.catalog.manifest.buildId, fixture.buildId);
  assert.equal(active.catalog.partitionPrefixLength, 2);
  const response = searchTrails(active.catalog, {
    regionId: REGION_ID,
    driveTimePolygon: {
      type: "Polygon",
      coordinates: [[[-121, 36], [-119, 36], [-119, 38], [-121, 38], [-121, 36]]],
    },
    limit: 500,
  });
  assert.equal(response.trails[0].accessPointCount, 1);
  assert.equal(response.trails[0].accessPoints[0].confidence, "official");
  assert.deepEqual(
    trailAccessPointDetails(active.catalog, active.catalog.namedTrails[0])[0].connectedNodeIds,
    ["node-a"],
  );
  const shardPath = active.catalog.shardPaths.aa;
  const located = locateTrailArtifact(active.catalog.manifest, shardPath);
  const shard = await store.get(located.key, { expectedSha256: located.expectedSha256 });
  const segments = await parseSelectedSegmentNdjson(
    shard.body,
    new Set(active.catalog.namedTrails[0].segmentIds),
  );
  assert.deepEqual(segments.map(({ id }) => id), active.catalog.namedTrails[0].segmentIds);
});

test("actual v2 producer output publishes and serves through the runtime consumer", async (t) => {
  const artifactRoot = await mkdtemp(join(tmpdir(), "trails-publisher-e2e-"));
  const regionId = "yosemite-stanislaus";
  const root = join(artifactRoot, regionId);
  await mkdir(root, { recursive: true });
  t.after(() => rm(artifactRoot, { recursive: true, force: true }));
  const source = (sourceId) => ({
    provider: "fixture",
    sourceId,
    retrievedAt: RETRIEVED_AT,
    sourceUrl: `https://example.test/${sourceId}`,
  });
  const nodeValues = [
    ["node-a", -119.721, 37.805],
    ["node-b", -119.7208, 37.805],
    ["node-c", -119.7206, 37.805],
  ];
  const result = await buildRegionArtifacts({
    regionId,
    buildTimestamp: RETRIEVED_AT,
    segmentCandidates: [
      {
        id: "producer-west",
        fromNodeId: "node-a",
        toNodeId: "node-b",
        geometry: {
          type: "LineString",
          coordinates: [[-119.721, 37.805], [-119.7208, 37.805]],
        },
        name: "Producer Trail",
        hiking: "allowed",
        access: "public",
        status: "open",
        sourceRefs: [source("west")],
      },
      {
        id: "producer-east",
        fromNodeId: "node-b",
        toNodeId: "node-c",
        geometry: {
          type: "LineString",
          coordinates: [[-119.7208, 37.805], [-119.7206, 37.805]],
        },
        name: "Producer Trail",
        hiking: "allowed",
        access: "public",
        status: "open",
        sourceRefs: [source("east")],
      },
    ],
    sourceNodes: nodeValues.map(([id, longitude, latitude], index) => ({
      id,
      longitude,
      latitude,
      sourceNodeIds: [`fixture:${index}`],
      incidentSegmentIds: [],
    })),
    accessPointCandidates: [{
      longitude: -119.721,
      latitude: 37.805,
      name: "Producer Trailhead",
      type: "trailhead",
      confidence: "official",
      connectedNodeIds: ["node-a"],
      sourceRefs: [source("trailhead")],
    }],
    qaDecision: { decision: "pass", decidedAt: REVIEWED_AT, notes: [] },
    reviewDecision: {
      decision: "accepted",
      reviewer: "producer-reviewer",
      decidedAt: REVIEWED_AT,
      notes: [],
    },
  });
  await writeRegionArtifacts(result, root);
  const searchIndex = await buildTrailSearchIndex(regionId, {
    artifactRoot,
  });
  await writeFile(join(root, "search-index.json"), jsonBytes(searchIndex));
  const store = new MemoryPublicationStore();
  await publishRegionalBuild({
    artifactDirectory: root,
    store,
    activatedAt: ACTIVATED_AT,
    activatedBy: "release-reviewer",
  });
  const active = await loadActiveRegionalTrailCatalog(store, regionId);
  const trail = active.catalog.namedTrails[0];
  const response = searchTrails(active.catalog, {
    regionId,
    driveTimePolygon: {
      type: "Polygon",
      coordinates: [[[-121, 36], [-119, 36], [-119, 38], [-121, 38], [-121, 36]]],
    },
    limit: 10,
  });
  assert.equal(response.trails[0].id, trail.id);
  store.events.length = 0;
  const segments = await loadVerifiedTrailGeometry(store, active.catalog, trail);
  assert.deepEqual(segments.map(({ id }) => id), trail.segmentIds);
  assert.equal(store.events.filter(({ operation }) => operation === "get").length, 1);
});

test("refuses activation until QA and review are accepted", async (t) => {
  const fixture = await withFixture(t, 2, { accepted: false });
  const store = new MemoryPublicationStore();
  await assert.rejects(
    publishRegionalBuild({
      artifactDirectory: fixture.root,
      store,
      activatedAt: ACTIVATED_AT,
      activatedBy: "release-reviewer",
    }),
    /passing QA decision/,
  );
  assert.equal(store.pointer(), null);
  assert.equal(store.events.some(({ operation }) => operation.startsWith("put")), false);
});

test("refuses missing or extra search summaries despite matching source hashes", async (t) => {
  for (const [variant, mutate] of [
    [20, (index) => { delete index.trails[Object.keys(index.trails)[0]]; }],
    [21, (index) => { index.trails["named-trail_ffffffff"] = { hiking: "allowed" }; }],
  ]) {
    const fixture = await withFixture(t, variant);
    const searchPath = join(fixture.root, "search-index.json");
    const searchIndex = JSON.parse(await readFile(searchPath, "utf8"));
    mutate(searchIndex);
    await writeFile(searchPath, jsonBytes(searchIndex));
    await assert.rejects(
      publishRegionalBuild({
        artifactDirectory: fixture.root,
        store: new MemoryPublicationStore(),
        activatedAt: ACTIVATED_AT,
        activatedBy: "release-reviewer",
      }),
      /exactly cover named trails/,
    );
  }
});

test("failure before activation is retryable and re-publishing is idempotent", async (t) => {
  const fixture = await withFixture(t, 3);
  const store = new MemoryPublicationStore();
  store.failNextSuffix = "/search-index.json";
  const publish = () => publishRegionalBuild({
    artifactDirectory: fixture.root,
    store,
    activatedAt: ACTIVATED_AT,
    activatedBy: "release-reviewer",
  });

  await assert.rejects(publish(), /injected immutable upload failure/);
  assert.equal(store.pointer(), null);
  const retried = await publish();
  assert.equal(retried.activated, true);
  const pointerWrites = store.events.filter(({ operation }) => operation === "putCurrent").length;
  const repeated = await publish();
  assert.equal(repeated.activated, false);
  assert.equal(store.events.filter(({ operation }) => operation === "putCurrent").length, pointerWrites);
  assert.ok(repeated.uploads.every(({ result }) => result === "already-present"));
});

test("rollback verifies and restores the prior accepted build", async (t) => {
  const first = await withFixture(t, 4);
  const second = await withFixture(t, 5);
  const store = new MemoryPublicationStore();
  await publishRegionalBuild({
    artifactDirectory: first.root,
    store,
    activatedAt: ACTIVATED_AT,
    activatedBy: "release-reviewer",
  });
  await publishRegionalBuild({
    artifactDirectory: second.root,
    store,
    activatedAt: "2026-08-04T15:00:00.000Z",
    activatedBy: "release-reviewer",
  });
  assert.equal(store.pointer().active.buildId, second.buildId);
  assert.equal(store.pointer().previous.buildId, first.buildId);

  const result = await rollbackRegionalBuild({
    regionId: REGION_ID,
    store,
    activatedAt: "2026-08-04T16:00:00.000Z",
    activatedBy: "rollback-reviewer",
  });
  assert.deepEqual(result, {
    regionId: REGION_ID,
    buildId: first.buildId,
    rolledBackFrom: second.buildId,
  });
  assert.equal(store.pointer().active.buildId, first.buildId);
  assert.equal(store.pointer().previous.buildId, second.buildId);
  assert.equal(store.pointer().reason, "rollback");
});

test("runtime catalog loading fails closed for missing and corrupt active objects", async (t) => {
  const fixture = await withFixture(t, 6);
  const store = new MemoryPublicationStore();
  await publishRegionalBuild({
    artifactDirectory: fixture.root,
    store,
    activatedAt: ACTIVATED_AT,
    activatedBy: "release-reviewer",
  });
  const prefix = `trails/${REGION_ID}/${fixture.buildId}`;
  const namedKey = `${prefix}/named-trails.json`;
  const named = store.objects.get(namedKey);
  store.objects.delete(namedKey);
  await assert.rejects(
    loadActiveRegionalTrailCatalog(store, REGION_ID),
    TrailArtifactNotFoundError,
  );
  store.objects.set(namedKey, named);

  store.corrupt(`${prefix}/search-index.json`);
  await assert.rejects(
    loadActiveRegionalTrailCatalog(store, REGION_ID),
    TrailRuntimeCatalogError,
  );
});

test("runtime geometry content verification rejects altered bytes with unchanged hash metadata", async (t) => {
  const fixture = await withFixture(t, 8);
  const store = new MemoryPublicationStore();
  await publishRegionalBuild({
    artifactDirectory: fixture.root,
    store,
    activatedAt: ACTIVATED_AT,
    activatedBy: "release-reviewer",
  });
  const active = await loadActiveRegionalTrailCatalog(store, REGION_ID);
  const path = active.catalog.shardPaths.aa;
  const located = locateTrailArtifact(active.catalog.manifest, path);
  const metadata = fixture.manifest.artifacts[path];
  const key = `trails/${REGION_ID}/${fixture.buildId}/${path}`;
  const object = store.objects.get(key);
  const altered = Buffer.from(object.bytes);
  const policyOffset = altered.indexOf("allowed");
  assert.notEqual(policyOffset, -1);
  altered.write("blocked", policyOffset, "utf8");
  store.objects.set(key, { ...object, bytes: altered });

  await assert.rejects(
    async () => readVerifiedRuntimeArtifactBytes(
      await store.get(located.key, { expectedSha256: located.expectedSha256 }),
      metadata.rawBytes,
      { rawBytes: metadata.rawBytes, sha256: metadata.sha256 },
    ),
    TrailRuntimeCatalogError,
  );
});

test("runtime geometry rejects a clean truncation before parsing", async (t) => {
  const fixture = await withFixture(t, 9);
  const store = new MemoryPublicationStore();
  await publishRegionalBuild({
    artifactDirectory: fixture.root,
    store,
    activatedAt: ACTIVATED_AT,
    activatedBy: "release-reviewer",
  });
  const active = await loadActiveRegionalTrailCatalog(store, REGION_ID);
  const trail = active.catalog.namedTrails[0];
  const path = active.catalog.trailGeometryPaths[trail.id];
  const key = `trails/${REGION_ID}/${fixture.buildId}/${path}`;
  const object = store.objects.get(key);
  store.objects.set(key, { ...object, bytes: object.bytes.subarray(0, object.bytes.length - 1) });
  await assert.rejects(
    loadVerifiedTrailGeometry(store, active.catalog, trail),
    TrailRuntimeCatalogError,
  );
});

test("selected regional geometry uses one bounded exact-key object read", async () => {
  const store = new MemoryPublicationStore();
  const trailId = "named-trail_ab001122";
  const path = `trail-geometry/ab/${trailId}.ndjson`;
  const segmentIds = Array.from({ length: 10_000 }, (_, index) =>
    `segment_${(index % 256).toString(16).padStart(2, "0")}${index.toString(16).padStart(8, "0")}`);
  const bytes = Buffer.from(segmentIds.map((id) => stableJson({ id })).join("\n") + "\n");
  assert.ok(bytes.byteLength < MAX_RUNTIME_SHARD_RAW_BYTES);
  const digest = sha256(bytes);
  const buildId = "build_00112233445566778899aabbccddeeff";
  const key = `trails/${REGION_ID}/${buildId}/${path}`;
  store.objects.set(key, {
    bytes,
    customMetadata: { sha256: digest },
    httpMetadata: {
      contentType: "application/x-ndjson",
      cacheControl: "private, max-age=31536000, immutable",
      contentEncoding: "identity",
    },
  });
  const trail = { id: trailId, segmentIds };
  const catalog = {
    manifest: {
      schemaVersion: 2,
      buildId,
      generatedAt: RETRIEVED_AT,
      region: { id: REGION_ID, label: "Fixture Region", bounds: [-1, -1, 1, 1] },
      artifacts: {
        [path]: {
          path,
          rawBytes: bytes.byteLength,
          sha256: digest,
          role: "runtime",
          application: "required",
        },
      },
    },
    namedTrails: [trail],
    accessPoints: [],
    summaries: {},
    shardPaths: Object.fromEntries(Array.from({ length: 256 }, (_, value) => {
      const prefix = value.toString(16).padStart(2, "0");
      return [prefix, `segments/${prefix}.ndjson`];
    })),
    partitionPrefixLength: 2,
    trailGeometryPaths: { [trailId]: path },
  };
  store.events.length = 0;
  const segments = await loadVerifiedTrailGeometry(store, catalog, trail);
  assert.equal(segments.length, segmentIds.length);
  assert.deepEqual(store.events, [{ operation: "get", key }]);
});

test("serves an exact reviewed geometry exception below the absolute runtime ceiling", async () => {
  const store = new MemoryPublicationStore();
  const trailId = "named-trail_cd001122";
  const segmentId = "segment_cd001122";
  const path = `trail-geometry/cd/${trailId}.ndjson`;
  const bytes = Buffer.from(`${stableJson({
    id: segmentId,
    note: "x".repeat(MAX_RUNTIME_SHARD_RAW_BYTES),
  })}\n`);
  assert.ok(bytes.byteLength > MAX_RUNTIME_SHARD_RAW_BYTES);
  assert.ok(bytes.byteLength < 16 * 1024 * 1024);
  const compressedBytes = gzipSync(bytes, { level: 9 }).byteLength;
  const digest = sha256(bytes);
  const buildId = "build_11223344556677889900aabbccddeeff";
  const key = `trails/${REGION_ID}/${buildId}/${path}`;
  store.objects.set(key, {
    bytes,
    customMetadata: { sha256: digest },
    httpMetadata: {
      contentType: "application/x-ndjson",
      cacheControl: "private, max-age=31536000, immutable",
      contentEncoding: "identity",
    },
  });
  const trail = { id: trailId, segmentIds: [segmentId] };
  const catalog = {
    manifest: {
      schemaVersion: 2,
      buildId,
      generatedAt: RETRIEVED_AT,
      region: { id: REGION_ID, label: "Fixture Region", bounds: [-1, -1, 1, 1] },
      delivery: {
        shardSizeTargets: {
          exceptions: [{
            path,
            rawBytes: bytes.byteLength,
            compressedBytes,
            note: "Measured response review accepted this fixture exception.",
          }],
        },
      },
      artifacts: {
        [path]: {
          path,
          rawBytes: bytes.byteLength,
          compressedBytes,
          sha256: digest,
          role: "runtime",
          application: "required",
        },
      },
    },
    namedTrails: [trail],
    accessPoints: [],
    summaries: {},
    shardPaths: {},
    partitionPrefixLength: 2,
    trailGeometryPaths: { [trailId]: path },
  };
  assert.deepEqual(
    (await loadVerifiedTrailGeometry(store, catalog, trail)).map(({ id }) => id),
    [segmentId],
  );
});

test("current pointer compare-and-swap rejects a concurrent activation", async (t) => {
  const first = await withFixture(t, 10);
  const second = await withFixture(t, 11);
  const store = new MemoryPublicationStore();
  await publishRegionalBuild({
    artifactDirectory: first.root,
    store,
    activatedAt: ACTIVATED_AT,
    activatedBy: "release-reviewer",
  });
  store.beforeNextCurrent = async (key) => {
    const object = store.objects.get(key);
    const pointer = JSON.parse(Buffer.from(object.bytes).toString("utf8"));
    pointer.activatedBy = "concurrent-reviewer";
    store.objects.set(key, {
      ...object,
      bytes: jsonBytes(pointer),
      version: `v${store.nextVersion++}`,
      etag: `concurrent-etag-${store.nextVersion}`,
    });
  };
  await assert.rejects(
    publishRegionalBuild({
      artifactDirectory: second.root,
      store,
      activatedAt: "2026-08-04T15:00:00.000Z",
      activatedBy: "release-reviewer",
    }),
    /changed concurrently/,
  );
  assert.equal(store.pointer().active.buildId, first.buildId);
  assert.equal(store.pointer().activatedBy, "concurrent-reviewer");
});

test("an immutable metadata conflict fails closed", async (t) => {
  const fixture = await withFixture(t, 12);
  const store = new MemoryPublicationStore();
  await publishRegionalBuild({
    artifactDirectory: fixture.root,
    store,
    activatedAt: ACTIVATED_AT,
    activatedBy: "release-reviewer",
  });
  const key = `trails/${REGION_ID}/${fixture.buildId}/segments/aa.ndjson`;
  const object = store.objects.get(key);
  store.objects.set(key, {
    ...object,
    httpMetadata: { ...object.httpMetadata, cacheControl: "public, max-age=60" },
  });
  await assert.rejects(
    publishRegionalBuild({
      artifactDirectory: fixture.root,
      store,
      activatedAt: ACTIVATED_AT,
      activatedBy: "release-reviewer",
    }),
    /invalid cacheControl metadata/,
  );
});

test("an immutable conflict fails closed instead of replacing a build object", async (t) => {
  const fixture = await withFixture(t, 7);
  const store = new MemoryPublicationStore();
  await publishRegionalBuild({
    artifactDirectory: fixture.root,
    store,
    activatedAt: ACTIVATED_AT,
    activatedBy: "release-reviewer",
  });
  const key = `trails/${REGION_ID}/${fixture.buildId}/segments/aa.ndjson`;
  store.corrupt(key);
  await assert.rejects(
    publishRegionalBuild({
      artifactDirectory: fixture.root,
      store,
      activatedAt: ACTIVATED_AT,
      activatedBy: "release-reviewer",
    }),
    TrailPublicationError,
  );
  assert.equal(store.pointer().active.buildId, fixture.buildId);
});
