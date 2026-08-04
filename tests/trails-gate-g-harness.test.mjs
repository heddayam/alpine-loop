import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MAX_TRAIL_SEARCH_RESPONSE_BYTES } from "../app/trails/search.ts";
import { MAX_LOW_ZOOM_ACCESS_MARKERS } from "../app/trails/ui.ts";
import {
  buildRegionArtifacts,
  writeRegionArtifacts,
} from "../scripts/trails/build-region.mjs";
import {
  MAX_RUNTIME_SHARD_GZIP_BYTES,
  MAX_RUNTIME_SHARD_RAW_BYTES,
} from "../scripts/trails/artifact-contract.mjs";
import {
  GATE_G_LOW_ZOOM_MARKER_BUDGET,
  GATE_G_RESPONSE_BUDGET_BYTES,
  P6_FIXED_RUNTIME_OBJECT_READS,
  P6_RUNTIME_GEOMETRY_HARD_RAW_BYTES,
  P6_SELECTED_GEOMETRY_OBJECT_READS,
  assessTrailGeometrySize,
  renderGateGReport,
  verifyGateGEvidence,
} from "../scripts/trails/verify-gate-g.mjs";

const retrievedAt = "2026-08-04T00:00:00.000Z";

function sourceRef(sourceId) {
  return {
    provider: "fixture",
    sourceId,
    retrievedAt,
    sourceUrl: `https://example.test/${sourceId}`,
  };
}

function regionFixture(regionId, trailName = "Fixture Ridge Trail", segmentCount = 1) {
  const [longitude, latitude] = regionId === "tahoe-eldorado"
    ? [-120.1, 38.9]
    : [-122.1, 37.3];
  const coordinateStep = 0.0005;
  const sourceNodes = Array.from({ length: segmentCount + 1 }, (_, index) => ({
    id: `fixture-node-${index}`,
    longitude: longitude + index * coordinateStep,
    latitude: latitude + index * coordinateStep,
    sourceNodeIds: [`fixture:${index}`],
    incidentSegmentIds: [],
  }));
  const segmentCandidates = Array.from({ length: segmentCount }, (_, index) => ({
    id: `fixture-segment-${index}`,
    fromNodeId: `fixture-node-${index}`,
    toNodeId: `fixture-node-${index + 1}`,
    geometry: {
      type: "LineString",
      coordinates: [
        [longitude + index * coordinateStep, latitude + index * coordinateStep],
        [longitude + (index + 1) * coordinateStep, latitude + (index + 1) * coordinateStep],
      ],
    },
    name: trailName,
    manager: "Fixture Land Manager",
    hiking: "allowed",
    access: "public",
    status: "open",
    sourceRefs: [sourceRef(`segment-${index}`)],
  }));
  return {
    regionId,
    buildTimestamp: retrievedAt,
    segmentCandidates,
    sourceNodes,
    accessPointCandidates: [{
      longitude,
      latitude,
      name: "Fixture Trailhead",
      type: "trailhead",
      confidence: "official",
      connectedNodeIds: ["fixture-node-0"],
      sourceRefs: [sourceRef("access")],
    }],
    elevationSource: {
      metadata: { provider: "fixture", product: "synthetic elevation", version: "1" },
      interpolation: "fixture",
      sampleElevation(x, y) {
        return 500 + (x - longitude) * 1_000 + (y - latitude) * 1_000;
      },
    },
    qaDecision: { decision: "pass", decidedAt: retrievedAt, notes: [] },
  };
}

async function writeFixture(directory, input) {
  const build = await buildRegionArtifacts(input);
  await writeRegionArtifacts(build, directory);
  return build;
}

