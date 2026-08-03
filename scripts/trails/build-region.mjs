#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createNamedTrailId,
  validateAccessPoint,
  validateNamedTrail,
  validateTrailNode,
  validateTrailSegment,
} from "./model.mjs";
import { requireRegion } from "./regions.mjs";
import { applyElevationMetrics } from "./elevation/metrics.mjs";
import {
  createCachedElevationGridSource,
  createElevationManifestMetadata,
  sampleElevationProfile,
} from "./elevation/profile.mjs";
import { buildAccessPoints } from "./graph/access-points.mjs";
import { buildOsmTopology } from "./graph/topology.mjs";
import { mergeTrailSegments } from "./normalize/merge.mjs";
import { deduplicateSourceRefs, normalizeSegmentText } from "./normalize/segments.mjs";
import { readArcGisSnapshot } from "./sources/arcgis.mjs";
import ebrpdAdapter from "./sources/ebrpd.mjs";
import npsAdapter from "./sources/nps.mjs";
import { readOsmSnapshot } from "./sources/osm.mjs";
import stateParksAdapter from "./sources/state-parks.mjs";
import usfsAdapter from "./sources/usfs.mjs";
import usgsAdapter from "./sources/usgs.mjs";
import { lineStringBounds } from "./spatial/geometry.mjs";
import { buildQaReport } from "./qa/report.mjs";

export const ARTIFACT_FILENAMES = Object.freeze({
  namedTrails: "named-trails.json",
  accessPoints: "access-points.geojson",
  segments: "segments.ndjson",
  nodes: "nodes.ndjson",
  qa: "qa.json",
  manifest: "manifest.json",
});

const AGENCY_ADAPTERS = Object.freeze({
  usgs: usgsAdapter,
  usfs: usfsAdapter,
  nps: npsAdapter,
  "state-parks": stateParksAdapter,
  ebrpd: ebrpdAdapter,
});

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function prettyJson(value) {
  return `${JSON.stringify(JSON.parse(stableJson(value)), null, 2)}\n`;
}

