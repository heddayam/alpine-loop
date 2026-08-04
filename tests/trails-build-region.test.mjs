import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";
import {
  ARTIFACT_FILENAMES,
  buildNamedTrails,
  buildRegionFromFile,
  buildRegionArtifacts,
  compactSegmentProvenance,
  createBuildStageTelemetry,
  expandSegmentProvenance,
  writeRegionArtifacts,
} from "../scripts/trails/build-region.mjs";
import {
  validateAccessPoint,
  validateNamedTrail,
  validateTrailNode,
  validateTrailSegment,
} from "../scripts/trails/model.mjs";
import { validateArtifactDirectory } from "../scripts/trails/validate-artifacts.mjs";
import { enforceRuntimeShardSizeTargets } from "../scripts/trails/artifact-contract.mjs";

const retrievedAt = "2026-08-03T12:00:00.000Z";
const sourceRef = (provider, sourceId) => ({
  provider,
  sourceId,
  retrievedAt,
  sourceUrl: `https://example.test/${provider}/${sourceId}`,
});

const digest = (content) => createHash("sha256").update(content).digest("hex");

async function artifactFiles(directory, relative = "") {
  const files = {};
  for (const entry of await readdir(join(directory, relative), { withFileTypes: true })) {
    const filename = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) Object.assign(files, await artifactFiles(directory, filename));
    else files[filename] = await readFile(join(directory, filename));
  }
  return files;
}

function segment({ id, fromNodeId, toNodeId, coordinates, name, manager, source = "osm" }) {
  return {
    id,
    fromNodeId,
    toNodeId,
    geometry: { type: "LineString", coordinates },
    ...(name ? { name } : {}),
    ...(manager ? { manager } : {}),
    hiking: "allowed",
    access: "public",
    status: "open",
    sourceRefs: [sourceRef(source, `${source}/${id}`)],
  };
}

const segments = [
  segment({
    id: "summit-west",
    fromNodeId: "node-1",
    toNodeId: "node-2",
    coordinates: [[-119.721, 37.805], [-119.7208, 37.805]],
    name: "Summit Trail",
    manager: "Yosemite National Park",
  }),
  segment({
    id: "summit-east",
    fromNodeId: "node-2",
    toNodeId: "node-3",
    coordinates: [[-119.7208, 37.805], [-119.7206, 37.805]],
    name: "Summit Trail",
    manager: "Yosemite National Park",
  }),
  segment({
    id: "unnamed",
    fromNodeId: "node-4",
    toNodeId: "node-5",
    coordinates: [[-119.7204, 37.8049], [-119.7202, 37.8049]],
  }),
];

const sourceNodes = [
  ["node-1", -119.721, 37.805],
  ["node-2", -119.7208, 37.805],
  ["node-3", -119.7206, 37.805],
  ["node-4", -119.7204, 37.8049],
  ["node-5", -119.7202, 37.8049],
].map(([id, longitude, latitude], index) => ({
  id,
  longitude,
  latitude,
  sourceNodeIds: [`osm:${index + 1}`],
  incidentSegmentIds: [],
}));

const elevationSource = {
  metadata: {
    provider: "USGS",
    product: "3DEP 1/3 arc-second DEM",
    version: "build-test-1",
  },
  interpolation: "synthetic-test",
  sampleElevation(longitude, latitude) {
    return 1_000 + (longitude + 119.721) * 10_000 + (latitude - 37.805) * 1_000;
  },
};

function buildInput(segmentCandidates = segments) {
  return {
    regionId: "yosemite-stanislaus",
    segmentCandidates,
    sourceNodes,
    accessPointCandidates: [{
      longitude: -119.721,
      latitude: 37.805,
      name: "Summit Trailhead",
      type: "trailhead",
      confidence: "official",
      connectedNodeIds: ["node-1"],
      sourceRefs: [sourceRef("nps", "trailhead/summit")],
    }],
    elevationSource,
  };
}

