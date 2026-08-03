import { createHash } from "node:crypto";

export const HIKING_VALUES = Object.freeze(["allowed", "blocked", "unknown"]);
export const ACCESS_VALUES = Object.freeze(["public", "private", "unknown"]);
export const STATUS_VALUES = Object.freeze(["open", "closed", "seasonal", "unknown"]);
export const ACCESS_POINT_TYPES = Object.freeze([
  "trailhead",
  "entrance",
  "parking",
  "derived",
]);
export const ACCESS_POINT_CONFIDENCE_VALUES = Object.freeze([
  "official",
  "mapped",
  "derived",
]);
export const DATA_CONFIDENCE_VALUES = Object.freeze(["high", "medium", "low"]);

const COORDINATE_PRECISION = 7;
const ID_HASH_LENGTH = 24;

function fail(path, message) {
  throw new TypeError(`${path} ${message}`);
}

function object(value, path) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(path, "must be an object");
  }
  return value;
}

function string(value, path, { optional = false } = {}) {
  if (value === undefined && optional) return;
  if (typeof value !== "string" || !value.trim()) {
    fail(path, "must be a non-empty string");
  }
}

function finiteNumber(value, path, { minimum, maximum, optional = false } = {}) {
  if (value === undefined && optional) return;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(path, "must be a finite number");
  }
  if (minimum !== undefined && value < minimum) fail(path, `must be at least ${minimum}`);
  if (maximum !== undefined && value > maximum) fail(path, `must be at most ${maximum}`);
}

function enumValue(value, allowed, path) {
  if (!allowed.includes(value)) {
    fail(path, `must be one of: ${allowed.join(", ")}`);
  }
}

function stringArray(value, path, { minimum = 0 } = {}) {
  if (!Array.isArray(value) || value.length < minimum) {
    fail(path, `must be an array with at least ${minimum} item${minimum === 1 ? "" : "s"}`);
  }
  value.forEach((item, index) => string(item, `${path}[${index}]`));
  if (new Set(value).size !== value.length) fail(path, "must not contain duplicate values");
}

function validateLongitude(value, path) {
  finiteNumber(value, path, { minimum: -180, maximum: 180 });
}

function validateLatitude(value, path) {
  finiteNumber(value, path, { minimum: -90, maximum: 90 });
}

export function validatePosition(value, path = "position") {
  if (!Array.isArray(value) || value.length < 2) {
    fail(path, "must contain longitude and latitude");
  }
  validateLongitude(value[0], `${path}[0]`);
  validateLatitude(value[1], `${path}[1]`);
  value.slice(2).forEach((coordinate, index) =>
    finiteNumber(coordinate, `${path}[${index + 2}]`),
  );
  return value;
}

export function validateLineString(value, path = "geometry") {
  object(value, path);
  if (value.type !== "LineString") fail(`${path}.type`, "must be LineString");
  if (!Array.isArray(value.coordinates) || value.coordinates.length < 2) {
    fail(`${path}.coordinates`, "must contain at least two positions");
  }
  value.coordinates.forEach((position, index) =>
    validatePosition(position, `${path}.coordinates[${index}]`),
  );
  return value;
}

export function validateSourceRef(value, path = "sourceRef") {
  object(value, path);
  string(value.provider, `${path}.provider`);
  string(value.sourceId, `${path}.sourceId`);
  string(value.sourceUpdatedAt, `${path}.sourceUpdatedAt`, { optional: true });
  string(value.retrievedAt, `${path}.retrievedAt`);
  if (Number.isNaN(Date.parse(value.retrievedAt))) {
    fail(`${path}.retrievedAt`, "must be a valid date or timestamp");
  }
  if (value.sourceUpdatedAt !== undefined && Number.isNaN(Date.parse(value.sourceUpdatedAt))) {
    fail(`${path}.sourceUpdatedAt`, "must be a valid date or timestamp");
  }
  string(value.sourceUrl, `${path}.sourceUrl`);
  try {
    new URL(value.sourceUrl);
  } catch {
    fail(`${path}.sourceUrl`, "must be an absolute URL");
  }
  return value;
}