function ndjson(records) {
  return records.map(stableJson).join("\n") + (records.length > 0 ? "\n" : "");
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function artifactMetadata(content) {
  return { bytes: Buffer.byteLength(content), sha256: sha256(content) };
}

function inputArrays(input) {
  const normalized = {
    segmentCandidates: input.segmentCandidates ?? input.segments ?? [],
    sourceNodes: input.sourceNodes ?? input.nodes ?? [],
    accessPointCandidates: input.accessPointCandidates ?? [],
    publicRoadNodeIds: input.publicRoadNodeIds ?? [],
  };
  for (const [field, value] of Object.entries(normalized)) {
    if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`);
  }
  return normalized;
}

function endpointNode(nodeId, coordinate, provided) {
  const existing = provided.get(nodeId);
  return {
    id: nodeId,
    longitude: existing?.longitude ?? coordinate[0],
    latitude: existing?.latitude ?? coordinate[1],
    sourceNodeIds: [...new Set(existing?.sourceNodeIds ?? [])].sort(),
    incidentSegmentIds: [],
  };
}

/** Reconcile input topology with post-merge segment IDs. */
export function buildCanonicalNodes(segments, sourceNodes = []) {
  const provided = new Map(sourceNodes.map((node) => [node.id, node]));
  const nodes = new Map();
  for (const segment of segments) {
    const endpoints = [
      [segment.fromNodeId, segment.geometry.coordinates[0]],
      [segment.toNodeId, segment.geometry.coordinates.at(-1)],
    ];
    for (const [nodeId, coordinate] of endpoints) {
      if (!nodes.has(nodeId)) nodes.set(nodeId, endpointNode(nodeId, coordinate, provided));
      nodes.get(nodeId).incidentSegmentIds.push(segment.id);
    }
  }
  const result = [...nodes.values()].map((node) => ({
    ...node,
    incidentSegmentIds: [...new Set(node.incidentSegmentIds)].sort(),
  })).sort((left, right) => left.id.localeCompare(right.id));
  result.forEach(validateTrailNode);
  return result;
}

async function enrichSegments(segments, elevationSource, elevationOptions) {
  const enriched = [];
  for (const segment of segments) {
    const profile = elevationSource
      ? await sampleElevationProfile(segment.geometry, elevationSource, elevationOptions)
      : [];
    const result = applyElevationMetrics(segment, profile, elevationOptions);
    validateTrailSegment(result);
    enriched.push(result);
  }
  return enriched.sort((left, right) => left.id.localeCompare(right.id));
}

function paddedBounds(segments) {
  const bounds = segments.map(({ geometry }) => lineStringBounds(geometry));
  const result = [
    Math.min(...bounds.map(([west]) => west)),
    Math.min(...bounds.map(([, south]) => south)),
    Math.max(...bounds.map(([, , east]) => east)),
    Math.max(...bounds.map(([, , , north]) => north)),
  ];
  if (result[0] === result[2]) {
    result[0] -= 0.0000001;
    result[2] += 0.0000001;
  }
  if (result[1] === result[3]) {
    result[1] -= 0.0000001;
    result[3] += 0.0000001;
  }
  return result;
}

function componentGroups(segments) {
  const pending = new Set(segments.map(({ id }) => id));
  const byId = new Map(segments.map((segment) => [segment.id, segment]));
  const byNode = new Map();
  for (const segment of segments) {
    for (const nodeId of [segment.fromNodeId, segment.toNodeId]) {
      const ids = byNode.get(nodeId) ?? [];
      ids.push(segment.id);
      byNode.set(nodeId, ids);
    }
  }
  const groups = [];
  while (pending.size > 0) {
    const first = [...pending].sort()[0];
    const queue = [first];
    const ids = [];
    pending.delete(first);
    while (queue.length > 0) {
      const id = queue.shift();
      ids.push(id);
      const segment = byId.get(id);
      for (const nodeId of [segment.fromNodeId, segment.toNodeId]) {
        for (const neighbor of byNode.get(nodeId) ?? []) {
          if (pending.delete(neighbor)) queue.push(neighbor);
        }
      }
    }
    groups.push(ids.sort().map((id) => byId.get(id)));
  }
  return groups;
}

function isUnbranched(segments) {
  const degrees = new Map();
  for (const segment of segments) {
    degrees.set(segment.fromNodeId, (degrees.get(segment.fromNodeId) ?? 0) + 1);
    degrees.set(segment.toNodeId, (degrees.get(segment.toNodeId) ?? 0) + 1);
  }
  return [...degrees.values()].every((degree) => degree <= 2);
}

function trailConfidence(segments, accessPoints) {
  const confidences = new Set(accessPoints.map(({ confidence }) => confidence));
  const fullyExplicit = segments.every(({ hiking, access, status }) =>
    hiking === "allowed" && access === "public" && status === "open");
  if (fullyExplicit && confidences.has("official")) return "high";
  if (!confidences.has("derived") && segments.every(({ hiking }) => hiking === "allowed")) {
    return "medium";
  }
  return "low";
}

function buildNamedTrails(segments, accessPoints) {
  const eligible = segments.filter(({ name, hiking, access, status }) =>
    name && hiking !== "blocked" && access !== "private" && status !== "closed");
  const namedGroups = new Map();
  for (const segment of eligible) {
    const key = `${normalizeSegmentText(segment.name)}\u0000${normalizeSegmentText(segment.manager) ?? ""}`;
    const values = namedGroups.get(key) ?? [];
    values.push(segment);
    namedGroups.set(key, values);
  }
  const pointsByNode = new Map();
  for (const point of accessPoints) {
    for (const nodeId of point.connectedNodeIds) {
      const points = pointsByNode.get(nodeId) ?? [];
      points.push(point);
      pointsByNode.set(nodeId, points);
    }
  }

  const trails = [];
  for (const segmentsWithName of namedGroups.values()) {
    for (const group of componentGroups(segmentsWithName)) {
      const pointMap = new Map();
      for (const segment of group) {
        for (const nodeId of [segment.fromNodeId, segment.toNodeId]) {
          for (const point of pointsByNode.get(nodeId) ?? []) pointMap.set(point.id, point);
        }
      }
      const points = [...pointMap.values()].sort((left, right) => left.id.localeCompare(right.id));
      if (points.length === 0) continue;
      const sourceRefs = deduplicateSourceRefs(group.flatMap(({ sourceRefs }) => sourceRefs));
      const segmentIds = group.map(({ id }) => id).sort();
      const trail = {
        id: createNamedTrailId(sourceRefs, group[0].name, segmentIds),
        name: group[0].name,
        segmentIds,
        accessPointIds: points.map(({ id }) => id),
        ...(group[0].manager ? { manager: group[0].manager } : {}),
        bounds: paddedBounds(group),
        ...(isUnbranched(group) ? {
          lengthMeters: Number(group.reduce((total, segment) =>
            total + segment.lengthMeters, 0).toFixed(1)),
        } : {}),
        sourceRefs,
        dataConfidence: trailConfidence(group, points),
      };
      validateNamedTrail(trail);
      trails.push(trail);
    }
  }
  return trails.sort((left, right) => left.id.localeCompare(right.id));
}

function accessPointGeoJson(accessPoints) {
  return {
    type: "FeatureCollection",
    features: accessPoints.map(({ longitude, latitude, ...properties }) => ({
      type: "Feature",
      id: properties.id,
      geometry: { type: "Point", coordinates: [longitude, latitude] },
      properties,
    })),
  };
}

function buildTimestamp(input, segments) {
  if (input.buildTimestamp !== undefined) {
    if (Number.isNaN(Date.parse(input.buildTimestamp))) {
      throw new TypeError("buildTimestamp must be a valid timestamp");
    }
    return new Date(input.buildTimestamp).toISOString();
  }
  const timestamps = segments.flatMap(({ sourceRefs }) =>
    sourceRefs.map(({ retrievedAt }) => Date.parse(retrievedAt))).filter(Number.isFinite);
  return new Date(timestamps.length > 0 ? Math.max(...timestamps) : 0).toISOString();
}

/** Build all T7 artifacts in memory without touching the network or filesystem. */
export async function buildRegionArtifacts(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("input must be an object");
  }
  const region = requireRegion(input.regionId);
  const arrays = inputArrays(input);
  const merged = mergeTrailSegments(arrays.segmentCandidates, input.mergeOptions);
  const segments = await enrichSegments(merged.segments, input.elevationSource, input.elevationOptions);
  const nodes = buildCanonicalNodes(segments, arrays.sourceNodes);
  const access = buildAccessPoints({
    nodes,
    segments,
    candidates: arrays.accessPointCandidates,
    publicRoadNodeIds: arrays.publicRoadNodeIds,
  }, input.accessPointOptions);
  access.accessPoints.forEach(validateAccessPoint);
  const namedTrails = buildNamedTrails(segments, access.accessPoints);

  const payloads = {
    [ARTIFACT_FILENAMES.namedTrails]: prettyJson({
      schemaVersion: 1,
      regionId: region.id,
      trails: namedTrails,
    }),
    [ARTIFACT_FILENAMES.accessPoints]: prettyJson(accessPointGeoJson(access.accessPoints)),
    [ARTIFACT_FILENAMES.segments]: ndjson(segments),
    [ARTIFACT_FILENAMES.nodes]: ndjson(nodes),
  };
  const dataArtifactHashes = Object.fromEntries(Object.entries(payloads).map(([filename, content]) =>
    [filename, artifactMetadata(content)]));
  const qa = buildQaReport({
    region,
    input: arrays,
    segments,
    nodes,
    accessPoints: access.accessPoints,
    namedTrails,
    mergeConflicts: merged.conflicts,
    accessIssues: access.issues,
    pipelineIssues: input.pipelineIssues,
    artifactHashes: dataArtifactHashes,
  });
  payloads[ARTIFACT_FILENAMES.qa] = prettyJson(qa);
  const artifactFiles = Object.fromEntries(Object.entries(payloads).map(([filename, content]) => [
    filename,
    { path: filename, ...artifactMetadata(content) },
  ]));
  const manifest = {
    schemaVersion: 1,
    region: { id: region.id, label: region.label, bounds: [...region.bbox] },
    generatedAt: buildTimestamp(input, segments),
    counts: {
      namedTrails: namedTrails.length,
      accessPoints: access.accessPoints.length,
      segments: segments.length,
      nodes: nodes.length,
    },
    elevation: input.elevationSource
      ? createElevationManifestMetadata(input.elevationSource, input.elevationOptions)
      : { available: false, missingCoverage: "omit-segment-elevation-metrics" },
    artifacts: artifactFiles,
  };
  payloads[ARTIFACT_FILENAMES.manifest] = prettyJson(manifest);
  return {
    region,
    manifest,
    qa,
    namedTrails,
    accessPoints: access.accessPoints,
    segments,
    nodes,
    payloads,
  };
}

export async function writeRegionArtifacts(result, outputDirectory) {
  if (!result?.payloads || typeof outputDirectory !== "string" || !outputDirectory) {
    throw new TypeError("result and outputDirectory are required");
  }
  await mkdir(outputDirectory, { recursive: true });
  await Promise.all(Object.entries(result.payloads).map(([filename, content]) =>
    writeFile(resolve(outputDirectory, filename), content)));
  return outputDirectory;
}

export async function buildRegionFromFile(inputPath, { outputDirectory, regionId } = {}) {
  const absoluteInputPath = resolve(inputPath);
  const input = JSON.parse(await readFile(absoluteInputPath, "utf8"));
  if (regionId !== undefined && input.regionId !== regionId) {
    throw new Error(
      `Input region ${JSON.stringify(input.regionId)} does not match requested region ` +
      JSON.stringify(regionId),
    );
  }
  const inputDirectory = dirname(absoluteInputPath);
  input.segmentCandidates ??= [];
  input.sourceNodes ??= [];
  input.pipelineIssues ??= [];
  if (!Array.isArray(input.segmentCandidates)) {
    throw new TypeError("segmentCandidates must be an array");
  }
  if (!Array.isArray(input.sourceNodes)) throw new TypeError("sourceNodes must be an array");
  if (!Array.isArray(input.pipelineIssues)) throw new TypeError("pipelineIssues must be an array");
  if (input.agencySnapshots !== undefined) {
    if (!input.agencySnapshots || typeof input.agencySnapshots !== "object" ||
        Array.isArray(input.agencySnapshots)) {
      throw new TypeError("agencySnapshots must be an object keyed by provider");
    }
    for (const [provider, relativePath] of Object.entries(input.agencySnapshots).sort()) {
      const adapter = AGENCY_ADAPTERS[provider];
      if (!adapter) {
        throw new RangeError(
          `Unknown agency snapshot provider ${JSON.stringify(provider)}; expected one of ` +
          Object.keys(AGENCY_ADAPTERS).join(", "),
        );
      }
      const snapshot = await readArcGisSnapshot(
        resolve(inputDirectory, relativePath),
        adapter.config,
      );
      input.segmentCandidates.push(...adapter.normalizeSnapshot(snapshot));
    }
  }
  if (input.osmSnapshotPath) {
    const snapshot = await readOsmSnapshot(
      resolve(inputDirectory, input.osmSnapshotPath),
      input.osmSnapshotOptions,
    );
    const topology = buildOsmTopology(snapshot);
    input.segmentCandidates.push(...topology.segments);
    input.sourceNodes.push(...topology.nodes);
    input.pipelineIssues.push(...topology.issues);
  }
  if (input.elevationGridPath) {
    const gridPath = resolve(inputDirectory, input.elevationGridPath);
    input.elevationSource = createCachedElevationGridSource(
      JSON.parse(await readFile(gridPath, "utf8")),
    );
  }
  const result = await buildRegionArtifacts(input);
  const destination = outputDirectory ?? resolve(
    "data/trails/generated",
    result.region.id,
  );
  await writeRegionArtifacts(result, destination);
  return { ...result, outputDirectory: destination };
}

function commandLineOptions(argv) {
  const options = {};
  for (const argument of argv) {
    const match = /^--(region|input|output)=(.+)$/.exec(argument);
    if (!match) throw new Error(`Unknown argument ${argument}`);
    options[match[1]] = match[2];
  }
  options.region ??= "yosemite-stanislaus";
  options.input ??= `.cache/trails/${options.region}/build-input.json`;
  options.output ??= `data/trails/generated/${options.region}`;
  return options;
}

async function main() {
  const options = commandLineOptions(process.argv.slice(2));
  const result = await buildRegionFromFile(options.input, {
    outputDirectory: resolve(options.output),
    regionId: options.region,
  });
  process.stdout.write(
    `Built ${result.manifest.counts.segments} segments and ` +
    `${result.manifest.counts.namedTrails} named trails in ${result.outputDirectory}\n`,
  );
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) main().catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 1;
});
