#!/usr/bin/env node

import { createHash } from "node:crypto";
import { appendFileSync, createWriteStream, writeFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, readFile, rename, rm } from "node:fs/promises";
import { once } from "node:events";
import { basename, dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { finished } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import { createGzip } from "node:zlib";
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
  loadCachedElevationTiles,
  sampleElevationProfile,
} from "./elevation/profile.mjs";
import { buildAccessPoints } from "./graph/access-points.mjs";
import { buildOsmTopology } from "./graph/topology.mjs";
import {
  mergeTrailSegments,
  reconcileAgencyGeometryWithOsmTopology,
} from "./normalize/merge.mjs";
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
import { geodesicLineLengthMeters } from "./spatial/length.mjs";

export const ARTIFACT_FILENAMES = Object.freeze({
  namedTrails: "named-trails.json",
  accessPoints: "access-points.geojson",
  segments: "segments/index.json",
  nodes: "nodes.ndjson",
  qa: "qa.json",
  segmentProvenance: "segment-provenance/index.json",
  manifest: "manifest.json",
});

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

const OBSOLETE_MANAGED_ARTIFACTS = Object.freeze([
  "segments.ndjson",
]);

const MANAGED_SHARD_PATTERNS = Object.freeze({
  segments: /^[0-9a-f]\.ndjson$/,
  "segment-provenance": /^[0-9a-f]\.json$/,
});

const AGENCY_ADAPTERS = Object.freeze({
  usgs: usgsAdapter,
  usfs: usfsAdapter,
  nps: npsAdapter,
  "state-parks": stateParksAdapter,
  ebrpd: ebrpdAdapter,
});

function jsonPrimitive(value, arrayValue = false) {
  const serialized = JSON.stringify(value);
  return serialized === undefined && arrayValue ? "null" : serialized;
}

/** Yield canonical JSON without first materializing stable and pretty copies. */
function* canonicalJsonChunks(
  value,
  { pretty = false } = {},
  depth = 0,
  stack = new Set(),
) {
  if (value?.toJSON instanceof Function) value = value.toJSON();
  if (!value || typeof value !== "object") {
    const serialized = jsonPrimitive(value);
    if (serialized !== undefined) yield serialized;
    return;
  }
  if (stack.has(value)) throw new TypeError("Converting circular structure to JSON");
  stack.add(value);
  const newline = pretty ? "\n" : "";
  const separator = pretty ? ": " : ":";
  const indent = (level) => pretty ? "  ".repeat(level) : "";
  if (Array.isArray(value)) {
    if (value.length === 0) {
      yield "[]";
    } else {
      yield `[${newline}`;
      for (let index = 0; index < value.length; index += 1) {
        if (index > 0) yield `,${newline}`;
        yield indent(depth + 1);
        const item = value[index]?.toJSON instanceof Function ? value[index].toJSON() : value[index];
        if (item && typeof item === "object") {
          yield* canonicalJsonChunks(item, { pretty }, depth + 1, stack);
        } else {
          yield jsonPrimitive(item, true);
        }
      }
      yield `${newline}${indent(depth)}]`;
    }
  } else {
    const entries = Object.keys(value).sort().flatMap((key) => {
      const item = value[key]?.toJSON instanceof Function ? value[key].toJSON() : value[key];
      return ["undefined", "function", "symbol"].includes(typeof item) ? [] : [[key, item]];
    });
    if (entries.length === 0) {
      yield "{}";
    } else {
      yield `{${newline}`;
      for (let index = 0; index < entries.length; index += 1) {
        if (index > 0) yield `,${newline}`;
        const [key, item] = entries[index];
        yield `${indent(depth + 1)}${JSON.stringify(key)}${separator}`;
        yield* canonicalJsonChunks(item, { pretty }, depth + 1, stack);
      }
      yield `${newline}${indent(depth)}}`;
    }
  }
  stack.delete(value);
}

function* prettyJsonChunks(value) {
  yield* canonicalJsonChunks(value, { pretty: true });
  yield "\n";
}

function* ndjsonChunks(records) {
  for (const record of records) {
    yield* canonicalJsonChunks(record);
    yield "\n";
  }
}

function* compactJsonLineChunks(value) {
  yield* canonicalJsonChunks(value);
  yield "\n";
}

function* coalesceChunks(chunks, targetBytes = 64 * 1024) {
  let values = [];
  let bytes = 0;
  for (const value of chunks) {
    const valueBytes = Buffer.byteLength(value);
    if (bytes > 0 && bytes + valueBytes > targetBytes) {
      yield values.join("");
      values = [];
      bytes = 0;
    }
    values.push(value);
    bytes += valueBytes;
    if (bytes >= targetBytes) {
      yield values.join("");
      values = [];
      bytes = 0;
    }
  }
  if (values.length > 0) yield values.join("");
}

function writeWithBackpressure(stream, chunk) {
  return stream.write(chunk) ? undefined : once(stream, "drain");
}

async function serializeArtifact(chunks, { destination, retain = false } = {}) {
  const hash = createHash("sha256");
  const gzip = createGzip({ level: 9 });
  let gzipBytes = 0;
  let bytes = 0;
  let peakChunkBytes = 0;
  const retained = retain ? [] : undefined;
  gzip.on("data", (chunk) => {
    gzipBytes += chunk.byteLength;
  });
  const gzipFinished = finished(gzip);
  const file = destination ? createWriteStream(destination, { flags: "wx" }) : undefined;
  const fileFinished = file ? finished(file) : undefined;
  try {
    for (const value of coalesceChunks(chunks)) {
      const chunk = Buffer.from(value);
      bytes += chunk.byteLength;
      peakChunkBytes = Math.max(peakChunkBytes, chunk.byteLength);
      hash.update(chunk);
      if (retained) retained.push(value);
      const fileDrain = file ? writeWithBackpressure(file, chunk) : undefined;
      const gzipDrain = writeWithBackpressure(gzip, chunk);
      if (fileDrain || gzipDrain) {
        await Promise.all([...(fileDrain ? [fileDrain] : []), ...(gzipDrain ? [gzipDrain] : [])]);
      }
    }
    if (file) file.end();
    gzip.end();
    await Promise.all([gzipFinished, ...(fileFinished ? [fileFinished] : [])]);
  } catch (error) {
    file?.destroy();
    gzip.destroy();
    await Promise.allSettled([gzipFinished, ...(fileFinished ? [fileFinished] : [])]);
    throw error;
  }
  return {
    metadata: { bytes, gzipBytes, sha256: hash.digest("hex") },
    peakChunkBytes,
    ...(retained ? { content: retained.join("") } : {}),
  };
}