function legacyReachableNodes(point, graphSegments, maximumMeters = 2_000) {
  const adjacency = new Map();
  for (const graphSegment of graphSegments.filter(({ hiking, access, status }) =>
    hiking !== "blocked" && access !== "private" && status !== "closed")) {
    for (const [from, to] of [
      [graphSegment.fromNodeId, graphSegment.toNodeId],
      [graphSegment.toNodeId, graphSegment.fromNodeId],
    ]) {
      const edges = adjacency.get(from) ?? [];
      edges.push({ to, lengthMeters: graphSegment.lengthMeters });
      adjacency.set(from, edges);
    }
  }
  const distances = new Map(point.connectedNodeIds.map((id) => [id, 0]));
  const pending = point.connectedNodeIds.map((id) => ({ id, distance: 0 }));
  while (pending.length > 0) {
    pending.sort((left, right) => left.distance - right.distance ||
      left.id.localeCompare(right.id));
    const current = pending.shift();
    if (current.distance !== distances.get(current.id) || current.distance > maximumMeters) {
      continue;
    }
    for (const edge of adjacency.get(current.id) ?? []) {
      const distance = current.distance + edge.lengthMeters;
      if (distance > maximumMeters || distance >= (distances.get(edge.to) ?? Infinity)) continue;
      distances.set(edge.to, distance);
      pending.push({ id: edge.to, distance });
    }
  }
  return new Set(distances.keys());
}

function directGraphSegment(index, {
  from = `scale-node-${index}`,
  to = `scale-node-${index + 1}`,
  lengthMeters = 10,
  name = "Scale Trail",
  manager = "Test Manager",
  hiking = "allowed",
  access = "public",
  status = "open",
} = {}) {
  return {
    id: `scale-segment-${String(index).padStart(5, "0")}`,
    fromNodeId: from,
    toNodeId: to,
    geometry: {
      type: "LineString",
      coordinates: [
        [-120 + index * 0.000001, 37],
        [-120 + (index + 1) * 0.000001, 37],
      ],
    },
    name,
    manager,
    hiking,
    access,
    status,
    lengthMeters,
    sourceRefs: [sourceRef("test", `scale/${index}`)],
  };
}

