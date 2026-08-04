#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { finished } from "node:stream/promises";
import {
  MAX_RUNTIME_SHARD_GZIP_BYTES,
  MAX_RUNTIME_SHARD_RAW_BYTES,
  partitionPrefixLength,
  segmentPartitionKey,
} from "./artifact-contract.mjs";
import { requireRegion } from "./regions.mjs";
import { validateArtifactDirectory } from "./validate-artifacts.mjs";

export const P8_REGION_IDS = Object.freeze([
  "bay-midpen",
  "bay-east",
  "sierra-national-forest",
  "tahoe-eldorado",
]);

export const GATE_G_RESPONSE_BUDGET_BYTES = 448 * 1024;
export const GATE_G_LOW_ZOOM_MARKER_BUDGET = 200;

// The current P6 adapter reads current.json, the manifest, and four runtime
// metadata objects before selected geometry. These are implementation
// measurements, not platform limits or artifact-schema constants.
export const P6_FIXED_RUNTIME_OBJECT_READS = 6;
export const P6_METADATA_CONCURRENT_READS = 4;

const REQUIRED_RUNTIME_ARTIFACTS = Object.freeze([
  "access-points.geojson",
  "named-trails.json",
  "segments/index.json",
]);

function fail(message) {
  throw new Error(`Cannot prepare Gate G evidence: ${message}`);
}

async function sha256File(path) {
  const hash = createHash("sha256");
  const stream = createReadStream(path);
  stream.on("data", (chunk) => hash.update(chunk));
  await finished(stream);
  return hash.digest("hex");
}

async function loadJson(path, label) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    fail(`${label} is not readable JSON: ${error.message}`);
  }
}

function declaredFiles(manifest) {
  return ["manifest.json", ...Object.keys(manifest.artifacts ?? {}).sort()];
}

function artifactComparison(manifestA, manifestB, manifestBytesEqual) {
  const filesA = declaredFiles(manifestA);
  const filesB = declaredFiles(manifestB);
  const metadataDifferences = [];
  for (const path of [...new Set([...filesA, ...filesB])].sort()) {
    if (path === "manifest.json") continue;
    const left = manifestA.artifacts?.[path];
    const right = manifestB.artifacts?.[path];
    if (!left || !right) {
      metadataDifferences.push({ path, reason: left ? "missing-from-build-b" : "missing-from-build-a" });
    } else if (left.sha256 !== right.sha256 || left.rawBytes !== right.rawBytes ||
        left.compressedBytes !== right.compressedBytes) {
      metadataDifferences.push({ path, reason: "hash-or-size-differs" });
    }
  }
  const fileSetsEqual = filesA.length === filesB.length &&
    filesA.every((path, index) => path === filesB[index]);
  return {
    byteIdentical: manifestBytesEqual && fileSetsEqual && metadataDifferences.length === 0,
    comparisonMethod:
      "exact manifest bytes plus validator-verified SHA-256 and sizes for every declared artifact",
    declaredFiles: fileSetsEqual ? filesA.length : null,
    fileSetsEqual,
    manifestBytesEqual,
    metadataDifferences,
  };
}

function runtimeRequirements(manifest) {
  const missingRequiredRuntimeArtifacts = REQUIRED_RUNTIME_ARTIFACTS.filter((path) => {
    const artifact = manifest.artifacts?.[path];
    return artifact?.role !== "runtime" || artifact.application !== "required";
  });
  const segmentShards = Object.entries(manifest.artifacts ?? {})
    .filter(([path, artifact]) => /^segments\/[0-9a-f]+\.ndjson$/.test(path) &&
      artifact.role === "runtime")
    .sort(([left], [right]) => left.localeCompare(right));
  const targets = manifest.delivery?.shardSizeTargets;
  const oversized = segmentShards.filter(([, artifact]) =>
    artifact.rawBytes > targets.rawBytes || artifact.compressedBytes > targets.compressedBytes)
    .map(([path]) => path);
  return {
    requiredRuntimeArtifactsPresent: missingRequiredRuntimeArtifacts.length === 0,
    missingRequiredRuntimeArtifacts,
    geometryShards: segmentShards.length,
    rawByteTarget: targets.rawBytes,
    compressedByteTarget: targets.compressedBytes,
    oversizedGeometryShards: oversized,
    documentedExceptions: (targets.exceptions ?? []).map(({ path, note }) => ({ path, note })),
  };
}

function requirePositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) fail(`${label} must be a positive integer`);
  return value;
}

async function runtimeDelivery(directory, manifest, limits) {
  const totalObjectReadCeiling = requirePositiveInteger(
    limits?.totalObjectReads,
    "max total object reads",
  );
  const concurrentReadCeiling = requirePositiveInteger(
    limits?.concurrentReads,
    "max concurrent reads",
  );
  const [namedValue, segmentIndex] = await Promise.all([
    loadJson(resolve(directory, "named-trails.json"), "named-trails.json"),
    loadJson(resolve(directory, "segments/index.json"), "segments/index.json"),
  ]);
  const prefixLength = partitionPrefixLength(segmentIndex);
  const trails = (namedValue.trails ?? []).map((trail) => {
    const prefixes = [...new Set(trail.segmentIds.map((segmentId) =>
      segmentPartitionKey(segmentId, prefixLength)))].sort();
    const paths = prefixes.map((prefix) => segmentIndex.shards[prefix]?.path);
    const missingPrefixes = prefixes.filter((prefix, index) => !paths[index]);
    const geometryRawBytes = paths.reduce((total, path) =>
      total + (manifest.artifacts[path]?.rawBytes ?? 0), 0);
    const geometryCompressedBytes = paths.reduce((total, path) =>
      total + (manifest.artifacts[path]?.compressedBytes ?? 0), 0);
    const geometryObjectReads = paths.length;
    const totalObjectReads = P6_FIXED_RUNTIME_OBJECT_READS + geometryObjectReads;
    const estimatedConcurrentReads = Math.max(
      P6_METADATA_CONCURRENT_READS,
      geometryObjectReads,
    );
    return {
      id: trail.id,
      segments: trail.segmentIds.length,
      geometryObjectReads,
      geometryRawBytes,
      geometryCompressedBytes,
      totalObjectReads,
      estimatedConcurrentReads,
      missingPrefixes,
      oneImmutableGeometryObject: geometryObjectReads === 1 && missingPrefixes.length === 0,
      totalObjectReadsWithinCeiling: totalObjectReads <= totalObjectReadCeiling,
      concurrentReadsWithinCeiling: estimatedConcurrentReads <= concurrentReadCeiling,
    };
  }).sort((left, right) =>
    right.geometryObjectReads - left.geometryObjectReads ||
    right.geometryRawBytes - left.geometryRawBytes ||
    left.id.localeCompare(right.id));
  const maximum = trails[0] ?? {
    geometryObjectReads: 0,
    geometryRawBytes: 0,
    geometryCompressedBytes: 0,
    totalObjectReads: P6_FIXED_RUNTIME_OBJECT_READS,
    estimatedConcurrentReads: P6_METADATA_CONCURRENT_READS,
  };
  const requirements = runtimeRequirements(manifest);
  return {
    selectedTrailContract: "exactly one immutable geometry object",
    currentAdapterFixedObjectReads: P6_FIXED_RUNTIME_OBJECT_READS,
    currentAdapterMetadataConcurrentReads: P6_METADATA_CONCURRENT_READS,
    totalObjectReadCeiling,
    concurrentReadCeiling,
    ordinaryObjectRawByteCeiling: MAX_RUNTIME_SHARD_RAW_BYTES,
    ordinaryObjectCompressedByteCeiling: MAX_RUNTIME_SHARD_GZIP_BYTES,
    trailsMeasured: trails.length,
    trailsUsingOneGeometryObject: trails.filter(({ oneImmutableGeometryObject }) =>
      oneImmutableGeometryObject).length,
    trailsExceedingTotalObjectReadCeiling: trails.filter(({ totalObjectReadsWithinCeiling }) =>
      !totalObjectReadsWithinCeiling).length,
    trailsExceedingConcurrentReadCeiling: trails.filter(({ concurrentReadsWithinCeiling }) =>
      !concurrentReadsWithinCeiling).length,
    trailsWithMissingPrefixes: trails.filter(({ missingPrefixes }) => missingPrefixes.length > 0).length,
    maximum: {
      trailId: maximum.id ?? null,
      segments: maximum.segments ?? 0,
      geometryObjectReads: maximum.geometryObjectReads,
      geometryRawBytes: maximum.geometryRawBytes,
      geometryCompressedBytes: maximum.geometryCompressedBytes,
      totalObjectReads: maximum.totalObjectReads,
      estimatedConcurrentReads: maximum.estimatedConcurrentReads,
    },
    largestFanouts: trails.slice(0, 10).map((trail) => ({
      trailId: trail.id,
      segments: trail.segments,
      geometryObjectReads: trail.geometryObjectReads,
      geometryRawBytes: trail.geometryRawBytes,
      geometryCompressedBytes: trail.geometryCompressedBytes,
      totalObjectReads: trail.totalObjectReads,
      estimatedConcurrentReads: trail.estimatedConcurrentReads,
    })),
    oneImmutableGeometryObjectPerTrail: trails.every(({ oneImmutableGeometryObject }) =>
      oneImmutableGeometryObject),
    requestReadCeilingsPass: trails.every(({ totalObjectReadsWithinCeiling,
      concurrentReadsWithinCeiling }) =>
      totalObjectReadsWithinCeiling && concurrentReadsWithinCeiling),
    ordinaryObjectSizeContractPass: requirements.oversizedGeometryShards.length === 0 ||
      requirements.oversizedGeometryShards.every((path) =>
        requirements.documentedExceptions.some((exception) => exception.path === path)),
  };
}