function sortedRecord(record = {}) {
  return Object.fromEntries(Object.entries(record).sort(([left], [right]) =>
    left.localeCompare(right)));
}

/**
 * Produce deterministically ordered, opt-in build-stage events. Timing and
 * process memory values are observations only and never enter an artifact.
 */
export function createBuildStageTelemetry({
  emit,
  now = () => performance.now(),
  memoryUsage = () => process.memoryUsage(),
} = {}) {
  if (typeof emit !== "function") throw new TypeError("telemetry emit must be a function");
  let sequence = 0;
  const sample = (stage, phase, startedAt, counts, structures, elapsedOverride) => {
    const memory = memoryUsage();
    emit({
      schemaVersion: 1,
      sequence: ++sequence,
      stage,
      phase,
      elapsedMs: elapsedOverride ?? Number(Math.max(0, now() - startedAt).toFixed(3)),
      counts: sortedRecord(counts),
      memory: {
        heapUsed: memory.heapUsed,
        heapTotal: memory.heapTotal,
        external: memory.external,
        rss: memory.rss,
        ...(memory.arrayBuffers === undefined ? {} : { arrayBuffers: memory.arrayBuffers }),
      },
      structures: [...new Set(structures ?? [])].sort(),
    });
  };
  return {
    start(stage, counts = {}, structures = []) {
      const startedAt = now();
      sample(stage, "begin", startedAt, counts, structures, 0);
      return { stage, startedAt, structures };
    },
    sample(token, counts = {}, structures = token.structures) {
      sample(token.stage, "sample", token.startedAt, counts, structures);
    },
    end(token, counts = {}, structures = token.structures) {
      sample(token.stage, "end", token.startedAt, counts, structures);
    },
  };
}

function beginStage(telemetry, stage, counts, structures) {
  return telemetry?.start(stage, counts, structures);
}

function sampleStage(telemetry, token, counts, structures) {
  if (token) telemetry.sample(token, counts, structures);
}

function endStage(telemetry, token, counts, structures) {
  if (token) telemetry.end(token, counts, structures);
}

function osmSnapshotRecordCount(snapshot) {
  return (snapshot?.nodes?.length ?? 0) + (snapshot?.ways?.length ?? 0) +
    (snapshot?.relations?.length ?? 0) + (snapshot?.accessNodes?.length ?? 0);
}

function createMemoryArtifactWriter() {
  const payloads = {};
  return {
    payloads,
    retainsPayloads: true,
    async write(filename, chunks) {
      const result = await serializeArtifact(chunks, { retain: true });
      payloads[filename] = result.content;
      return result;
    },
  };
}

function isManagedArtifact(filename) {
  if (Object.values(ARTIFACT_FILENAMES).includes(filename) ||
      OBSOLETE_MANAGED_ARTIFACTS.includes(filename)) return true;
  const [directory, leaf, ...rest] = filename.split("/");
  return rest.length === 0 && MANAGED_SHARD_PATTERNS[directory]?.test(leaf);
}