test("builds deterministic regional artifacts with canonical searchable trails", async () => {
  const first = await buildRegionArtifacts(buildInput());
  const telemetryEvents = [];
  const reversed = await buildRegionArtifacts(buildInput([...segments].reverse()), {
    telemetry: createBuildStageTelemetry({ emit: (event) => telemetryEvents.push(event) }),
  });

  assert.deepEqual(first.payloads, reversed.payloads);
  assert.deepEqual(
    [...new Set(telemetryEvents.map(({ stage }) => stage))],
    [
      "agency-osm-reconciliation-merge",
      "elevation-enrichment",
      "provenance-preparation",
      "node-access-named-trail-construction",
      "partitioning",
      "provenance-compaction",
      "json-serialization",
      "hashing",
      "compression-measurement",
      "qa",
    ],
  );
  assert.deepEqual(telemetryEvents.map(({ sequence }) => sequence),
    telemetryEvents.map((_, index) => index + 1));
  assert.ok(telemetryEvents.every(({ memory }) =>
    ["heapUsed", "heapTotal", "external", "rss"].every((field) =>
      Number.isFinite(memory[field]))));
  assert.equal(first.segments.length, 3);
  assert.equal(first.nodes.length, 5);
  assert.equal(first.accessPoints.length, 1);
  assert.equal(first.namedTrails.length, 1);
  assert.deepEqual(first.namedTrails[0].segmentIds.length, 2);
  assert.deepEqual(first.namedTrails[0].accessPointIds, [first.accessPoints[0].id]);
  assert.equal(first.namedTrails[0].dataConfidence, "high");
  assert.ok(first.namedTrails[0].lengthMeters > 0);
  first.segments.forEach(validateTrailSegment);
  first.nodes.forEach(validateTrailNode);
  first.accessPoints.forEach(validateAccessPoint);
  first.namedTrails.forEach(validateNamedTrail);

  assert.equal(first.qa.counts.input.bySource.osm.segments, 3);
  assert.equal(first.qa.segments.named, 2);
  assert.equal(first.qa.segments.unnamed, 1);
  assert.deepEqual(first.qa.segments.hiking, { allowed: 3, blocked: 0, unknown: 0 });
  assert.deepEqual(first.qa.segments.access, { public: 3, private: 0, unknown: 0 });
  assert.equal(first.qa.graph.connectedComponents, 2);
  assert.equal(first.qa.graph.isolatedSegments, 1);
  assert.deepEqual(first.qa.accessPoints, { official: 1, mapped: 0, derived: 0 });
  assert.equal(first.qa.elevation.completeSegments, 3);
  assert.deepEqual(first.qa.elevation.shortSegmentGradeChecksSkipped, []);
  assert.equal(
    first.qa.elevation.aggregateWindows.method,
    "shortest-path-endpoint-elevation-windows",
  );
  assert.equal(first.qa.elevation.implausibleMetricOutliers.length, 0);
  const provenanceEnd = telemetryEvents.find(({ stage, phase }) =>
    stage === "provenance-preparation" && phase === "end");
  assert.equal(provenanceEnd.counts.reusedMergeProvenance, 1);
  assert.equal(provenanceEnd.counts.sharedElevationSourceFields, 1);
  const elevationSourceFields = Object.values(first.segmentProvenance).flatMap((fields) =>
    Object.values(fields).flat().filter(({ provider }) => provider === "USGS")
      .map(({ sourceField }) => sourceField));
  assert.ok(elevationSourceFields.length > 1);
  assert.ok(elevationSourceFields.every((value) => value === elevationSourceFields[0]));
  assert.match(first.qa.artifactHashes[ARTIFACT_FILENAMES.segments].sha256, /^[a-f0-9]{64}$/);
  assert.match(first.manifest.artifacts[ARTIFACT_FILENAMES.qa].sha256, /^[a-f0-9]{64}$/);
  assert.equal(first.manifest.schemaVersion, 2);
  assert.match(first.manifest.buildId, /^build_[a-f0-9]{32}$/);
  assert.equal(first.manifest.delivery.partitioning.prefixLength, 2);
  assert.ok(Object.keys(JSON.parse(first.payloads[ARTIFACT_FILENAMES.segments]).shards)
    .every((prefix) => prefix.length === 2));
  assert.deepEqual(first.manifest.decisions, {
    qa: { decision: "pending", decidedAt: null, notes: [] },
    review: { decision: "pending", reviewer: null, decidedAt: null, notes: [] },
  });
  assert.equal(first.manifest.artifacts[ARTIFACT_FILENAMES.segments].role, "runtime");
  assert.equal(first.manifest.artifacts[ARTIFACT_FILENAMES.qa].role, "diagnostic");
});

test("matches legacy named-trail reachability under deterministic input reorderings", () => {
  const graphSegments = [
    directGraphSegment(0, { from: "node-0", to: "node-1", lengthMeters: 600 }),
    directGraphSegment(1, { from: "node-1", to: "node-2", lengthMeters: 600 }),
    directGraphSegment(2, {
      from: "node-2",
      to: "node-3",
      lengthMeters: 600,
      name: null,
    }),
    directGraphSegment(3, { from: "node-3", to: "node-4", lengthMeters: 600 }),
    directGraphSegment(4, { from: "node-4", to: "node-5", lengthMeters: 600 }),
    directGraphSegment(5, {
      from: "node-5",
      to: "node-6",
      lengthMeters: 1,
      hiking: "blocked",
    }),
  ];
  const accessPoints = [
    { id: "access-west", connectedNodeIds: ["node-0"], confidence: "official" },
    { id: "access-east", connectedNodeIds: ["node-5"], confidence: "mapped" },
    { id: "access-blocked", connectedNodeIds: ["node-6"], confidence: "derived" },
  ];
  const first = buildNamedTrails(graphSegments, accessPoints);
  const reordered = buildNamedTrails([...graphSegments].reverse(), [...accessPoints].reverse());
  assert.deepEqual(reordered, first);
  assert.equal(first.length, 2);

  const byId = new Map(graphSegments.map((graphSegment) => [graphSegment.id, graphSegment]));
  for (const trail of first) {
    const trailNodeIds = new Set(trail.segmentIds.flatMap((id) => {
      const graphSegment = byId.get(id);
      return [graphSegment.fromNodeId, graphSegment.toNodeId];
    }));
    const expected = accessPoints.filter((point) =>
      [...trailNodeIds].some((nodeId) =>
        legacyReachableNodes(point, graphSegments).has(nodeId)))
      .map(({ id }) => id).sort();
    assert.deepEqual(trail.accessPointIds, expected);
  }
});

