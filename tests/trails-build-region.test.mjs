import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ARTIFACT_FILENAMES,
  buildRegionFromFile,
  buildRegionArtifacts,
  compactSegmentProvenance,
  expandSegmentProvenance,
  writeRegionArtifacts,
} from "../scripts/trails/build-region.mjs";
import {
  validateAccessPoint,
  validateNamedTrail,
  validateTrailNode,
  validateTrailSegment,
} from "../scripts/trails/model.mjs";

const retrievedAt = "2026-08-03T12:00:00.000Z";
const sourceRef = (provider, sourceId) => ({
  provider,
  sourceId,
  retrievedAt,
  sourceUrl: `https://example.test/${provider}/${sourceId}`,
});

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

test("builds deterministic regional artifacts with canonical searchable trails", async () => {
  const first = await buildRegionArtifacts(buildInput());
  const reversed = await buildRegionArtifacts(buildInput([...segments].reverse()));

  assert.deepEqual(first.payloads, reversed.payloads);
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
  assert.match(first.qa.artifactHashes[ARTIFACT_FILENAMES.segments].sha256, /^[a-f0-9]{64}$/);
  assert.match(first.manifest.artifacts[ARTIFACT_FILENAMES.qa].sha256, /^[a-f0-9]{64}$/);
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
    const result = await buildRegionFromFile(inputPath, {
      outputDirectory: join(outputDirectory, "artifacts"),
    });
    assert.equal(result.segments.length, 5);
    assert.equal(result.qa.counts.input.bySource.nps.segments, 2);
    assert.equal(result.qa.counts.input.bySource.osm.segments, 3);
    assert.deepEqual(result.qa.issues, []);
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
    agencySnapshots: { nps: join(fixtureRoot, "gate-c/nps.json") },
    osmSnapshotPath: join(fixtureRoot, "gate-c/osm.json"),
    elevationGridPath: join(fixtureRoot, "gate-c/elevation-grid.json"),
  }));
  try {
    const result = await buildRegionFromFile(inputPath, {
      outputDirectory: join(outputDirectory, "artifacts"),
    });
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
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
});