async function accessCredibility(directory) {
  const namedTrails = await loadJson(resolve(directory, "named-trails.json"), "named-trails.json");
  const accessGeoJson = await loadJson(
    resolve(directory, "access-points.geojson"),
    "access-points.geojson",
  );
  const points = new Map((accessGeoJson.features ?? []).map((feature) => [
    feature.id ?? feature.properties?.id,
    feature,
  ]));
  const invalidAccessPointIds = [...points].flatMap(([id, feature]) => {
    const properties = feature.properties ?? {};
    return feature.geometry?.type !== "Point" ||
      !["official", "mapped", "derived"].includes(properties.confidence) ||
      !Array.isArray(properties.connectedNodeIds) || properties.connectedNodeIds.length === 0
      ? [id]
      : [];
  }).sort();
  const inaccessibleTrailIds = [];
  const missingAccessReferences = [];
  for (const trail of namedTrails.trails ?? []) {
    if (!Array.isArray(trail.accessPointIds) || trail.accessPointIds.length === 0) {
      inaccessibleTrailIds.push(trail.id);
      continue;
    }
    for (const accessPointId of trail.accessPointIds) {
      if (!points.has(accessPointId)) {
        missingAccessReferences.push({ trailId: trail.id, accessPointId });
      }
    }
  }
  return {
    searchableTrails: namedTrails.trails?.length ?? 0,
    canonicalAccessPoints: points.size,
    credibleConnectedAccess: inaccessibleTrailIds.length === 0 &&
      missingAccessReferences.length === 0 && invalidAccessPointIds.length === 0,
    inaccessibleTrailIds: inaccessibleTrailIds.sort(),
    invalidAccessPointIds,
    missingAccessReferences: missingAccessReferences.sort((left, right) =>
      left.trailId.localeCompare(right.trailId) ||
      left.accessPointId.localeCompare(right.accessPointId)),
  };
}

async function accessBudgetEvidence(path) {
  if (!path) return { supplied: false };
  const evidence = await loadJson(resolve(path), "access evidence");
  if (!evidence.searchResponse || !Array.isArray(evidence.lowZoomMarkers)) {
    fail("access evidence must contain searchResponse and lowZoomMarkers array values");
  }
  const responseBytes = Buffer.byteLength(JSON.stringify(evidence.searchResponse));
  const markerCount = evidence.lowZoomMarkers.length;
  return {
    supplied: true,
    responseBytes,
    responseBudgetBytes: GATE_G_RESPONSE_BUDGET_BYTES,
    responseWithinBudget: responseBytes <= GATE_G_RESPONSE_BUDGET_BYTES,
    lowZoomMarkerCount: markerCount,
    lowZoomMarkerBudget: GATE_G_LOW_ZOOM_MARKER_BUDGET,
    lowZoomMarkersWithinBudget: markerCount <= GATE_G_LOW_ZOOM_MARKER_BUDGET,
  };
}