test("keeps the legacy lexical component seed for normalized-equal display fields", () => {
  const lexicalFirst = directGraphSegment(10, {
    from: "display-node-0",
    to: "display-node-1",
    name: "Scale Trail",
    manager: "Test Manager",
  });
  const lexicalSecond = directGraphSegment(11, {
    from: "display-node-1",
    to: "display-node-2",
    name: "  SCALE   TRAIL ",
    manager: "TEST MANAGER",
  });
  const accessPoints = [{
    id: "display-access",
    connectedNodeIds: ["display-node-0"],
    confidence: "official",
  }];

  const forward = buildNamedTrails([lexicalFirst, lexicalSecond], accessPoints);
  const reversed = buildNamedTrails([lexicalSecond, lexicalFirst], accessPoints);
  assert.deepEqual(reversed, forward);
  assert.equal(forward.length, 1);
  assert.equal(forward[0].name, lexicalFirst.name);
  assert.equal(forward[0].manager, lexicalFirst.manager);
});

test("bounds named-trail reachability to one indexed traversal on a scale fixture", () => {
  const graphSegments = Array.from({ length: 4_000 }, (_, index) =>
    directGraphSegment(index));
  const accessPoints = Array.from({ length: 1_000 }, (_, index) => ({
    id: `scale-access-${String(index).padStart(4, "0")}`,
    connectedNodeIds: [`scale-node-${index * 4}`],
    confidence: "mapped",
  }));
  const checkpoints = [];
  const trails = buildNamedTrails(graphSegments, accessPoints, (phase, counts) => {
    checkpoints.push({ phase, counts: { ...counts } });
  });
  const final = checkpoints.at(-1);

  assert.equal(trails.length, 1);
  assert.equal(trails[0].accessPointIds.length, accessPoints.length);
  assert.deepEqual(checkpoints.map(({ phase }) => phase), ["component-index", "reachability"]);
  assert.equal(final.counts.accessPointsProcessed, accessPoints.length);
  assert.equal(final.counts.retainedReachabilitySets, 0);
  assert.equal(final.counts.accessPointComponentAssociations, accessPoints.length);
  assert.ok(final.counts.reachableNodeVisits > 300_000);
  assert.ok(final.counts.maximumReachableNodesPerPoint <= 401);
  assert.ok(final.counts.maximumPendingReachabilityNodes <= 2);
});

test("emits deterministic telemetry structure with injected measurements", () => {
  const events = [];
  const times = [100, 105, 112];
  const telemetry = createBuildStageTelemetry({
    emit: (event) => events.push(event),
    now: () => times.shift(),
    memoryUsage: () => ({
      heapUsed: 10,
      heapTotal: 20,
      external: 30,
      rss: 40,
      arrayBuffers: 5,
    }),
  });
  const stage = telemetry.start("fixture-stage", { z: 2, a: 1 }, ["z-copy", "a-copy"]);
  telemetry.sample(stage, { records: 3 });
  telemetry.end(stage, { records: 4 });

  assert.deepEqual(events, [
    {
      schemaVersion: 1,
      sequence: 1,
      stage: "fixture-stage",
      phase: "begin",
      elapsedMs: 0,
      counts: { a: 1, z: 2 },
      memory: { heapUsed: 10, heapTotal: 20, external: 30, rss: 40, arrayBuffers: 5 },
      structures: ["a-copy", "z-copy"],
    },
    {
      schemaVersion: 1,
      sequence: 2,
      stage: "fixture-stage",
      phase: "sample",
      elapsedMs: 5,
      counts: { records: 3 },
      memory: { heapUsed: 10, heapTotal: 20, external: 30, rss: 40, arrayBuffers: 5 },
      structures: ["a-copy", "z-copy"],
    },
    {
      schemaVersion: 1,
      sequence: 3,
      stage: "fixture-stage",
      phase: "end",
      elapsedMs: 12,
      counts: { records: 4 },
      memory: { heapUsed: 10, heapTotal: 20, external: 30, rss: 40, arrayBuffers: 5 },
      structures: ["a-copy", "z-copy"],
    },
  ]);
});