function validateSourceRefs(value, path) {
  if (!Array.isArray(value) || value.length < 1) {
    fail(path, "must contain at least one source reference");
  }
  value.forEach((sourceRef, index) => validateSourceRef(sourceRef, `${path}[${index}]`));
}

function optionalMetric(value, path) {
  finiteNumber(value, path, { minimum: 0, optional: true });
}

function optionalElevation(value, path) {
  finiteNumber(value, path, { optional: true });
}

export function validateTrailSegment(value, path = "trailSegment") {
  object(value, path);
  string(value.id, `${path}.id`);
  string(value.fromNodeId, `${path}.fromNodeId`);
  string(value.toNodeId, `${path}.toNodeId`);
  validateLineString(value.geometry, `${path}.geometry`);
  if (value.displayGeometry !== undefined) {
    validateLineString(value.displayGeometry, `${path}.displayGeometry`);
  }
  string(value.name, `${path}.name`, { optional: true });
  string(value.manager, `${path}.manager`, { optional: true });
  enumValue(value.hiking, HIKING_VALUES, `${path}.hiking`);
  enumValue(value.access, ACCESS_VALUES, `${path}.access`);
  enumValue(value.status, STATUS_VALUES, `${path}.status`);
  string(value.surface, `${path}.surface`, { optional: true });
  finiteNumber(value.lengthMeters, `${path}.lengthMeters`, { minimum: 0 });
  optionalMetric(value.ascentForwardMeters, `${path}.ascentForwardMeters`);
  optionalMetric(value.descentForwardMeters, `${path}.descentForwardMeters`);
  optionalElevation(value.minElevationMeters, `${path}.minElevationMeters`);
  optionalElevation(value.maxElevationMeters, `${path}.maxElevationMeters`);
  optionalMetric(value.maxGradePct, `${path}.maxGradePct`);
  if (
    value.minElevationMeters !== undefined &&
    value.maxElevationMeters !== undefined &&
    value.minElevationMeters > value.maxElevationMeters
  ) {
    fail(`${path}.minElevationMeters`, "must not exceed maxElevationMeters");
  }
  validateSourceRefs(value.sourceRefs, `${path}.sourceRefs`);
  return value;
}

export function validateTrailNode(value, path = "trailNode") {
  object(value, path);
  string(value.id, `${path}.id`);
  validateLongitude(value.longitude, `${path}.longitude`);
  validateLatitude(value.latitude, `${path}.latitude`);
  stringArray(value.sourceNodeIds, `${path}.sourceNodeIds`);
  stringArray(value.incidentSegmentIds, `${path}.incidentSegmentIds`);
  return value;
}

export function validateAccessPoint(value, path = "accessPoint") {
  object(value, path);
  string(value.id, `${path}.id`);
  validateLongitude(value.longitude, `${path}.longitude`);
  validateLatitude(value.latitude, `${path}.latitude`);
  string(value.name, `${path}.name`, { optional: true });
  enumValue(value.type, ACCESS_POINT_TYPES, `${path}.type`);
  enumValue(value.confidence, ACCESS_POINT_CONFIDENCE_VALUES, `${path}.confidence`);
  stringArray(value.connectedNodeIds, `${path}.connectedNodeIds`);
  validateSourceRefs(value.sourceRefs, `${path}.sourceRefs`);
  return value;
}

export function validateBounds(value, path = "bounds") {
  if (!Array.isArray(value) || value.length !== 4) {
    fail(path, "must be [west, south, east, north]");
  }
  validateLongitude(value[0], `${path}[0]`);
  validateLatitude(value[1], `${path}[1]`);
  validateLongitude(value[2], `${path}[2]`);
  validateLatitude(value[3], `${path}[3]`);
  if (value[0] >= value[2]) fail(path, "west must be less than east");
  if (value[1] >= value[3]) fail(path, "south must be less than north");
  return value;
}

export function validateNamedTrail(value, path = "namedTrail") {
  object(value, path);
  string(value.id, `${path}.id`);
  string(value.name, `${path}.name`);
  stringArray(value.segmentIds, `${path}.segmentIds`, { minimum: 1 });
  stringArray(value.accessPointIds, `${path}.accessPointIds`);
  string(value.manager, `${path}.manager`, { optional: true });
  validateBounds(value.bounds, `${path}.bounds`);
  finiteNumber(value.lengthMeters, `${path}.lengthMeters`, { minimum: 0, optional: true });
  validateSourceRefs(value.sourceRefs, `${path}.sourceRefs`);
  enumValue(value.dataConfidence, DATA_CONFIDENCE_VALUES, `${path}.dataConfidence`);
  return value;
}