async function writeLinkedSearchIndex(directory, regionId, outputPath) {
  const manifestText = await readFile(join(directory, "manifest.json"), "utf8");
  const manifest = JSON.parse(manifestText);
  const named = JSON.parse(await readFile(join(directory, "named-trails.json"), "utf8"));
  const segmentIndex = JSON.parse(await readFile(join(directory, "segments/index.json"), "utf8"));
  const index = {
    schemaVersion: 1,
    regionId,
    source: {
      generatedAt: manifest.generatedAt,
      manifestSha256: createHash("sha256").update(manifestText).digest("hex"),
      namedTrailsSha256: manifest.artifacts["named-trails.json"].sha256,
      segmentsIndexSha256: manifest.artifacts["segments/index.json"].sha256,
      trailGeometryIndexSha256: manifest.artifacts["trail-geometry/index.json"].sha256,
      segmentPartitionPrefixLength: segmentIndex.partitioning.prefixLength,
    },
    trails: Object.fromEntries(named.trails.map(({ id }) => [id, {}])),
  };
  await writeFile(outputPath, `${JSON.stringify(index)}\n`);
  return outputPath;
}

test("keeps Gate G budget constants aligned with the reviewed product limits", () => {
  assert.equal(GATE_G_RESPONSE_BUDGET_BYTES, MAX_TRAIL_SEARCH_RESPONSE_BYTES);
  assert.equal(GATE_G_LOW_ZOOM_MARKER_BUDGET, MAX_LOW_ZOOM_ACCESS_MARKERS);
  assert.equal(P6_FIXED_RUNTIME_OBJECT_READS, 7);
  assert.equal(P6_SELECTED_GEOMETRY_OBJECT_READS, 1);
});