test("requires explicit notes for runtime shards above either size target", () => {
  const artifacts = {
    "segments/ab.ndjson": { bytes: 101, gzipBytes: 40 },
    "segments/cd.ndjson": { bytes: 90, gzipBytes: 51 },
  };
  const paths = Object.keys(artifacts);
  const targets = { rawBytes: 100, compressedBytes: 50 };
  assert.throws(
    () => enforceRuntimeShardSizeTargets(artifacts, paths, {}, targets),
    /add an explicit shardSizeExceptions note/,
  );
  assert.deepEqual(enforceRuntimeShardSizeTargets(artifacts, paths, {
    "segments/ab.ndjson": "Worker review measured safe memory behavior.",
    "segments/cd.ndjson": "API review accepted the compressed transfer size.",
  }, targets), [
    {
      path: "segments/ab.ndjson",
      rawBytes: 101,
      compressedBytes: 40,
      note: "Worker review measured safe memory behavior.",
    },
    {
      path: "segments/cd.ndjson",
      rawBytes: 90,
      compressedBytes: 51,
      note: "API review accepted the compressed transfer size.",
    },
  ]);
});

test("round-trips dictionary-compacted field provenance", async () => {
  const result = await buildRegionArtifacts(buildInput());
  const compact = compactSegmentProvenance(result.segmentProvenance);
  assert.deepEqual(expandSegmentProvenance(compact), result.segmentProvenance);
  assert.equal(compact.schemaVersion, 2);
  assert.ok(JSON.stringify(compact).length < JSON.stringify({
    schemaVersion: 1,
    segments: result.segmentProvenance,
  }).length);
});

test("omits unconnected names and unavailable elevation metrics", async () => {
  const result = await buildRegionArtifacts({
    ...buildInput(),
    accessPointCandidates: [],
    elevationSource: undefined,
  });

  assert.deepEqual(result.namedTrails, []);
  assert.equal(result.qa.elevation.completeSegments, 0);
  assert.equal(result.qa.elevation.missingSegments, 3);
  assert.deepEqual(result.manifest.elevation, {
    available: false,
    missingCoverage: "omit-segment-elevation-metrics",
  });
  for (const builtSegment of result.segments) {
    assert.equal(builtSegment.ascentForwardMeters, undefined);
    assert.equal(builtSegment.maxGradePct, undefined);
  }
});