function qaEvidence(qa) {
  const edgeFlags = qa.elevation?.implausibleMetricOutliers?.length ?? 0;
  const aggregateFlags = qa.elevation?.aggregateWindows?.outliers?.length ?? 0;
  return {
    sourceCounts: qa.counts?.input?.bySource ?? {},
    outputCounts: qa.counts?.output ?? {},
    mergeConflicts: qa.merge?.conflicts ?? null,
    unexplainedMergeConflicts: qa.merge?.unexplained ?? null,
    ambiguousSnaps: qa.snapping?.ambiguous ?? null,
    isolatedComponents: qa.graph?.connectedComponents ?? null,
    isolatedSegments: qa.graph?.isolatedSegments ?? null,
    accessPointsByConfidence: qa.accessPoints ?? {},
    elevationCoveragePct: qa.elevation?.coveragePct ?? null,
    searchableElevationMissingSegmentIds:
      qa.elevation?.searchableNamedTrailMissingSegmentIds ?? [],
    edgeElevationFlags: edgeFlags,
    aggregateElevationFlags: aggregateFlags,
    elevationReviewStatus: qa.elevation?.review?.status ?? null,
    issues: qa.issues?.length ?? 0,
  };
}

export async function verifyGateGEvidence({
  regionId,
  buildA,
  buildB,
  accessEvidence,
  runtimeLimits,
}) {
  if (!P8_REGION_IDS.includes(regionId)) {
    fail(`region must be one of ${P8_REGION_IDS.join(", ")}`);
  }
  if (!buildA || !buildB || resolve(buildA) === resolve(buildB)) {
    fail("two distinct build directories are required");
  }
  const region = requireRegion(regionId);
  const directoryA = resolve(buildA);
  const directoryB = resolve(buildB);
  // Keep full regional validation sequential so the harness does not double
  // its validator live set merely to compare two builds.
  const validationA = await validateArtifactDirectory(directoryA);
  const validationB = await validateArtifactDirectory(directoryB);
  if (validationA.schemaVersion !== 2 || validationB.schemaVersion !== 2) {
    fail("both builds must use artifact contract v2");
  }
  if (validationA.regionId !== regionId || validationB.regionId !== regionId) {
    fail(`both builds must declare region ${regionId}`);
  }
  const [manifestBufferA, manifestBufferB, qa, access] = await Promise.all([
    readFile(resolve(directoryA, "manifest.json")),
    readFile(resolve(directoryB, "manifest.json")),
    loadJson(resolve(directoryA, "qa.json"), "qa.json"),
    accessCredibility(directoryA),
  ]);
  const manifestA = JSON.parse(manifestBufferA);
  const manifestB = JSON.parse(manifestBufferB);
  const comparison = artifactComparison(
    manifestA,
    manifestB,
    manifestBufferA.equals(manifestBufferB),
  );
  const budget = await accessBudgetEvidence(accessEvidence);
  const qaSummary = qaEvidence(qa);
  const delivery = await runtimeDelivery(directoryA, manifestA, runtimeLimits);
  const machineChecks = {
    artifactValidation: true,
    byteIdentical: comparison.byteIdentical,
    qaDecisionReady: ["pass", "pass-with-exceptions"].includes(
      manifestA.decisions.qa.decision,
    ),
    runtimeRequirements: runtimeRequirements(manifestA).requiredRuntimeArtifactsPresent,
    credibleConnectedAccess: access.credibleConnectedAccess,
    elevationCoverage: qaSummary.searchableElevationMissingSegmentIds.length === 0,
    accessBudgets: budget.supplied && budget.responseWithinBudget &&
      budget.lowZoomMarkersWithinBudget,
    oneImmutableGeometryObjectPerTrail: delivery.oneImmutableGeometryObjectPerTrail,
    runtimeRequestReadCeilings: delivery.requestReadCeilingsPass,
    runtimeObjectSizeContract: delivery.ordinaryObjectSizeContractPass,
  };
  return {
    reportVersion: 1,
    status: "NOT ACCEPTED — integrator review required",
    region: { id: region.id, label: region.label },
    builds: {
      labels: [basename(directoryA), basename(directoryB)],
      buildIdA: manifestA.buildId,
      buildIdB: manifestB.buildId,
      manifestSha256A: await sha256File(resolve(directoryA, "manifest.json")),
      manifestSha256B: await sha256File(resolve(directoryB, "manifest.json")),
      comparison,
    },
    manifest: {
      qaDecision: manifestA.decisions.qa,
      reviewDecision: manifestA.decisions.review,
      sourceSnapshots: manifestA.sourceSnapshots.length,
      runtime: runtimeRequirements(manifestA),
    },
    qa: qaSummary,
    access,
    accessBudget: budget,
    runtimeDelivery: delivery,
    tahoeFlagReview: regionId === "tahoe-eldorado" ? {
      required: true,
      t8BaselineEdgeFlags: 35,
      t8BaselineAggregateFlags: 1,
      observedEdgeFlags: qaSummary.edgeElevationFlags,
      observedAggregateFlags: qaSummary.aggregateElevationFlags,
      disposition: null,
    } : { required: false },
    machineChecks,
    gateGAccepted: false,
  };
}