export const validators = Object.freeze({
  SourceRef: validateSourceRef,
  TrailSegment: validateTrailSegment,
  TrailNode: validateTrailNode,
  AccessPoint: validateAccessPoint,
  NamedTrail: validateNamedTrail,
});

export function validateRecord(type, value) {
  const validator = validators[type];
  if (!validator) fail("type", `must name a canonical record: ${Object.keys(validators).join(", ")}`);
  return validator(value);
}

function rounded(value) {
  const result = Number(value.toFixed(COORDINATE_PRECISION));
  return Object.is(result, -0) ? 0 : result;
}

export function normalizePosition(position) {
  validatePosition(position);
  return position.map(rounded);
}

export function normalizeLineString(geometry, { directionIndependent = true } = {}) {
  validateLineString(geometry);
  const coordinates = geometry.coordinates.map(normalizePosition);
  if (!directionIndependent) return { type: "LineString", coordinates };

  const forward = JSON.stringify(coordinates);
  const reverseCoordinates = [...coordinates].reverse();
  const reverse = JSON.stringify(reverseCoordinates);
  return {
    type: "LineString",
    coordinates: reverse < forward ? reverseCoordinates : coordinates,
  };
}

function normalizedText(value) {
  return String(value).normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

function normalizedSourceIdentities(sourceRefs) {
  if (!Array.isArray(sourceRefs) || sourceRefs.length < 1) {
    fail("sourceRefs", "must contain at least one source reference");
  }
  return [...new Set(sourceRefs.map((sourceRef, index) => {
    object(sourceRef, `sourceRefs[${index}]`);
    string(sourceRef.provider, `sourceRefs[${index}].provider`);
    string(sourceRef.sourceId, `sourceRefs[${index}].sourceId`);
    return `${normalizedText(sourceRef.provider)}:${normalizedText(sourceRef.sourceId)}`;
  }))].sort();
}

function makeId(kind, identity) {
  string(kind, "kind");
  const prefix = normalizedText(kind).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (!prefix) fail("kind", "must contain a letter or number");
  const hash = createHash("sha256").update(canonicalJson(identity)).digest("hex");
  return `${prefix}_${hash.slice(0, ID_HASH_LENGTH)}`;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`,
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Build a deterministic source-derived ID. Retrieval timestamps and URLs are
 * deliberately excluded so refreshing the same upstream record cannot change
 * its identity.
 */
export function createStableId(kind, { sourceRefs, geometry, ...identity } = {}) {
  const normalized = {
    sources: normalizedSourceIdentities(sourceRefs),
    ...identity,
  };
  if (geometry !== undefined) normalized.geometry = normalizeLineString(geometry);
  return makeId(kind, normalized);
}

export const stableId = createStableId;

export function createSegmentId(sourceRefs, geometry) {
  return createStableId("segment", { sourceRefs, geometry });
}

export function createNodeId({ sourceNodeIds = [], longitude, latitude }) {
  stringArray(sourceNodeIds, "sourceNodeIds");
  validateLongitude(longitude, "longitude");
  validateLatitude(latitude, "latitude");
  return makeId("node", {
    sourceNodeIds: [...sourceNodeIds].map(normalizedText).sort(),
    position: [rounded(longitude), rounded(latitude)],
  });
}

export function createAccessPointId(sourceRefs, { longitude, latitude }) {
  validateLongitude(longitude, "longitude");
  validateLatitude(latitude, "latitude");
  return createStableId("access-point", {
    sourceRefs,
    position: [rounded(longitude), rounded(latitude)],
  });
}

export function createNamedTrailId(sourceRefs, name, segmentIds = []) {
  string(name, "name");
  stringArray(segmentIds, "segmentIds");
  return createStableId("named-trail", {
    sourceRefs,
    name: normalizedText(name),
    segmentIds: [...segmentIds].sort(),
  });
}