test("writes the complete artifact contract without network access", async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error("regional builds must stay offline");
  };
  const outputDirectory = await mkdtemp(join(tmpdir(), "alpine-trails-build-"));
  try {
    const result = await buildRegionArtifacts(buildInput());
    await writeRegionArtifacts(result, outputDirectory);
    const validation = await validateArtifactDirectory(outputDirectory);
    assert.equal(validation.buildId, result.manifest.buildId);
    assert.deepEqual(
      Object.values(ARTIFACT_FILENAMES).sort(),
      [
        "access-points.geojson",
        "manifest.json",
        "named-trails.json",
        "nodes.ndjson",
        "qa.json",
        "segment-provenance/index.json",
        "segments/index.json",
      ],
    );
    for (const filename of Object.values(ARTIFACT_FILENAMES)) {
      assert.equal(await readFile(join(outputDirectory, filename), "utf8"), result.payloads[filename]);
    }
    const segmentShard = Object.keys(result.payloads).find((path) =>
      /^segments\/[0-9a-f]{2}\.ndjson$/.test(path));
    await writeFile(join(outputDirectory, segmentShard), "corrupt\n");
    await assert.rejects(validateArtifactDirectory(outputDirectory), /hash or size mismatch/);
    await writeFile(join(outputDirectory, segmentShard), result.payloads[segmentShard]);
    const invalidManifest = structuredClone(result.manifest);
    invalidManifest.artifacts[segmentShard].application = "optional";
    await writeFile(join(outputDirectory, "manifest.json"), JSON.stringify(invalidManifest));
    await assert.rejects(validateArtifactDirectory(outputDirectory), /invalid v2 metadata/);
  } finally {
    globalThis.fetch = previousFetch;
    await rm(outputDirectory, { recursive: true, force: true });
  }
});