async function copyUnmanagedTree(source, destination, relative = "") {
  let entries;
  try {
    entries = await readdir(source, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  await mkdir(destination, { recursive: true });
  for (const entry of entries) {
    const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
    if (isManagedArtifact(childRelative)) continue;
    if (!relative && Object.hasOwn(MANAGED_SHARD_PATTERNS, entry.name) &&
        !entry.isDirectory()) continue;
    const sourcePath = join(source, entry.name);
    const destinationPath = join(destination, entry.name);
    if (entry.isDirectory()) {
      await copyUnmanagedTree(sourcePath, destinationPath, childRelative);
    } else {
      await cp(sourcePath, destinationPath, { force: false, verbatimSymlinks: true });
    }
  }
}

/** Create a sibling staging tree whose managed files become visible only at commit. */
export async function createStreamingArtifactWriter(
  outputDirectory,
  { beforeArtifact, beforeActivation } = {},
) {
  if (typeof outputDirectory !== "string" || !outputDirectory) {
    throw new TypeError("outputDirectory is required");
  }
  const destination = resolve(outputDirectory);
  const parent = dirname(destination);
  await mkdir(parent, { recursive: true });
  const stagingDirectory = await mkdtemp(join(parent, `.${basename(destination)}.tmp-`));
  await copyUnmanagedTree(destination, stagingDirectory);
  let artifactCount = 0;
  let committed = false;
  return {
    retainsPayloads: false,
    stagingDirectory,
    async write(filename, chunks) {
      if (committed) throw new Error("artifact writer is already committed");
      if (isManagedArtifact(filename) === false || filename.includes("..")) {
        throw new TypeError(`refusing unmanaged artifact path ${JSON.stringify(filename)}`);
      }
      artifactCount += 1;
      await beforeArtifact?.({ filename, artifactCount, stagingDirectory });
      const artifactPath = resolve(stagingDirectory, filename);
      await mkdir(dirname(artifactPath), { recursive: true });
      return serializeArtifact(chunks, { destination: artifactPath });
    },
    async commit() {
      if (committed) throw new Error("artifact writer is already committed");
      let existing = true;
      try {
        await readdir(destination);
      } catch (error) {
        if (error?.code === "ENOENT") existing = false;
        else throw error;
      }
      if (!existing) {
        await rename(stagingDirectory, destination);
      } else {
        const backupDirectory = await mkdtemp(join(parent, `.${basename(destination)}.old-`));
        await rm(backupDirectory, { recursive: true });
        await rename(destination, backupDirectory);
        try {
          await beforeActivation?.({ destination, stagingDirectory, backupDirectory });
          await rename(stagingDirectory, destination);
        } catch (error) {
          await rename(backupDirectory, destination);
          throw error;
        }
        await rm(backupDirectory, { recursive: true });
      }
      committed = true;
      return destination;
    },
    async abort() {
      if (!committed) await rm(stagingDirectory, { recursive: true, force: true });
    },
  };
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

function coordinateInBounds([longitude, latitude], [west, south, east, north]) {
  return longitude >= west && longitude <= east && latitude >= south && latitude <= north;
}

function regionalRecordId(record, index) {
  return record?.id ?? record?.sourceRefs?.map(({ provider, sourceId }) =>
    `${provider}:${sourceId}`).sort().join("|") ?? `index:${index}`;
}

function applyRegionBounds(arrays, region) {
  const omitted = [];
  const filter = (records, kind, coordinates) => records.filter((record, index) => {
    const positions = coordinates(record);
    const inside = positions.length > 0 && positions.every((position) =>
      coordinateInBounds(position, region.bbox));
    if (!inside) omitted.push({
      type: "out-of-region-record",
      kind,
      recordId: regionalRecordId(record, index),
      rule: "omit-unless-fully-contained",
      resolution: "omitted-by-documented-full-containment-rule",
    });
    return inside;
  });
  const boundedSegmentCandidates = filter(
    arrays.segmentCandidates,
    "segment",
    (record) => record.geometry?.coordinates ?? [],
  );
  const segmentCandidates = boundedSegmentCandidates.filter((record, index) => {
    if (geodesicLineLengthMeters(record.geometry) > 0) return true;
    omitted.push({
      type: "degenerate-segment",
      kind: "segment",
      recordId: regionalRecordId(record, index),
      resolution: "omitted-zero-length-geometry",
    });
    return false;
  });
  const sourceNodes = filter(
    arrays.sourceNodes,
    "node",
    (record) => [[record.longitude, record.latitude]],
  );
  const accessPointCandidates = filter(
    arrays.accessPointCandidates,
    "access-candidate",
    (record) => [record.geometry?.coordinates ?? record.coordinates ?? record.coordinate ??
      [record.longitude, record.latitude]],
  );
  const regionalNodeIds = new Set(sourceNodes.map(({ id }) => String(id)));
  const publicRoadNodeIds = arrays.publicRoadNodeIds.filter((id) => regionalNodeIds.has(String(id)));
  omitted.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return {
    arrays: { segmentCandidates, sourceNodes, accessPointCandidates, publicRoadNodeIds },
    issues: omitted,
    stats: {
      rule: "omit-unless-fully-contained",
      omittedSegments: omitted.filter(({ kind }) => kind === "segment").length,
      omittedNodes: omitted.filter(({ kind }) => kind === "node").length,
      omittedAccessCandidates: omitted.filter(({ kind }) => kind === "access-candidate").length,
      omittedDegenerateSegments: omitted.filter(({ type }) => type === "degenerate-segment").length,
    },
  };
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
  const nodeElevations = {};
  for (const segment of segments) {
    const profile = elevationSource
      ? await sampleElevationProfile(segment.geometry, elevationSource, elevationOptions)
      : [];
    const result = applyElevationMetrics(segment, profile, elevationOptions);
    validateTrailSegment(result);
    enriched.push(result);
    if (profile?.coverage === "complete" && profile.samples.length >= 2) {
      nodeElevations[segment.fromNodeId] = profile.samples[0].elevationMeters;
      nodeElevations[segment.toNodeId] = profile.samples.at(-1).elevationMeters;
    }
  }
  return {
    segments: enriched.sort((left, right) => left.id.localeCompare(right.id)),
    nodeElevations: Object.fromEntries(Object.entries(nodeElevations).sort()),
  };
}

function shippedProvenance(
  segments,
  mergeProvenance,
  elevationSource,
  elevationOptions,
  metrics = {},
) {
  // buildRegionArtifacts owns mergeProvenance after reconciliation. Reuse that
  // ownership instead of retaining a full structured clone through every later
  // build stage.
  const result = mergeProvenance;
  metrics.reusedMergeProvenance = 1;
  metrics.elevationObservations = 0;
  metrics.sharedElevationSourceFields = 0;
  if (!elevationSource) return result;
  const metadata = createElevationManifestMetadata(elevationSource, elevationOptions);
  const source = metadata.source;
  const sourceId = `${source.product}@${source.version}`;
  const sourceField = {
    product: source.product,
    version: source.version,
    sampling: metadata.sampling,
    smoothing: metadata.smoothing,
  };
  metrics.sharedElevationSourceFields = 1;
  for (const segment of segments) {
    const fields = result[segment.id] ?? {};
    for (const field of [
      "ascentForwardMeters",
      "descentForwardMeters",
      "minElevationMeters",
      "maxElevationMeters",
      "maxGradePct",
    ]) {
      if (segment[field] === undefined) continue;
      fields[field] = [{
        provider: source.provider,
        sourceId,
        value: segment[field],
        authority: Number.MAX_SAFE_INTEGER,
        selected: true,
        sourceField,
      }];
      metrics.elevationObservations += 1;
    }
    result[segment.id] = fields;
  }
  return result;
}

function dictionaryIndex(values, indexes, value) {
  const key = stableJson(value);
  if (!indexes.has(key)) {
    indexes.set(key, values.length);
    values.push(value);
  }
  return indexes.get(key);
}

/** Compact repeated field observations while preserving every selected and losing value. */
export function compactSegmentProvenance(provenance) {
  const fields = [];
  const providers = [];
  const sourceIds = [];
  const values = [];
  const sourceFields = [];
  const indexes = {
    fields: new Map(),
    providers: new Map(),
    sourceIds: new Map(),
    values: new Map(),
    sourceFields: new Map(),
  };
  const segments = Object.keys(provenance).sort().map((segmentId) => [
    segmentId,
    Object.keys(provenance[segmentId]).sort().map((field) => [
      dictionaryIndex(fields, indexes.fields, field),
      provenance[segmentId][field].map((entry) => [
        dictionaryIndex(providers, indexes.providers, entry.provider),
        dictionaryIndex(sourceIds, indexes.sourceIds, entry.sourceId),
        dictionaryIndex(values, indexes.values, entry.value),
        entry.authority,
        entry.selected ? 1 : 0,
        entry.sourceField === undefined
          ? -1
          : dictionaryIndex(sourceFields, indexes.sourceFields, entry.sourceField),
      ]),
    ]),
  ]);
  return {
    schemaVersion: 2,
    regionEncoding: "field-observation-dictionaries-v1",
    dictionaries: { fields, providers, sourceIds, values, sourceFields },
    segments,
  };
}

export function expandSegmentProvenance(compact) {
  if (compact?.schemaVersion !== 2 ||
      compact.regionEncoding !== "field-observation-dictionaries-v1") {
    throw new TypeError("unsupported compact segment provenance encoding");
  }
  const { fields, providers, sourceIds, values, sourceFields } = compact.dictionaries;
  return Object.fromEntries(compact.segments.map(([segmentId, observations]) => [
    segmentId,
    Object.fromEntries(observations.map(([fieldIndex, entries]) => [
      fields[fieldIndex],
      entries.map(([providerIndex, sourceIdIndex, valueIndex, authority, selected, sourceField]) => ({
        provider: providers[providerIndex],
        sourceId: sourceIds[sourceIdIndex],
        value: structuredClone(values[valueIndex]),
        authority,
        selected: selected === 1,
        ...(sourceField < 0 ? {} : { sourceField: structuredClone(sourceFields[sourceField]) }),
      })),
    ])),
  ]));
}

function artifactPartition(id) {
  const match = /_([a-f0-9])/.exec(id);
  if (!match) throw new TypeError(`artifact record id ${JSON.stringify(id)} has no hex partition`);
  return match[1];
}

function partitionRecords(records, id = (record) => record.id) {
  const partitions = Object.fromEntries("0123456789abcdef".split("").map((prefix) => [prefix, []]));
  for (const record of records) partitions[artifactPartition(id(record))].push(record);
  return partitions;
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
  const orderedIds = segments.map(({ id }) => id).sort();
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
  let seedIndex = 0;
  while (pending.size > 0) {
    while (!pending.has(orderedIds[seedIndex])) seedIndex += 1;
    const first = orderedIds[seedIndex];
    const queue = [first];
    const ids = [];
    pending.delete(first);
    for (let queueIndex = 0; queueIndex < queue.length; queueIndex += 1) {
      const id = queue[queueIndex];
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

function accessGraph(segments) {
  const adjacency = new Map();
  for (const segment of segments.filter(({ hiking, access, status }) =>
    hiking !== "blocked" && access !== "private" && status !== "closed")) {
    for (const [from, to] of [
      [segment.fromNodeId, segment.toNodeId],
      [segment.toNodeId, segment.fromNodeId],
    ]) {
      const edges = adjacency.get(from) ?? [];
      edges.push({ to, lengthMeters: segment.lengthMeters });
      adjacency.set(from, edges);
    }
  }
  return adjacency;
}

function compareReachabilityEntries(left, right) {
  return left.distance - right.distance || left.id.localeCompare(right.id);
}

class IndexedMinQueue {
  #entries = [];

  #indexes = new Map();

  get size() {
    return this.#entries.length;
  }

  upsert(id, distance) {
    const existingIndex = this.#indexes.get(id);
    if (existingIndex !== undefined) {
      if (distance >= this.#entries[existingIndex].distance) return;
      this.#entries[existingIndex].distance = distance;
      this.#bubbleUp(existingIndex);
      return;
    }
    const index = this.#entries.length;
    this.#entries.push({ id, distance });
    this.#indexes.set(id, index);
    this.#bubbleUp(index);
  }

  pop() {
    if (this.#entries.length === 0) return undefined;
    const first = this.#entries[0];
    const last = this.#entries.pop();
    this.#indexes.delete(first.id);
    if (this.#entries.length > 0) {
      this.#entries[0] = last;
      this.#indexes.set(last.id, 0);
      this.#bubbleDown(0);
    }
    return first;
  }

  #bubbleUp(startIndex) {
    let index = startIndex;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (compareReachabilityEntries(this.#entries[parent], this.#entries[index]) <= 0) break;
      this.#swap(parent, index);
      index = parent;
    }
  }

  #bubbleDown(startIndex) {
    let index = startIndex;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      let smallest = index;
      if (left < this.#entries.length &&
          compareReachabilityEntries(this.#entries[left], this.#entries[smallest]) < 0) {
        smallest = left;
      }
      if (right < this.#entries.length &&
          compareReachabilityEntries(this.#entries[right], this.#entries[smallest]) < 0) {
        smallest = right;
      }
      if (smallest === index) return;
      this.#swap(index, smallest);
      index = smallest;
    }
  }

  #swap(left, right) {
    [this.#entries[left], this.#entries[right]] = [this.#entries[right], this.#entries[left]];
    this.#indexes.set(this.#entries[left].id, left);
    this.#indexes.set(this.#entries[right].id, right);
  }
}

function visitReachableNodes(point, adjacency, visit, maximumMeters = 2_000) {
  const distances = new Map(point.connectedNodeIds.map((id) => [id, 0]));
  const pending = new IndexedMinQueue();
  for (const id of distances.keys()) {
    pending.upsert(id, 0);
    visit(id);
  }
  let maximumPendingNodes = pending.size;
  while (pending.size > 0) {
    const current = pending.pop();
    if (current.distance > maximumMeters) continue;
    for (const edge of adjacency.get(current.id) ?? []) {
      const distance = current.distance + edge.lengthMeters;
      if (distance > maximumMeters || distance >= (distances.get(edge.to) ?? Infinity)) continue;
      const firstVisit = !distances.has(edge.to);
      distances.set(edge.to, distance);
      pending.upsert(edge.to, distance);
      if (firstVisit) visit(edge.to);
      maximumPendingNodes = Math.max(maximumPendingNodes, pending.size);
    }
  }
  return { maximumPendingNodes, reachableNodes: distances.size };
}

export function buildNamedTrails(segments, accessPoints, onProgress) {
  const eligible = segments.filter(({ name, hiking, access, status }) =>
    name && hiking !== "blocked" && access !== "private" && status !== "closed");
  const namedGroups = new Map();
  for (const segment of eligible) {
    const key = `${normalizeSegmentText(segment.name)}\u0000${normalizeSegmentText(segment.manager) ?? ""}`;
    const values = namedGroups.get(key) ?? [];
    values.push(segment);
    namedGroups.set(key, values);
  }
  const adjacency = accessGraph(segments);
  const components = [];
  const componentIdsByNode = new Map();
  for (const segmentsWithName of namedGroups.values()) {
    for (const group of componentGroups(segmentsWithName)) {
      const componentId = components.length;
      components.push({ group, accessPointIds: new Set() });
      const groupNodeIds = new Set(group.flatMap(({ fromNodeId, toNodeId }) =>
        [fromNodeId, toNodeId]));
      for (const nodeId of groupNodeIds) {
        const ids = componentIdsByNode.get(nodeId) ?? [];
        ids.push(componentId);
        componentIdsByNode.set(nodeId, ids);
      }
    }
  }
  const metrics = {
    accessPointComponentAssociations: 0,
    accessPointsProcessed: 0,
    componentIndexedNodes: componentIdsByNode.size,
    maximumPendingReachabilityNodes: 0,
    maximumReachableNodesPerPoint: 0,
    namedComponents: components.length,
    reachableNodeVisits: 0,
    retainedReachabilitySets: 0,
  };
  onProgress?.("component-index", metrics);
  for (const point of accessPoints) {
    const traversal = visitReachableNodes(point, adjacency, (nodeId) => {
      metrics.reachableNodeVisits += 1;
      for (const componentId of componentIdsByNode.get(nodeId) ?? []) {
        const ids = components[componentId].accessPointIds;
        if (!ids.has(point.id)) {
          ids.add(point.id);
          metrics.accessPointComponentAssociations += 1;
        }
      }
    });
    metrics.accessPointsProcessed += 1;
    metrics.maximumPendingReachabilityNodes = Math.max(
      metrics.maximumPendingReachabilityNodes,
      traversal.maximumPendingNodes,
    );
    metrics.maximumReachableNodesPerPoint = Math.max(
      metrics.maximumReachableNodesPerPoint,
      traversal.reachableNodes,
    );
    if (metrics.accessPointsProcessed % 1_000 === 0 ||
        metrics.accessPointsProcessed === accessPoints.length) {
      onProgress?.("reachability", metrics);
    }
  }
  const pointsById = new Map(accessPoints.map((point) => [point.id, point]));
  const trails = [];
  for (const { group, accessPointIds } of components) {
    const points = [...accessPointIds].map((id) => pointsById.get(id))
      .sort((left, right) => left.id.localeCompare(right.id));
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

/** Build canonical records, retaining payload strings only for the fixture API by default. */
export async function buildRegionArtifacts(input, { telemetry, artifactWriter } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("input must be an object");
  }
  const region = requireRegion(input.regionId);
  const reconciliationStage = beginStage(telemetry, "agency-osm-reconciliation-merge", {
    inputSegmentCandidates: (input.segmentCandidates ?? input.segments ?? []).length,
  }, ["normalized-segment-candidates", "merge-candidate-index", "field-provenance"]);
  const regional = applyRegionBounds(inputArrays(input), region);
  const arrays = regional.arrays;
  const reconciliation = reconcileAgencyGeometryWithOsmTopology(
    arrays.segmentCandidates,
    input.reconciliationOptions,
  );
  sampleStage(telemetry, reconciliationStage, {
    reconciledCandidates: reconciliation.candidates.length,
    reconciliationIssues: reconciliation.issues.length,
  }, ["regional-segment-candidates", "reconciled-segment-candidates"]);
  const merged = mergeTrailSegments(reconciliation.candidates, input.mergeOptions);
  sampleStage(telemetry, reconciliationStage, {
    mergeConflicts: merged.conflicts.length,
    mergedSegments: merged.segments.length,
  }, ["reconciled-segment-candidates", "merged-segments", "field-provenance"]);
  const degenerateMergedIds = new Set(merged.segments
    .filter(({ lengthMeters }) => lengthMeters === 0)
    .map(({ id }) => id));
  const mergedSegments = merged.segments.filter(({ id }) => !degenerateMergedIds.has(id));
  const mergedProvenance = Object.fromEntries(Object.entries(merged.provenance)
    .filter(([segmentId]) => !degenerateMergedIds.has(segmentId)));
  merged.provenance = undefined;
  const mergeConflicts = merged.conflicts.filter(({ segmentId }) =>
    !degenerateMergedIds.has(segmentId));
  const degenerateIssues = [...degenerateMergedIds].sort().map((segmentId) => ({
    type: "degenerate-segment",
    kind: "segment",
    recordId: segmentId,
    stage: "post-merge-topology-alignment",
    resolution: "omitted-zero-length-geometry",
  }));
  regional.stats.omittedDegenerateSegments += degenerateIssues.length;
  endStage(telemetry, reconciliationStage, {
    mergeConflicts: mergeConflicts.length,
    mergedSegments: mergedSegments.length,
    reconciledCandidates: reconciliation.candidates.length,
    regionalCandidates: arrays.segmentCandidates.length,
  }, ["regional-segment-candidates", "merged-segments", "field-provenance"]);
  const elevationStage = beginStage(telemetry, "elevation-enrichment", {
    segments: mergedSegments.length,
  }, ["merged-segments", "elevation-samples", "enriched-segments", "node-elevations"]);
  const enrichment = await enrichSegments(
    mergedSegments,
    input.elevationSource,
    input.elevationOptions,
  );
  const segments = enrichment.segments;
  endStage(telemetry, elevationStage, {
    enrichedSegments: segments.length,
    nodeElevations: Object.keys(enrichment.nodeElevations).length,
  }, ["merged-segments", "enriched-segments", "node-elevations"]);
  const provenanceStage = beginStage(telemetry, "provenance-preparation", {
    mergeProvenanceSegments: Object.keys(mergedProvenance).length,
    segments: segments.length,
  }, ["merge-field-provenance", "elevation-field-provenance"]);
  const provenanceMetrics = {};
  const segmentProvenance = shippedProvenance(
    segments,
    mergedProvenance,
    input.elevationSource,
    input.elevationOptions,
    provenanceMetrics,
  );
  endStage(telemetry, provenanceStage, {
    ...provenanceMetrics,
    provenanceSegments: Object.keys(segmentProvenance).length,
  }, [
    "owned-merge-field-provenance",
    ...(input.elevationSource ? ["shared-elevation-source-field-metadata"] : []),
  ]);
  const constructionStage = beginStage(telemetry, "node-access-named-trail-construction", {
    segments: segments.length,
    sourceNodes: arrays.sourceNodes.length,
  }, ["segments", "canonical-nodes", "access-graph", "named-trail-groups"]);
  const nodes = buildCanonicalNodes(segments, arrays.sourceNodes);
  sampleStage(telemetry, constructionStage, {
    nodes: nodes.length,
    segments: segments.length,
  }, ["segments", "canonical-nodes"]);
  const access = buildAccessPoints({
    nodes,
    segments,
    candidates: arrays.accessPointCandidates,
    publicRoadNodeIds: arrays.publicRoadNodeIds,
  }, input.accessPointOptions);
  access.accessPoints.forEach(validateAccessPoint);
  sampleStage(telemetry, constructionStage, {
    accessIssues: access.issues.length,
    accessPoints: access.accessPoints.length,
    nodes: nodes.length,
    segments: segments.length,
  }, ["segments", "canonical-nodes", "access-points"]);
  const namedTrails = buildNamedTrails(segments, access.accessPoints, (phase, counts) => {
    sampleStage(telemetry, constructionStage, counts, [
      "segments",
      "canonical-nodes",
      "access-points",
      "access-graph",
      "named-component-node-index",
      "named-component-access-sets",
      ...(phase === "reachability" ? [
        "one-access-point-distance-map",
        "indexed-min-priority-queue",
      ] : []),
    ]);
  });
  endStage(telemetry, constructionStage, {
    accessPoints: access.accessPoints.length,
    namedTrails: namedTrails.length,
    nodes: nodes.length,
    segments: segments.length,
  }, ["segments", "canonical-nodes", "access-points", "named-trails"]);
  const partitionStage = beginStage(telemetry, "partitioning", {
    provenanceSegments: Object.keys(segmentProvenance).length,
    segments: segments.length,
  }, ["segments", "shipped-field-provenance", "partition-arrays"]);
  const segmentPartitions = partitionRecords(segments);
  const provenancePartitions = partitionRecords(
    Object.entries(segmentProvenance),
    ([segmentId]) => segmentId,
  );
  const segmentShardPaths = Object.fromEntries(Object.keys(segmentPartitions).map(
    (prefix) => [prefix, `segments/${prefix}.ndjson`],
  ));
  const provenanceShardPaths = Object.fromEntries(Object.entries(provenancePartitions).map(
    ([prefix]) => [prefix, `segment-provenance/${prefix}.json`],
  ));
  endStage(telemetry, partitionStage, {
    provenancePartitions: Object.keys(provenancePartitions).length,
    segmentPartitions: Object.keys(segmentPartitions).length,
  }, ["segments", "shipped-field-provenance", "partition-arrays"]);
  const writer = artifactWriter ?? createMemoryArtifactWriter();
  const provenanceCompactionStage = beginStage(telemetry, "provenance-compaction", {
    provenancePartitions: Object.keys(provenancePartitions).length,
  }, ["partitioned-field-provenance", "one-partition-compaction-dictionaries"]);
  const serializationStage = beginStage(telemetry, "json-serialization", {
    provenancePartitions: Object.keys(provenancePartitions).length,
    segmentPartitions: Object.keys(segmentPartitions).length,
  }, [
    "canonical-records",
    "partition-arrays",
    ...(writer.retainsPayloads ? ["fixture-payload-strings"] : ["current-artifact-chunks"]),
  ]);
  const hashingStage = beginStage(telemetry, "hashing", {}, [
    "incremental-sha256-state",
    ...(writer.retainsPayloads ? ["fixture-payload-strings"] : []),
  ]);
  const compressionStage = beginStage(telemetry, "compression-measurement", {}, [
    "streaming-gzip-state",
    ...(writer.retainsPayloads ? ["fixture-payload-strings"] : []),
  ]);
  const measuredArtifactFiles = {};
  let artifactsWritten = 0;
  let serializedBytes = 0;
  let peakChunkBytes = 0;
  const writeArtifact = async (filename, chunks) => {
    const result = await writer.write(filename, chunks);
    measuredArtifactFiles[filename] = result.metadata;
    artifactsWritten += 1;
    serializedBytes += result.metadata.bytes;
    peakChunkBytes = Math.max(peakChunkBytes, result.peakChunkBytes);
    const counts = {
      artifactsWritten,
      artifactBytes: result.metadata.bytes,
      gzipBytes: result.metadata.gzipBytes,
      peakChunkBytes,
      retainedSerializedBytes: writer.retainsPayloads ? serializedBytes : 0,
      serializedBytes,
    };
    sampleStage(telemetry, serializationStage, counts);
    sampleStage(telemetry, hashingStage, counts);
    sampleStage(telemetry, compressionStage, counts);
    return result.metadata;
  };

  const fixedArtifacts = [
    [ARTIFACT_FILENAMES.namedTrails, prettyJsonChunks({
      schemaVersion: 1,
      regionId: region.id,
      trails: namedTrails,
    })],
    [ARTIFACT_FILENAMES.accessPoints, prettyJsonChunks(accessPointGeoJson(access.accessPoints))],
    [ARTIFACT_FILENAMES.segments, prettyJsonChunks({
      schemaVersion: 1,
      regionId: region.id,
      partitionRule: "first hexadecimal character after segment_",
      shards: Object.fromEntries(Object.entries(segmentShardPaths).map(([prefix, path]) => [
        prefix,
        { path, records: segmentPartitions[prefix].length },
      ])),
    })],
    [ARTIFACT_FILENAMES.nodes, ndjsonChunks(nodes)],
    [ARTIFACT_FILENAMES.segmentProvenance, prettyJsonChunks({
      schemaVersion: 2,
      regionId: region.id,
      encoding: "field-observation-dictionaries-v1",
      partitionRule: "first hexadecimal character after segment_",
      shards: Object.fromEntries(Object.entries(provenanceShardPaths).map(([prefix, path]) => [
        prefix,
        { path, records: provenancePartitions[prefix].length },
      ])),
    })],
  ];
  for (const [filename, chunks] of fixedArtifacts) await writeArtifact(filename, chunks);
  for (const [prefix, path] of Object.entries(segmentShardPaths)) {
    await writeArtifact(path, ndjsonChunks(segmentPartitions[prefix]));
  }
  for (const [index, [prefix, path]] of Object.entries(provenanceShardPaths).entries()) {
    const compact = {
      ...compactSegmentProvenance(Object.fromEntries(provenancePartitions[prefix])),
      regionId: region.id,
      partition: prefix,
    };
    const metadata = await writeArtifact(path, compactJsonLineChunks(compact));
    sampleStage(telemetry, provenanceCompactionStage, {
      partitionRecords: provenancePartitions[prefix].length,
      partitionsCompacted: index + 1,
      serializedBytes: metadata.bytes,
    });
  }
  endStage(telemetry, provenanceCompactionStage, {
    partitionsCompacted: Object.keys(provenanceShardPaths).length,
  });
  const dataArtifactHashes = structuredClone(measuredArtifactFiles);
  const qaStage = beginStage(telemetry, "qa", {
    accessPoints: access.accessPoints.length,
    namedTrails: namedTrails.length,
    nodes: nodes.length,
    segments: segments.length,
  }, ["canonical-records", "field-provenance", "data-artifact-metadata", "qa-indexes"]);
  const qa = buildQaReport({
    region,
    input: arrays,
    segments,
    nodes,
    accessPoints: access.accessPoints,
    namedTrails,
    mergeConflicts,
    accessIssues: access.issues,
    pipelineIssues: [
      ...(input.pipelineIssues ?? []),
      ...regional.issues,
      ...reconciliation.issues,
      ...degenerateIssues,
    ],
    regionalFiltering: regional.stats,
    reconciliation: reconciliation.stats,
    segmentProvenance,
    elevationQa: { nodeElevations: enrichment.nodeElevations },
    sourceManifest: input.sourceManifest,
    artifactHashes: dataArtifactHashes,
  });
  endStage(telemetry, qaStage, {
    issues: qa.issues.length,
    segments: segments.length,
  }, ["canonical-records", "field-provenance", "data-artifact-metadata", "qa-report"]);
  await writeArtifact(ARTIFACT_FILENAMES.qa, prettyJsonChunks(qa));
  const artifactFiles = Object.fromEntries(Object.entries(measuredArtifactFiles).map(
    ([filename, metadata]) => [filename, { path: filename, ...metadata }],
  ));
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
    ...(input.sourceManifest ? { sources: input.sourceManifest } : {}),
    delivery: {
      eagerMetadata: [ARTIFACT_FILENAMES.namedTrails, ARTIFACT_FILENAMES.accessPoints],
      lazyGeometryIndex: ARTIFACT_FILENAMES.segments,
      lazyProvenanceIndex: ARTIFACT_FILENAMES.segmentProvenance,
      partitionRule: "segment id first hexadecimal character",
    },
    artifacts: artifactFiles,
  };
  await writeArtifact(ARTIFACT_FILENAMES.manifest, prettyJsonChunks(manifest));
  const finalCounts = {
    artifactsWritten,
    peakChunkBytes,
    retainedSerializedBytes: writer.retainsPayloads ? serializedBytes : 0,
    serializedBytes,
  };
  endStage(telemetry, serializationStage, finalCounts);
  endStage(telemetry, hashingStage, finalCounts);
  endStage(telemetry, compressionStage, finalCounts);
  return {
    region,
    manifest,
    qa,
    namedTrails,
    accessPoints: access.accessPoints,
    segments,
    nodes,
    segmentProvenance,
    ...(writer.payloads ? { payloads: writer.payloads } : {}),
  };
}

export async function writeRegionArtifacts(result, outputDirectory) {
  if (!result?.payloads || typeof outputDirectory !== "string" || !outputDirectory) {
    throw new TypeError("result and outputDirectory are required");
  }
  const writer = await createStreamingArtifactWriter(outputDirectory);
  try {
    const entries = Object.entries(result.payloads).sort(([left], [right]) =>
      Number(left === ARTIFACT_FILENAMES.manifest) -
      Number(right === ARTIFACT_FILENAMES.manifest));
    for (const [filename, content] of entries) await writer.write(filename, [content]);
    return await writer.commit();
  } catch (error) {
    await writer.abort();
    throw error;
  }
}

export async function buildRegionFromFile(inputPath, {
  outputDirectory,
  regionId,
  telemetry,
  beforeArtifact,
  beforeActivation,
} = {}) {
  const snapshotStage = beginStage(telemetry, "snapshot-loading-normalization", {
    inputFiles: 1,
  }, ["input-json-string", "parsed-build-input", "normalized-agency-candidates"]);
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
  input.accessPointCandidates ??= [];
  input.publicRoadNodeIds ??= [];
  input.pipelineIssues ??= [];
  if (!Array.isArray(input.segmentCandidates)) {
    throw new TypeError("segmentCandidates must be an array");
  }
  if (!Array.isArray(input.sourceNodes)) throw new TypeError("sourceNodes must be an array");
  if (!Array.isArray(input.accessPointCandidates)) {
    throw new TypeError("accessPointCandidates must be an array");
  }
  if (!Array.isArray(input.publicRoadNodeIds)) {
    throw new TypeError("publicRoadNodeIds must be an array");
  }
  if (!Array.isArray(input.pipelineIssues)) throw new TypeError("pipelineIssues must be an array");
  if (input.sourceManifestPath) {
    input.sourceManifest = JSON.parse(await readFile(
      resolve(inputDirectory, input.sourceManifestPath),
      "utf8",
    ));
  }
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
      input.segmentCandidates = input.segmentCandidates.concat(adapter.normalizeSnapshot(snapshot));
    }
  }
  let osmSnapshot;
  if (input.osmSnapshotPath) {
    osmSnapshot = await readOsmSnapshot(
      resolve(inputDirectory, input.osmSnapshotPath),
      input.osmSnapshotOptions,
    );
  }
  const osmRecords = osmSnapshotRecordCount(osmSnapshot);
  if (osmSnapshot) {
    const topologyStage = beginStage(telemetry, "osm-topology-construction", {
      osmRecords,
    }, ["parsed-osm-snapshot", "osm-node-way-indexes", "topology-segments"]);
    const topology = buildOsmTopology(osmSnapshot);
    input.segmentCandidates = input.segmentCandidates.concat(topology.segments);
    input.sourceNodes = input.sourceNodes.concat(topology.nodes);
    input.accessPointCandidates = input.accessPointCandidates.concat(
      osmSnapshot.accessPointCandidates ?? [],
    );
    const roadSourceIds = new Set(osmSnapshot.publicRoadSourceNodeIds ?? []);
    input.publicRoadNodeIds = input.publicRoadNodeIds.concat(topology.nodes.filter((node) =>
      node.sourceNodeIds.some((sourceId) => roadSourceIds.has(sourceId))).map(({ id }) => id));
    input.pipelineIssues = input.pipelineIssues.concat(topology.issues);
    endStage(telemetry, topologyStage, {
      issues: topology.issues.length,
      nodes: topology.nodes.length,
      publicRoadNodes: input.publicRoadNodeIds.length,
      segments: topology.segments.length,
    }, ["parsed-osm-snapshot", "topology-nodes", "topology-segments"]);
    osmSnapshot = undefined;
  }
  if (input.elevationGridPath) {
    const gridPath = resolve(inputDirectory, input.elevationGridPath);
    input.elevationSource = createCachedElevationGridSource(
      JSON.parse(await readFile(gridPath, "utf8")),
    );
  }
  if (input.elevationTilesPath) {
    input.elevationSource = await loadCachedElevationTiles(
      resolve(inputDirectory, input.elevationTilesPath),
    );
  }
  endStage(telemetry, snapshotStage, {
    accessPointCandidates: input.accessPointCandidates.length,
    normalizedSegmentCandidates: input.segmentCandidates.length,
    osmRecords,
    sourceNodes: input.sourceNodes.length,
  }, [
    "parsed-build-input",
    "normalized-agency-candidates",
    "normalized-osm-topology",
    ...(input.elevationSource ? ["cached-elevation-source"] : []),
  ]);
  const destination = outputDirectory ?? resolve(
    "data/trails/generated",
    input.regionId,
  );
  const writer = await createStreamingArtifactWriter(destination, {
    beforeArtifact,
    beforeActivation,
  });
  try {
    const result = await buildRegionArtifacts(input, { telemetry, artifactWriter: writer });
    await writer.commit();
    return { ...result, outputDirectory: destination };
  } catch (error) {
    await writer.abort();
    throw error;
  }
}

function commandLineOptions(argv) {
  const options = {};
  for (const argument of argv) {
    const match = /^--(region|input|output|telemetry)=(.+)$/.exec(argument);
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
  let telemetry;
  if (options.telemetry) {
    const telemetryPath = resolve(options.telemetry);
    writeFileSync(telemetryPath, "");
    telemetry = createBuildStageTelemetry({
      emit(event) {
        appendFileSync(telemetryPath, `${JSON.stringify(event)}\n`);
      },
    });
  }
  const result = await buildRegionFromFile(options.input, {
    outputDirectory: resolve(options.output),
    regionId: options.region,
    telemetry,
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