function result(value) {
  return value ? "PASS" : "BLOCKED";
}

export function renderGateGReport(evidence) {
  const lines = [
    `# ${evidence.region.label} Gate G evidence`,
    "",
    `Status: **${evidence.status}**`,
    "",
    "This report is a deterministic evidence skeleton. It does not accept Gate G or activate a region.",
    "",
    "## Machine evidence",
    "",
    `- Artifact v2 validation: ${result(evidence.machineChecks.artifactValidation)}`,
    `- Two-build byte identity: ${result(evidence.machineChecks.byteIdentical)}`,
    `- Build IDs: \`${evidence.builds.buildIdA}\` / \`${evidence.builds.buildIdB}\``,
    `- Declared files per build: ${evidence.builds.comparison.declaredFiles ?? "different sets"}`,
    `- Manifest SHA-256: \`${evidence.builds.manifestSha256A}\` / ` +
      `\`${evidence.builds.manifestSha256B}\``,
    `- Manifest QA decision ready: ${result(evidence.machineChecks.qaDecisionReady)} ` +
      `(\`${evidence.manifest.qaDecision.decision}\`)`,
    `- Required runtime artifacts and shard contract: ${result(evidence.machineChecks.runtimeRequirements)}`,
    `- Searchable trails have credible connected access: ${result(evidence.machineChecks.credibleConnectedAccess)}`,
    `- Searchable elevation coverage: ${result(evidence.machineChecks.elevationCoverage)}`,
    `- Access response and marker budgets: ${result(evidence.machineChecks.accessBudgets)}`,
    `- One immutable geometry object per selected trail: ` +
      `${result(evidence.machineChecks.oneImmutableGeometryObjectPerTrail)}`,
    `- Full-request object-read ceilings: ${result(evidence.machineChecks.runtimeRequestReadCeilings)}`,
    `- Runtime object-size contract: ${result(evidence.machineChecks.runtimeObjectSizeContract)}`,
    "",
    "## QA review inputs",
    "",
    `- Output: ${evidence.qa.outputCounts.segments ?? 0} segments, ` +
      `${evidence.qa.outputCounts.namedTrails ?? 0} named components, ` +
      `${evidence.qa.outputCounts.accessPoints ?? 0} canonical access points`,
    `- Merge conflicts: ${evidence.qa.mergeConflicts}; unexplained: ` +
      `${evidence.qa.unexplainedMergeConflicts}`,
    `- Ambiguous snaps: ${evidence.qa.ambiguousSnaps}`,
    `- Connected components: ${evidence.qa.isolatedComponents}; isolated segments: ` +
      `${evidence.qa.isolatedSegments}`,
    `- Access evidence counts: ${JSON.stringify(evidence.qa.accessPointsByConfidence)}`,
    `- Elevation coverage: ${evidence.qa.elevationCoveragePct}%`,
    `- Elevation flags: ${evidence.qa.edgeElevationFlags} edge / ` +
      `${evidence.qa.aggregateElevationFlags} aggregate`,
    `- Pipeline/access issues retained for review: ${evidence.qa.issues}`,
    "",
    "## Access budget evidence",
    "",
    ...(evidence.accessBudget.supplied ? [
      `- Search response: ${evidence.accessBudget.responseBytes} / ` +
        `${evidence.accessBudget.responseBudgetBytes} bytes`,
      `- Low-zoom markers: ${evidence.accessBudget.lowZoomMarkerCount} / ` +
        `${evidence.accessBudget.lowZoomMarkerBudget}`,
    ] : ["- Not supplied. Capture a representative maximum-result response and its low-zoom markers."]),
    "",
    "## Selected-geometry delivery evidence",
    "",
    `- Measured named trails: ${evidence.runtimeDelivery.trailsMeasured}`,
    `- Trails resolving to exactly one immutable geometry object: ` +
      `${evidence.runtimeDelivery.trailsUsingOneGeometryObject} / ` +
      `${evidence.runtimeDelivery.trailsMeasured}`,
    `- Maximum geometry fanout: ${evidence.runtimeDelivery.maximum.geometryObjectReads} objects / ` +
      `${evidence.runtimeDelivery.maximum.geometryRawBytes} estimated raw bytes / ` +
      `${evidence.runtimeDelivery.maximum.geometryCompressedBytes} estimated compressed bytes ` +
      `(trail \`${evidence.runtimeDelivery.maximum.trailId}\`)`,
    `- Maximum full-request estimate: ${evidence.runtimeDelivery.maximum.totalObjectReads} object reads / ` +
      `${evidence.runtimeDelivery.maximum.estimatedConcurrentReads} concurrent reads`,
    `- Reviewed deployment-plan ceilings: ${evidence.runtimeDelivery.totalObjectReadCeiling} total / ` +
      `${evidence.runtimeDelivery.concurrentReadCeiling} concurrent; reverify before Gate G`,
    `- Ordinary geometry object ceiling: ${evidence.runtimeDelivery.ordinaryObjectRawByteCeiling} raw / ` +
      `${evidence.runtimeDelivery.ordinaryObjectCompressedByteCeiling} compressed bytes; ` +
      "manifest-declared reviewed exceptions only",
    "",
    "Largest measured fanouts:",
    "",
    "| Trail | Segments | Geometry objects | Raw bytes | Full-request reads | Concurrent reads |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
    ...evidence.runtimeDelivery.largestFanouts.slice(0, 5).map((trail) =>
      `| \`${trail.trailId}\` | ${trail.segments} | ${trail.geometryObjectReads} | ` +
      `${trail.geometryRawBytes} | ${trail.totalObjectReads} | ${trail.estimatedConcurrentReads} |`),
    "",
    "## Required human review",
    "",
    "- [ ] Review source counts and snapshot provenance.",
    "- [ ] Review merge conflicts, ambiguous snaps, isolated geometry, and retained issues.",
    "- [ ] Review representative named trails and canonical access points.",
    "- [ ] Classify elevation flags and document product treatment.",
    "- [ ] Record `PASS` or `PASS WITH DOCUMENTED EXCEPTIONS` only after review.",
    "- [ ] Obtain independent integrator review of this report and the manifest.",
  ];
  if (evidence.tahoeFlagReview.required) {
    lines.push(
      "",
      "## Tahoe–Eldorado required flag disposition",
      "",
      `- [ ] Resolve or document all ${evidence.tahoeFlagReview.observedEdgeFlags} observed edge flags ` +
        `(T8 baseline: ${evidence.tahoeFlagReview.t8BaselineEdgeFlags}).`,
      `- [ ] Resolve or document all ${evidence.tahoeFlagReview.observedAggregateFlags} observed ` +
        `aggregate flags (T8 baseline: ${evidence.tahoeFlagReview.t8BaselineAggregateFlags}).`,
      "- [ ] Explain any count change from the T8 baseline before proposing Gate G acceptance.",
    );
  }
  lines.push("", "Gate G accepted: **NO**", "");
  return lines.join("\n");
}

function commandLineOptions(argv) {
  const options = {};
  for (const argument of argv) {
    const match = /^--(region|build-a|build-b|access-evidence|report|max-total-object-reads|max-concurrent-reads)=(.+)$/.exec(argument);
    if (!match) {
      fail("usage: verify-gate-g.mjs --region=<id> --build-a=<dir> --build-b=<dir> " +
        "--max-total-object-reads=<count> --max-concurrent-reads=<count> " +
        "[--access-evidence=<json>] [--report=<markdown>]");
    }
    options[match[1]] = match[2];
  }
  return options;
}

async function main() {
  const options = commandLineOptions(process.argv.slice(2));
  const evidence = await verifyGateGEvidence({
    regionId: options.region,
    buildA: options["build-a"],
    buildB: options["build-b"],
    accessEvidence: options["access-evidence"],
    runtimeLimits: {
      totalObjectReads: Number(options["max-total-object-reads"]),
      concurrentReads: Number(options["max-concurrent-reads"]),
    },
  });
  const report = renderGateGReport(evidence);
  if (options.report) {
    await writeFile(resolve(options.report), report, "utf8");
  } else {
    process.stdout.write(report);
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error}\n`);
    process.exitCode = 1;
  });
}