test("removes stale managed artifacts without touching unrelated output files", async () => {
  const outputDirectory = await mkdtemp(join(tmpdir(), "alpine-trails-cleanup-"));
  try {
    await mkdir(join(outputDirectory, "segments"), { recursive: true });
    await writeFile(join(outputDirectory, "segments.ndjson"), "legacy segments\n");
    await writeFile(join(outputDirectory, "segments", "f.ndjson"), "stale shard\n");
    await writeFile(join(outputDirectory, "segments", "notes.ndjson"), "keep shard notes\n");
    await writeFile(join(outputDirectory, "review-notes.txt"), "keep review notes\n");

    await writeRegionArtifacts({ payloads: { "manifest.json": "{}\n" } }, outputDirectory);

    await assert.rejects(readFile(join(outputDirectory, "segments.ndjson")), { code: "ENOENT" });
    await assert.rejects(readFile(join(outputDirectory, "segments", "f.ndjson")), {
      code: "ENOENT",
    });
    assert.equal(
      await readFile(join(outputDirectory, "segments", "notes.ndjson"), "utf8"),
      "keep shard notes\n",
    );
    assert.equal(
      await readFile(join(outputDirectory, "review-notes.txt"), "utf8"),
      "keep review notes\n",
    );
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
});

test("composes cached agency and OSM snapshots from a regional input file", async () => {
  const outputDirectory = await mkdtemp(join(tmpdir(), "alpine-trails-snapshots-"));
  const inputPath = join(outputDirectory, "build-input.json");
  const fixtureRoot = new URL("./fixtures/trails/", import.meta.url).pathname;
  await writeFile(inputPath, JSON.stringify({
    regionId: "yosemite-stanislaus",
    agencySnapshots: {
      nps: join(fixtureRoot, "agencies/nps.json"),
    },
    osmSnapshotPath: join(fixtureRoot, "osm/topology.json"),
    accessPointCandidates: [],
  }));
  try {
    const telemetryEvents = [];
    const result = await buildRegionFromFile(inputPath, {
      outputDirectory: join(outputDirectory, "artifacts"),
      telemetry: createBuildStageTelemetry({ emit: (event) => telemetryEvents.push(event) }),
    });
    assert.equal(result.segments.length, 5);
    assert.equal(result.qa.counts.input.bySource.nps.segments, 2);
    assert.equal(result.qa.counts.input.bySource.osm.segments, 3);
    assert.deepEqual(result.qa.issues, []);
    const stages = new Set(telemetryEvents.map(({ stage }) => stage));
    assert.equal(stages.has("snapshot-loading-normalization"), true);
    assert.equal(stages.has("osm-topology-construction"), true);
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
});

test("omits and reports records outside configured regional bounds", async () => {
  const result = await buildRegionArtifacts(buildInput([
    ...segments,
    segment({
      id: "outside-region",
      fromNodeId: "outside-1",
      toNodeId: "outside-2",
      coordinates: [[-118.1, 35.1], [-118.09, 35.11]],
      name: "Wrong Region Trail",
    }),
  ]));

  assert.equal(result.segments.some(({ name }) => name === "Wrong Region Trail"), false);
  assert.equal(result.qa.regionalFiltering.rule, "omit-unless-fully-contained");
  assert.equal(result.qa.regionalFiltering.omittedSegments, 1);
  assert.equal(result.qa.issues.some(({ type, recordId }) =>
    type === "out-of-region-record" && recordId === "outside-region"), true);
});

test("reconciles agency granularity, ingests OSM access, and ships field provenance", async () => {
  const outputDirectory = await mkdtemp(join(tmpdir(), "alpine-trails-gate-c-"));
  const inputPath = join(outputDirectory, "build-input.json");
  const fixtureRoot = new URL("./fixtures/trails/", import.meta.url).pathname;
  await writeFile(inputPath, JSON.stringify({
    regionId: "yosemite-stanislaus",
    artifactSchemaVersion: 1,
    agencySnapshots: { nps: join(fixtureRoot, "gate-c/nps.json") },
    osmSnapshotPath: join(fixtureRoot, "gate-c/osm.json"),
    elevationGridPath: join(fixtureRoot, "gate-c/elevation-grid.json"),
  }));
  try {
    const telemetryEvents = [];
    const result = await buildRegionFromFile(inputPath, {
      outputDirectory: join(outputDirectory, "artifacts"),
      telemetry: createBuildStageTelemetry({ emit: (event) => telemetryEvents.push(event) }),
    });
    assert.equal(result.payloads, undefined);
    assert.equal(result.qa.counts.input.bySource.nps.segments, 1);
    assert.equal(result.qa.counts.input.bySource.osm.segments, 2);
    assert.deepEqual(result.qa.reconciliation, {
      reconciledAgencySegments: 1,
      emittedAgencyEdges: 2,
    });
    assert.equal(result.segments.length, 2);
    assert.equal(result.namedTrails.length, 1);
    assert.ok(result.namedTrails[0].accessPointIds.length >= 1);
    assert.ok(result.accessPoints.some(({ name }) => name === "Mirror Lake Trailhead"));
    assert.equal(result.qa.elevation.completeSegments, 2);
    assert.deepEqual(result.qa.elevation.implausibleMetricOutliers, []);
    assert.deepEqual(result.qa.merge.details, []);
    assert.deepEqual(result.qa.snapping.details, []);

    const nodesById = new Map(result.nodes.map((node) => [node.id, node]));
    for (const builtSegment of result.segments) {
      assert.deepEqual(builtSegment.geometry.coordinates[0], [
        nodesById.get(builtSegment.fromNodeId).longitude,
        nodesById.get(builtSegment.fromNodeId).latitude,
      ]);
      assert.deepEqual(builtSegment.geometry.coordinates.at(-1), [
        nodesById.get(builtSegment.toNodeId).longitude,
        nodesById.get(builtSegment.toNodeId).latitude,
      ]);
      assert.ok(result.segmentProvenance[builtSegment.id].geometry.some(({ selected }) => selected));
      assert.equal(result.segmentProvenance[builtSegment.id].maxGradePct[0].provider, "USGS");
    }
    assert.equal(result.qa.provenance.missingSegmentIds.length, 0);

    const files = await artifactFiles(join(outputDirectory, "artifacts"));
    assert.equal(
      digest(files[ARTIFACT_FILENAMES.manifest]),
      "b66ea987c456141292bb2a08357b7e3f83e308decb2c6a615b1107b0faf0e43c",
      "Yosemite Gate C v1 manifest bytes must match the accepted pre-P2 builder",
    );
    assert.deepEqual(await validateArtifactDirectory(join(outputDirectory, "artifacts")), {
      schemaVersion: 1,
      regionId: "yosemite-stanislaus",
      files: Object.keys(result.manifest.artifacts).length,
    });
    for (const [filename, metadata] of Object.entries(result.manifest.artifacts)) {
      assert.equal(files[filename].byteLength, metadata.bytes, `${filename} raw bytes`);
      assert.equal(gzipSync(files[filename], { level: 9 }).byteLength, metadata.gzipBytes,
        `${filename} gzip bytes`);
      assert.equal(digest(files[filename]), metadata.sha256, `${filename} sha256`);
    }
    const serializationEvents = telemetryEvents.filter(({ stage }) =>
      stage === "json-serialization");
    assert.ok(serializationEvents.length > 2);
    assert.ok(serializationEvents.every(({ counts }) =>
      counts.retainedSerializedBytes === undefined || counts.retainedSerializedBytes === 0));
    const serializationEnd = serializationEvents.find(({ phase }) => phase === "end");
    assert.ok(serializationEnd.counts.serializedBytes > serializationEnd.counts.peakChunkBytes);
    assert.ok(serializationEvents.every(({ structures }) =>
      !structures.includes("serialized-artifact-strings") &&
      !structures.includes("synchronous-gzip-buffer")));
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
});

test("streams deterministic output and keeps the prior complete tree on injected failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpine-trails-atomic-"));
  const fixtureRoot = new URL("./fixtures/trails/", import.meta.url).pathname;
  const inputPath = join(root, "build-input.json");
  const firstOutput = join(root, "first");
  const secondOutput = join(root, "second");
  const protectedOutput = join(root, "protected");
  await writeFile(inputPath, JSON.stringify({
    regionId: "yosemite-stanislaus",
    agencySnapshots: { nps: join(fixtureRoot, "gate-c/nps.json") },
    osmSnapshotPath: join(fixtureRoot, "gate-c/osm.json"),
    elevationGridPath: join(fixtureRoot, "gate-c/elevation-grid.json"),
  }));
  try {
    await buildRegionFromFile(inputPath, { outputDirectory: firstOutput });
    await buildRegionFromFile(inputPath, { outputDirectory: secondOutput });
    assert.deepEqual(await artifactFiles(firstOutput), await artifactFiles(secondOutput));

    await mkdir(join(protectedOutput, "segments"), { recursive: true });
    await writeFile(join(protectedOutput, "manifest.json"), "{\"complete\":\"old\"}\n");
    await writeFile(join(protectedOutput, "segments.ndjson"), "obsolete monolith\n");
    await writeFile(join(protectedOutput, "segments", "f.ndjson"), "old managed shard\n");
    await writeFile(join(protectedOutput, "segments", "notes.ndjson"), "unrelated notes\n");
    await writeFile(join(protectedOutput, "review-notes.txt"), "human review\n");
    const before = await artifactFiles(protectedOutput);

    await assert.rejects(buildRegionFromFile(inputPath, {
      outputDirectory: protectedOutput,
      async beforeArtifact({ filename, artifactCount, stagingDirectory }) {
        if (artifactCount === 1) {
          await assert.rejects(readFile(join(stagingDirectory, "segments.ndjson")), {
            code: "ENOENT",
          });
          await assert.rejects(readFile(join(stagingDirectory, "segments", "f.ndjson")), {
            code: "ENOENT",
          });
          assert.equal(
            await readFile(join(stagingDirectory, "segments", "notes.ndjson"), "utf8"),
            "unrelated notes\n",
          );
        }
        if (filename === ARTIFACT_FILENAMES.manifest) throw new Error("injected manifest failure");
      },
    }), /injected manifest failure/);

    assert.deepEqual(await artifactFiles(protectedOutput), before);
    assert.deepEqual(
      (await readdir(root)).filter((name) => name.startsWith(".protected.tmp-")),
      [],
    );

    await assert.rejects(buildRegionFromFile(inputPath, {
      outputDirectory: protectedOutput,
      beforeActivation() {
        throw new Error("injected staging activation failure");
      },
    }), /injected staging activation failure/);
    assert.deepEqual(await artifactFiles(protectedOutput), before);
    assert.deepEqual(
      (await readdir(root)).filter((name) =>
        name.startsWith(".protected.tmp-") || name.startsWith(".protected.old-")),
      [],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
