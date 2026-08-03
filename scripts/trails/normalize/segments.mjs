import {
  createNodeId,
  createSegmentId,
  validateLineString,
  validateSourceRef,
  validateTrailSegment,
} from "../model.mjs";
import { orientLineString } from "../spatial/geometry.mjs";
import { geodesicLineLengthMeters } from "../spatial/length.mjs";

const OPTIONAL_TEXT_FIELDS = Object.freeze(["name", "manager", "surface"]);
const OPTIONAL_METRIC_FIELDS = Object.freeze([
  "ascentForwardMeters",
  "descentForwardMeters",
  "minElevationMeters",
  "maxElevationMeters",
  "maxGradePct",
]);

function requireObject(value, path) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object`);
  }
  return value;
}

function nonEmptyText(value) {
  if (value === undefined || value === null) return undefined;
  const text = String(value).normalize("NFKC").trim().replace(/\s+/g, " ");
  return text || undefined;
}

/** Normalize names and managers for matching without changing display values. */
export function normalizeSegmentText(value) {
  return nonEmptyText(value)
    ?.normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export const normalizeName = normalizeSegmentText;
export const normalizeManager = normalizeSegmentText;

function compareSourceRefs(left, right) {
  return left.provider.localeCompare(right.provider) ||
    left.sourceId.localeCompare(right.sourceId) ||
    left.sourceUrl.localeCompare(right.sourceUrl) ||
    left.retrievedAt.localeCompare(right.retrievedAt);
}

function sourceRefKey(sourceRef) {
  return `${sourceRef.provider.normalize("NFKC").trim().toLowerCase()}\u0000` +
    sourceRef.sourceId.normalize("NFKC").trim().toLowerCase();
}

export function deduplicateSourceRefs(sourceRefs) {
  if (!Array.isArray(sourceRefs) || sourceRefs.length === 0) {
    throw new TypeError("sourceRefs must contain at least one source reference");
  }
  const byIdentity = new Map();
  for (const [index, sourceRef] of sourceRefs.entries()) {
    validateSourceRef(sourceRef, `sourceRefs[${index}]`);
    const copy = { ...sourceRef };
    const key = sourceRefKey(copy);
    const previous = byIdentity.get(key);
    if (
      !previous ||
      Date.parse(copy.retrievedAt) > Date.parse(previous.retrievedAt) ||
      (copy.retrievedAt === previous.retrievedAt &&
        JSON.stringify(copy).localeCompare(JSON.stringify(previous)) > 0)
    ) {
      byIdentity.set(key, copy);
    }
  }
  return [...byIdentity.values()].sort(compareSourceRefs);
}

function endpointSourceNodeIds(sourceRefs, position) {
  const coordinate = `${position[0].toFixed(7)},${position[1].toFixed(7)}`;
  return sourceRefs.map(({ provider, sourceId }) =>
    `${provider}:${sourceId}:endpoint:${coordinate}`);
}

function endpointNodeId(sourceRefs, position) {
  return createNodeId({
    sourceNodeIds: endpointSourceNodeIds(sourceRefs, position),
    longitude: position[0],
    latitude: position[1],
  });
}

function cloneLineString(geometry) {
  return {
    ...geometry,
    coordinates: geometry.coordinates.map((position) => [...position]),
  };
}

function cloneFieldProvenance(fieldProvenance) {
  if (fieldProvenance === undefined) return undefined;
  requireObject(fieldProvenance, "fieldProvenance");
  return Object.fromEntries(Object.entries(fieldProvenance).map(([field, detail]) => [
    field,
    detail && typeof detail === "object" ? structuredClone(detail) : detail,
  ]));
}

/**
 * Finish a provisional adapter segment. Agency records receive deterministic
 * endpoint nodes, and every length is recalculated from routing geometry.
 */
export function normalizeSegmentCandidate(candidate) {
  requireObject(candidate, "candidate");
  validateLineString(candidate.geometry, "candidate.geometry");
  const sourceRefs = deduplicateSourceRefs(candidate.sourceRefs);
  const hasFromNode = nonEmptyText(candidate.fromNodeId) !== undefined;
  const hasToNode = nonEmptyText(candidate.toNodeId) !== undefined;
  if (hasFromNode !== hasToNode) {
    throw new TypeError("candidate must provide both fromNodeId and toNodeId, or neither");
  }

  const geometry = hasFromNode
    ? cloneLineString(candidate.geometry)
    : orientLineString(candidate.geometry);
  const start = geometry.coordinates[0];
  const end = geometry.coordinates.at(-1);
  const segment = {
    id: nonEmptyText(candidate.id) ?? createSegmentId(sourceRefs, geometry),
    fromNodeId: hasFromNode
      ? nonEmptyText(candidate.fromNodeId)
      : endpointNodeId(sourceRefs, start),
    toNodeId: hasToNode
      ? nonEmptyText(candidate.toNodeId)
      : endpointNodeId(sourceRefs, end),
    geometry,
    ...(candidate.displayGeometry ? {
      displayGeometry: cloneLineString(candidate.displayGeometry),
    } : {}),
    ...Object.fromEntries(OPTIONAL_TEXT_FIELDS.flatMap((field) => {
      const value = nonEmptyText(candidate[field]);
      return value === undefined ? [] : [[field, value]];
    })),
    hiking: candidate.hiking ?? "unknown",
    access: candidate.access ?? "unknown",
    status: candidate.status ?? "unknown",
    lengthMeters: geodesicLineLengthMeters(geometry),
    ...Object.fromEntries(OPTIONAL_METRIC_FIELDS.flatMap((field) =>
      candidate[field] === undefined ? [] : [[field, candidate[field]]])),
    sourceRefs,
  };
  validateTrailSegment(segment);

  const fieldProvenance = cloneFieldProvenance(candidate.fieldProvenance);
  const sourceLength = candidate.sourceLength && typeof candidate.sourceLength === "object"
    ? { ...candidate.sourceLength }
    : undefined;
  return {
    ...segment,
    ...(fieldProvenance ? { fieldProvenance } : {}),
    ...(sourceLength ? { sourceLength } : {}),
  };
}

export function normalizeSegmentCandidates(candidates) {
  if (!Array.isArray(candidates)) throw new TypeError("candidates must be an array");
  return candidates.map(normalizeSegmentCandidate);
}

export const normalizeTrailSegment = normalizeSegmentCandidate;
export const normalizeSegments = normalizeSegmentCandidates;
