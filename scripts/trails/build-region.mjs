#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
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
  return {
    bytes: Buffer.byteLength(content),
    gzipBytes: gzipSync(content, { level: 9 }).byteLength,
    sha256: sha256(content),
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

function shippedProvenance(segments, mergeProvenance, elevationSource, elevationOptions) {
  const result = structuredClone(mergeProvenance);
  if (!elevationSource) return result;
  const metadata = createElevationManifestMetadata(elevationSource, elevationOptions);
  const source = metadata.source;
  const sourceId = `${source.product}@${source.version}`;
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
        sourceField: {
          product: source.product,
          version: source.version,
          sampling: metadata.sampling,
          smoothing: metadata.smoothing,
        },
      }];
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

function reachableNodes(point, adjacency, maximumMeters = 2_000) {
  const distances = new Map(point.connectedNodeIds.map((id) => [id, 0]));
  const pending = point.connectedNodeIds.map((id) => ({ id, distance: 0 }));
  while (pending.length > 0) {
    pending.sort((left, right) => left.distance - right.distance || left.id.localeCompare(right.id));
    const current = pending.shift();
    if (current.distance !== distances.get(current.id) || current.distance > maximumMeters) continue;
    for (const edge of adjacency.get(current.id) ?? []) {
      const distance = current.distance + edge.lengthMeters;
      if (distance > maximumMeters || distance >= (distances.get(edge.to) ?? Infinity)) continue;
      distances.set(edge.to, distance);
      pending.push({ id: edge.to, distance });
    }
  }
  return new Set(distances.keys());
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
  const adjacency = accessGraph(segments);
  const reachableByPoint = new Map(accessPoints.map((point) => [
    point.id,
    reachableNodes(point, adjacency),
  ]));
  const trails = [];
  for (const segmentsWithName of namedGroups.values()) {
    for (const group of componentGroups(segmentsWithName)) {
      const groupNodeIds = new Set(group.flatMap(({ fromNodeId, toNodeId }) =>
        [fromNodeId, toNodeId]));
      const pointMap = new Map(accessPoints.filter((point) =>
        [...groupNodeIds].some((nodeId) => reachableByPoint.get(point.id).has(nodeId)))
        .map((point) => [point.id, point]));
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
  const regional = applyRegionBounds(inputArrays(input), region);
  const arrays = regional.arrays;
  const reconciliation = reconcileAgencyGeometryWithOsmTopology(
    arrays.segmentCandidates,
    input.reconciliationOptions,
  );
  const merged = mergeTrailSegments(reconciliation.candidates, input.mergeOptions);
  const degenerateMergedIds = new Set(merged.segments
    .filter(({ lengthMeters }) => lengthMeters === 0)
    .map(({ id }) => id));
  const mergedSegments = merged.segments.filter(({ id }) => !degenerateMergedIds.has(id));
  const mergedProvenance = Object.fromEntries(Object.entries(merged.provenance)
    .filter(([segmentId]) => !degenerateMergedIds.has(segmentId)));
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
  const enrichment = await enrichSegments(
    mergedSegments,
    input.elevationSource,
    input.elevationOptions,
  );
  const segments = enrichment.segments;
  const segmentProvenance = shippedProvenance(
    segments,
    mergedProvenance,
    input.elevationSource,
    input.elevationOptions,
  );
  const nodes = buildCanonicalNodes(segments, arrays.sourceNodes);
  const access = buildAccessPoints({
    nodes,
    segments,
    candidates: arrays.accessPointCandidates,
    publicRoadNodeIds: arrays.publicRoadNodeIds,
  }, input.accessPointOptions);
  access.accessPoints.forEach(validateAccessPoint);
  const namedTrails = buildNamedTrails(segments, access.accessPoints);
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
  const payloads = {
    [ARTIFACT_FILENAMES.namedTrails]: prettyJson({
      schemaVersion: 1,
      regionId: region.id,
      trails: namedTrails,
    }),
    [ARTIFACT_FILENAMES.accessPoints]: prettyJson(accessPointGeoJson(access.accessPoints)),
    [ARTIFACT_FILENAMES.segments]: prettyJson({
      schemaVersion: 1,
      regionId: region.id,
      partitionRule: "first hexadecimal character after segment_",
      shards: Object.fromEntries(Object.entries(segmentShardPaths).map(([prefix, path]) => [
        prefix,
        { path, records: segmentPartitions[prefix].length },
      ])),
    }),
    [ARTIFACT_FILENAMES.nodes]: ndjson(nodes),
    [ARTIFACT_FILENAMES.segmentProvenance]: prettyJson({
      schemaVersion: 2,
      regionId: region.id,
      encoding: "field-observation-dictionaries-v1",
      partitionRule: "first hexadecimal character after segment_",
      shards: Object.fromEntries(Object.entries(provenanceShardPaths).map(([prefix, path]) => [
        prefix,
        { path, records: provenancePartitions[prefix].length },
      ])),
    }),
    ...Object.fromEntries(Object.entries(segmentShardPaths).map(([prefix, path]) => [
      path,
      ndjson(segmentPartitions[prefix]),
    ])),
    ...Object.fromEntries(Object.entries(provenanceShardPaths).map(([prefix, path]) => [
      path,
      `${stableJson({
        ...compactSegmentProvenance(Object.fromEntries(provenancePartitions[prefix])),
        regionId: region.id,
        partition: prefix,
      })}\n`,
    ])),
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
    ...(input.sourceManifest ? { sources: input.sourceManifest } : {}),
    delivery: {
      eagerMetadata: [ARTIFACT_FILENAMES.namedTrails, ARTIFACT_FILENAMES.accessPoints],
      lazyGeometryIndex: ARTIFACT_FILENAMES.segments,
      lazyProvenanceIndex: ARTIFACT_FILENAMES.segmentProvenance,
      partitionRule: "segment id first hexadecimal character",
    },
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
    segmentProvenance,
    payloads,
  };
}

export async function writeRegionArtifacts(result, outputDirectory) {
  if (!result?.payloads || typeof outputDirectory !== "string" || !outputDirectory) {
    throw new TypeError("result and outputDirectory are required");
  }
  await mkdir(outputDirectory, { recursive: true });
  await Promise.all(Object.keys(result.payloads).map((filename) =>
    mkdir(dirname(resolve(outputDirectory, filename)), { recursive: true })));
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
    input.accessPointCandidates.push(...(snapshot.accessPointCandidates ?? []));
    const roadSourceIds = new Set(snapshot.publicRoadSourceNodeIds ?? []);
    input.publicRoadNodeIds.push(...topology.nodes.filter((node) =>
      node.sourceNodeIds.some((sourceId) => roadSourceIds.has(sourceId))).map(({ id }) => id));
    input.pipelineIssues.push(...topology.issues);
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