test("validates two identical v2 builds and emits a deterministic non-accepting report", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpine-gate-g-"));
  try {
    const buildA = join(root, "artifacts-a");
    const buildB = join(root, "artifacts-b");
    const accessEvidence = join(root, "access-evidence.json");
    const searchIndex = join(root, "search-index.json");
    await writeFixture(buildA, regionFixture("bay-midpen"));
    await writeFixture(buildB, regionFixture("bay-midpen"));
    await writeLinkedSearchIndex(buildA, "bay-midpen", searchIndex);
    await writeFile(accessEvidence, JSON.stringify({
      searchResponse: { regionId: "bay-midpen", count: 1, trails: [{ id: "fixture" }] },
      lowZoomMarkers: [{ id: "access-fixture" }],
    }));

    const evidence = await verifyGateGEvidence({
      regionId: "bay-midpen",
      buildA,
      buildB,
      accessEvidence,
      searchIndex,
      runtimeLimits: { totalObjectReads: 50, concurrentReads: 6 },
    });
    assert.equal(evidence.builds.comparison.byteIdentical, true);
    assert.equal(evidence.machineChecks.credibleConnectedAccess, true);
    assert.equal(evidence.machineChecks.accessBudgets, true);
    assert.equal(evidence.machineChecks.oneImmutableGeometryObjectPerTrail, true);
    assert.equal(evidence.machineChecks.runtimeRequestReadCeilings, true);
    assert.equal(evidence.machineChecks.searchIndexLinkage, true);
    assert.equal(evidence.runtimeDelivery.maximum.totalObjectReads, 8);
    assert.equal(evidence.runtimeDelivery.maximum.estimatedConcurrentReads, 1);
    assert.equal(evidence.gateGAccepted, false);
    assert.equal(evidence.tahoeFlagReview.required, false);
    const repeatedEvidence = await verifyGateGEvidence({
      regionId: "bay-midpen",
      buildA,
      buildB,
      accessEvidence,
      searchIndex,
      runtimeLimits: { totalObjectReads: 50, concurrentReads: 6 },
    });
    assert.deepEqual(repeatedEvidence, evidence);
    assert.equal(renderGateGReport(repeatedEvidence), renderGateGReport(evidence));
    assert.match(renderGateGReport(evidence), /Gate G accepted: \*\*NO\*\*/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fails closed when either artifact directory does not validate", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpine-gate-g-invalid-"));
  try {
    const buildA = join(root, "artifacts-a");
    const buildB = join(root, "artifacts-b");
    await writeFixture(buildA, regionFixture("bay-midpen"));
    await writeFixture(buildB, regionFixture("bay-midpen"));
    await writeFile(join(buildB, "named-trails.json"), "{}\n");

    await assert.rejects(
      verifyGateGEvidence({
        regionId: "bay-midpen",
        buildA,
        buildB,
        runtimeLimits: { totalObjectReads: 50, concurrentReads: 6 },
      }),
      /Invalid trail artifact directory: hash or size mismatch for named-trails\.json/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("blocks pre-extension v2 before treating segment shards as selected geometry", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpine-gate-g-legacy-v2-"));
  try {
    const buildA = join(root, "artifacts-a");
    const buildB = join(root, "artifacts-b");
    await writeFixture(buildA, regionFixture("bay-midpen", "Legacy Fanout Trail", 16));
    await writeFixture(buildB, regionFixture("bay-midpen", "Legacy Fanout Trail", 16));
    const manifestPath = join(buildA, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    delete manifest.delivery.lazyTrailGeometryIndex;
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);

    await assert.rejects(
      verifyGateGEvidence({
        regionId: "bay-midpen",
        buildA,
        buildB,
        runtimeLimits: { totalObjectReads: 50, concurrentReads: 6 },
      }),
      /pre-extension v2 build .* is blocked:.*legacy selected geometry reaches .*segment-shard objects/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("requires exact reviewed geometry exceptions and enforces the 16 MiB hard raw cap", () => {
  const path = "trail-geometry/aa/named-trail_aa11.ndjson";
  const targets = {
    rawBytes: MAX_RUNTIME_SHARD_RAW_BYTES,
    compressedBytes: MAX_RUNTIME_SHARD_GZIP_BYTES,
  };
  const metadata = {
    rawBytes: MAX_RUNTIME_SHARD_RAW_BYTES + 1,
    compressedBytes: MAX_RUNTIME_SHARD_GZIP_BYTES,
  };
  assert.equal(assessTrailGeometrySize(path, metadata, targets, []).pass, false);
  assert.equal(assessTrailGeometrySize(path, metadata, targets, [{
    path,
    ...metadata,
    note: "reviewed fixture exception",
  }]).pass, true);
  assert.equal(assessTrailGeometrySize(path, metadata, targets, [{
    path,
    rawBytes: metadata.rawBytes - 1,
    compressedBytes: metadata.compressedBytes,
    note: "stale exception",
  }]).pass, false);
  assert.equal(assessTrailGeometrySize(path, {
    rawBytes: P6_RUNTIME_GEOMETRY_HARD_RAW_BYTES + 1,
    compressedBytes: metadata.compressedBytes,
  }, targets, [{
    path,
    rawBytes: P6_RUNTIME_GEOMETRY_HARD_RAW_BYTES + 1,
    compressedBytes: metadata.compressedBytes,
    note: "cannot override the hard cap",
  }]).pass, false);
});

test("reports two valid but different artifact builds as non-identical", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpine-gate-g-diff-"));
  try {
    const buildA = join(root, "artifacts-a");
    const buildB = join(root, "artifacts-b");
    const searchIndex = join(root, "search-index.json");
    await writeFixture(buildA, regionFixture("bay-midpen"));
    await writeFixture(buildB, regionFixture("bay-midpen", "Changed Fixture Trail"));
    await writeLinkedSearchIndex(buildA, "bay-midpen", searchIndex);

    const evidence = await verifyGateGEvidence({
      regionId: "bay-midpen",
      buildA,
      buildB,
      searchIndex,
      runtimeLimits: { totalObjectReads: 50, concurrentReads: 6 },
    });
    assert.equal(evidence.builds.comparison.byteIdentical, false);
    assert.equal(evidence.machineChecks.byteIdentical, false);
    assert.equal(evidence.machineChecks.accessBudgets, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("blocks a search index without the exact trail geometry index linkage", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpine-gate-g-search-link-"));
  try {
    const buildA = join(root, "artifacts-a");
    const buildB = join(root, "artifacts-b");
    const searchIndex = join(root, "search-index.json");
    await writeFixture(buildA, regionFixture("bay-midpen"));
    await writeFixture(buildB, regionFixture("bay-midpen"));
    await writeLinkedSearchIndex(buildA, "bay-midpen", searchIndex);
    const unlinked = JSON.parse(await readFile(searchIndex, "utf8"));
    unlinked.source.trailGeometryIndexSha256 = "0".repeat(64);
    await writeFile(searchIndex, `${JSON.stringify(unlinked)}\n`);

    const evidence = await verifyGateGEvidence({
      regionId: "bay-midpen",
      buildA,
      buildB,
      searchIndex,
      runtimeLimits: { totalObjectReads: 50, concurrentReads: 6 },
    });
    assert.equal(evidence.searchIndex.checks.trailGeometryIndexSha256, false);
    assert.equal(evidence.machineChecks.searchIndexLinkage, false);
    assert.match(renderGateGReport(evidence), /Search-index artifact linkage.*BLOCKED/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("uses one selected object even when canonical segments span many routing shards", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpine-gate-g-fanout-"));
  try {
    const buildA = join(root, "artifacts-a");
    const buildB = join(root, "artifacts-b");
    const searchIndex = join(root, "search-index.json");
    await writeFixture(buildA, regionFixture("bay-midpen", "Fanout Trail", 32));
    await writeFixture(buildB, regionFixture("bay-midpen", "Fanout Trail", 32));
    await writeLinkedSearchIndex(buildA, "bay-midpen", searchIndex);

    const evidence = await verifyGateGEvidence({
      regionId: "bay-midpen",
      buildA,
      buildB,
      searchIndex,
      runtimeLimits: { totalObjectReads: 50, concurrentReads: 6 },
    });
    assert.ok(evidence.runtimeDelivery.maximumCanonicalSegmentShardFanout.shards > 1);
    assert.equal(evidence.runtimeDelivery.maximum.geometryObjectReads, 1);
    assert.equal(evidence.machineChecks.oneImmutableGeometryObjectPerTrail, true);
    assert.equal(evidence.machineChecks.runtimeRequestReadCeilings, true);
    assert.match(renderGateGReport(evidence), /One immutable geometry object.*PASS/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("always renders Tahoe's explicit edge and aggregate flag disposition", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpine-gate-g-tahoe-"));
  try {
    const buildA = join(root, "artifacts-a");
    const buildB = join(root, "artifacts-b");
    const searchIndex = join(root, "search-index.json");
    await writeFixture(buildA, regionFixture("tahoe-eldorado"));
    await writeFixture(buildB, regionFixture("tahoe-eldorado"));
    await writeLinkedSearchIndex(buildA, "tahoe-eldorado", searchIndex);

    const evidence = await verifyGateGEvidence({
      regionId: "tahoe-eldorado",
      buildA,
      buildB,
      searchIndex,
      runtimeLimits: { totalObjectReads: 50, concurrentReads: 6 },
    });
    assert.deepEqual(evidence.tahoeFlagReview, {
      required: true,
      t8BaselineEdgeFlags: 35,
      t8BaselineAggregateFlags: 1,
      observedEdgeFlags: 0,
      observedAggregateFlags: 0,
      disposition: null,
    });
    const report = renderGateGReport(evidence);
    assert.match(report, /Tahoe–Eldorado required flag disposition/);
    assert.match(report, /T8 baseline: 35/);
    assert.match(report, /T8 baseline: 1/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a non-P8 region and reuse of one build directory", async () => {
  await assert.rejects(
    verifyGateGEvidence({ regionId: "yosemite-stanislaus", buildA: "a", buildB: "b" }),
    /region must be one of/,
  );
  await assert.rejects(
    verifyGateGEvidence({ regionId: "bay-midpen", buildA: "same", buildB: "same" }),
    /two distinct build directories/,
  );
});

test("requires explicit deployment-plan request ceilings", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpine-gate-g-limits-"));
  try {
    const buildA = join(root, "artifacts-a");
    const buildB = join(root, "artifacts-b");
    await writeFixture(buildA, regionFixture("bay-midpen"));
    await writeFixture(buildB, regionFixture("bay-midpen"));
    await assert.rejects(
      verifyGateGEvidence({ regionId: "bay-midpen", buildA, buildB }),
      /max total object reads must be a positive integer/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
