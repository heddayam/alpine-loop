import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  createSegmentId,
  createStableId,
  validateLineString,
  validateSourceRef,
} from "../model.mjs";

const SNAPSHOT_SCHEMA_VERSION = 1;
const DEFAULT_PAGE_SIZE = 1_000;
const MAX_PAGE_REQUESTS = 10_000;

const HIKING_ALLOWED = new Set([
  "allowed", "designated", "hike", "hiker", "hiking", "official", "open",
  "pedestrian", "permissive", "true", "y", "yes", "1",
]);
const HIKING_BLOCKED = new Set([
  "blocked", "closed", "false", "n", "no", "private", "prohibited", "0",
]);
const ACCESS_PUBLIC = new Set([
  "allowed", "designated", "official", "open", "permissive", "public", "true",
  "y", "yes", "1",
]);
const ACCESS_PRIVATE = new Set(["private"]);

function nonEmptyText(value) {
  if (value === null || value === undefined) return undefined;
  const result = String(value).trim();
  return result || undefined;
}

function normalizedValue(value) {
  return nonEmptyText(value)?.toLowerCase().replace(/[\s_-]+/g, " ");
}

function propertyIndex(properties) {
  return new Map(
    Object.entries(properties ?? {}).map(([key, value]) => [key.toLowerCase(), { key, value }]),
  );
}

/** Read the first populated field without making source field casing significant. */
export function readArcGisField(properties, fieldNames = []) {
  const index = propertyIndex(properties);
  for (const fieldName of fieldNames) {
    const entry = index.get(String(fieldName).toLowerCase());
    if (entry && nonEmptyText(entry.value) !== undefined) {
      return { field: entry.key, value: entry.value };
    }
  }
  return undefined;
}

function requireTimestamp(value, label) {
  if (!nonEmptyText(value) || Number.isNaN(Date.parse(value))) {
    throw new TypeError(`${label} must be a valid date or timestamp`);
  }
  return value;
}

function requireUrl(value, label) {
  try {
    return new URL(value).toString();
  } catch {
    throw new TypeError(`${label} must be an absolute URL`);
  }
}

function requireBbox(bbox) {
  if (
    !Array.isArray(bbox) || bbox.length !== 4 ||
    bbox.some((value) => typeof value !== "number" || !Number.isFinite(value)) ||
    bbox[0] >= bbox[2] || bbox[1] >= bbox[3]
  ) {
    throw new TypeError("bbox must be [west, south, east, north]");
  }
  return bbox;
}

function featureProperties(feature) {
  return feature?.properties ?? feature?.attributes ?? {};
}

function geoJsonGeometry(geometry) {
  if (!geometry || typeof geometry !== "object") return undefined;
  if (geometry.type === "LineString" || geometry.type === "MultiLineString") return geometry;
  if (Array.isArray(geometry.paths)) {
    return geometry.paths.length === 1
      ? { type: "LineString", coordinates: geometry.paths[0] }
      : { type: "MultiLineString", coordinates: geometry.paths };
  }
  return undefined;
}

/** Split multipart agency records into routable LineStrings without changing coordinates. */
export function arcGisFeatureLineStrings(feature) {
  const geometry = geoJsonGeometry(feature?.geometry);
  const lines = geometry?.type === "LineString"
    ? [geometry.coordinates]
    : geometry?.type === "MultiLineString"
      ? geometry.coordinates
      : [];
  return lines.map((coordinates) => ({ type: "LineString", coordinates }))
    .filter((lineString) => {
      try {
        validateLineString(lineString);
        return true;
      } catch {
        return false;
      }
    });
}

function configuredValue(properties, fields, classifier, fallback = "unknown") {
  for (const fieldGroup of fields ?? []) {
    const fieldNames = Array.isArray(fieldGroup) ? fieldGroup : [fieldGroup];
    const match = readArcGisField(properties, fieldNames);
    if (!match) continue;
    const classified = classifier(match.value, match.field);
    if (classified !== undefined && classified !== "unknown") {
      return { value: classified, field: match.field, rawValue: match.value };
    }
  }
  return { value: fallback };
}

export function classifyHikingValue(value) {
  const normalized = normalizedValue(value);
  if (!normalized) return "unknown";
  if (HIKING_BLOCKED.has(normalized)) return "blocked";
  if (HIKING_ALLOWED.has(normalized) || /\b(hik|hiker|hiking|pedestrian|foot)\b/.test(normalized)) {
    return "allowed";
  }
  return "unknown";
}

export function classifyAccessValue(value) {
  const normalized = normalizedValue(value);
  if (!normalized) return "unknown";
  if (ACCESS_PRIVATE.has(normalized)) return "private";
  if (ACCESS_PUBLIC.has(normalized)) return "public";
  return "unknown";
}

export function classifyStatusValue(value) {
  const normalized = normalizedValue(value);
  if (!normalized) return "unknown";
  if (/season|winter|summer|weather/.test(normalized)) return "seasonal";
  if (/closed|closure|construction|planned|proposed|decommission/.test(normalized)) {
    return "closed";
  }
  if (/open|active|existing|maintained|true|yes|^y$|^1$/.test(normalized)) return "open";
  return "unknown";
}

function resolveSourceId(feature, config, geometry) {
  const properties = featureProperties(feature);
  const match = readArcGisField(properties, config.idFields);
  const directId = nonEmptyText(feature?.id) ?? nonEmptyText(match?.value);
  if (directId) return directId;
  const placeholder = [{
    provider: config.provider,
    sourceId: "geometry-derived",
    retrievedAt: "1970-01-01T00:00:00.000Z",
    sourceUrl: config.url,
  }];
  return createStableId("source-feature", { sourceRefs: placeholder, geometry });
}

function sourceUpdatedAt(properties, config) {
  const match = readArcGisField(properties, config.updatedAtFields);
  if (!match) return undefined;
  const numeric = typeof match.value === "number" ? match.value : Number(match.value);
  const date = Number.isFinite(numeric) && numeric > 10_000_000_000
    ? new Date(numeric)
    : new Date(match.value);
  return Number.isNaN(date.valueOf()) ? undefined : date.toISOString();
}

function sourceLength(properties, config) {
  for (const mapping of config.lengthFields ?? []) {
    const match = readArcGisField(properties, mapping.fields ?? [mapping.field]);
    if (!match) continue;
    const value = Number(match.value);
    if (!Number.isFinite(value) || value < 0) continue;
    return { value, unit: mapping.unit ?? "unknown", field: match.field };
  }
  return undefined;
}

function mappedText(properties, fields) {
  const match = readArcGisField(properties, fields);
  return match ? { value: nonEmptyText(match.value), field: match.field } : undefined;
}

function fieldProvenance(mapped) {
  return Object.fromEntries(
    Object.entries(mapped)
      .filter(([, value]) => value?.field)
      .map(([key, value]) => [key, { field: value.field, rawValue: value.rawValue ?? value.value }]),
  );
}

/**
 * Purely normalize one cached agency feature. The result is provisional:
 * topology IDs and Alpine-calculated length are intentionally added later.
 */
export function normalizeArcGisFeature(feature, config, { retrievedAt } = {}) {
  requireTimestamp(retrievedAt, "retrievedAt");
  const properties = featureProperties(feature);
  const geometries = arcGisFeatureLineStrings(feature);
  const name = mappedText(properties, config.nameFields);
  const manager = mappedText(properties, config.managerFields);
  const surface = mappedText(properties, config.surfaceFields);
  const hiking = configuredValue(
    properties,
    config.hikingFields,
    config.classifyHiking ?? classifyHikingValue,
  );
  const access = configuredValue(
    properties,
    config.accessFields,
    config.classifyAccess ?? classifyAccessValue,
  );
  const status = configuredValue(
    properties,
    config.statusFields,
    config.classifyStatus ?? classifyStatusValue,
  );
  const length = sourceLength(properties, config);

  return geometries.map((geometry) => {
    const sourceId = resolveSourceId(feature, config, geometry);
    const sourceRef = {
      provider: config.provider,
      sourceId,
      ...(sourceUpdatedAt(properties, config) ? {
        sourceUpdatedAt: sourceUpdatedAt(properties, config),
      } : {}),
      retrievedAt,
      sourceUrl: config.url,
    };
    validateSourceRef(sourceRef);
    const mapped = { name, manager, surface, hiking, access, status };
    return {
      id: createSegmentId([sourceRef], geometry),
      geometry,
      ...(name?.value ? { name: name.value } : {}),
      ...(manager?.value ? { manager: manager.value } : config.defaultManager
        ? { manager: config.defaultManager }
        : {}),
      hiking: hiking.value,
      access: access.value,
      status: status.value,
      ...(surface?.value ? { surface: surface.value } : {}),
      ...(length ? { sourceLength: length } : {}),
      sourceRefs: [sourceRef],
      fieldProvenance: fieldProvenance(mapped),
    };
  });
}

export function normalizeArcGisSnapshot(snapshot, config) {
  const parsed = validateArcGisSnapshot(snapshot, config);
  return parsed.features.flatMap((feature) =>
    normalizeArcGisFeature(feature, config, { retrievedAt: parsed.retrievedAt }));
}

export function createArcGisAgencyAdapter(config) {
  const frozenConfig = Object.freeze({
    ...config,
    url: requireUrl(config.url, "config.url"),
  });
  return Object.freeze({
    config: frozenConfig,
    normalizeFeature: (feature, options) => normalizeArcGisFeature(feature, frozenConfig, options),
    normalizeSnapshot: (snapshot) => normalizeArcGisSnapshot(snapshot, frozenConfig),
  });
}

export function validateArcGisSnapshot(snapshot, expectedSource) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new TypeError("ArcGIS snapshot must be an object");
  }
  if (snapshot.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) {
    throw new TypeError(`ArcGIS snapshot schemaVersion must be ${SNAPSHOT_SCHEMA_VERSION}`);
  }
  requireTimestamp(snapshot.retrievedAt, "snapshot.retrievedAt");
  if (!snapshot.source || typeof snapshot.source !== "object") {
    throw new TypeError("snapshot.source must be an object");
  }
  const provider = nonEmptyText(snapshot.source.provider);
  const url = requireUrl(snapshot.source.url, "snapshot.source.url");
  if (expectedSource?.provider && provider !== expectedSource.provider) {
    throw new TypeError(`snapshot provider ${JSON.stringify(provider)} does not match ${expectedSource.provider}`);
  }
  if (expectedSource?.url && url !== requireUrl(expectedSource.url, "expectedSource.url")) {
    throw new TypeError("snapshot source URL does not match the adapter URL");
  }
  if (!Array.isArray(snapshot.features)) {
    throw new TypeError("snapshot.features must be an array");
  }
  return snapshot;
}

export async function readArcGisSnapshot(snapshotPath, expectedSource) {
  const snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
  return validateArcGisSnapshot(snapshot, expectedSource);
}

async function fetchJson(fetchImpl, url) {
  const response = await fetchImpl(url, {
    headers: { Accept: "application/json", "User-Agent": "AlpineSearch-TrailSnapshot/1" },
  });
  if (!response?.ok) {
    throw new Error(`ArcGIS request failed: ${response?.status ?? "unknown"} ${response?.statusText ?? ""}`.trim());
  }
  const payload = await response.json();
  if (payload?.error) throw new Error(payload.error.message ?? JSON.stringify(payload.error));
  return payload;
}

function queryUrl(layerUrl, parameters) {
  const url = new URL(`${layerUrl.replace(/\/$/, "")}/query`);
  for (const [key, value] of Object.entries(parameters)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return url;
}

function spatialQuery(bbox) {
  if (!bbox) return {};
  requireBbox(bbox);
  return {
    geometry: bbox.join(","),
    geometryType: "esriGeometryEnvelope",
    inSR: 4326,
    spatialRel: "esriSpatialRelIntersects",
  };
}

function featureId(feature, objectIdField) {
  return nonEmptyText(readArcGisField(featureProperties(feature), [objectIdField])?.value)
    ?? nonEmptyText(feature?.id);
}

function sortFeatures(features, objectIdField) {
  return [...features].sort((left, right) =>
    String(featureId(left, objectIdField) ?? "").localeCompare(
      String(featureId(right, objectIdField) ?? ""),
      "en",
      { numeric: true },
    ));
}

async function fetchByObjectIds(fetchImpl, layerUrl, objectIds, objectIdField, pageSize) {
  const byId = new Map();
  for (let offset = 0; offset < objectIds.length; offset += pageSize) {
    const ids = objectIds.slice(offset, offset + pageSize);
    const payload = await fetchJson(fetchImpl, queryUrl(layerUrl, {
      objectIds: ids.join(","),
      outFields: "*",
      returnGeometry: true,
      returnZ: false,
      outSR: 4326,
      f: "geojson",
    }));
    for (const feature of Array.isArray(payload.features) ? payload.features : []) {
      const id = featureId(feature, objectIdField);
      if (!id) throw new Error(`ArcGIS feature is missing object ID field ${objectIdField}`);
      byId.set(id, feature);
    }
  }
  const missing = objectIds.filter((id) => !byId.has(String(id)));
  if (missing.length) throw new Error(`ArcGIS pagination omitted ${missing.length} requested object IDs`);
  return sortFeatures([...byId.values()], objectIdField);
}

async function fetchByOffset(fetchImpl, layerUrl, query, objectIdField, pageSize) {
  const byId = new Map();
  let offset = 0;
  for (let page = 0; page < MAX_PAGE_REQUESTS; page += 1) {
    const payload = await fetchJson(fetchImpl, queryUrl(layerUrl, {
      where: "1=1",
      ...query,
      outFields: "*",
      returnGeometry: true,
      returnZ: false,
      outSR: 4326,
      orderByFields: objectIdField,
      resultOffset: offset,
      resultRecordCount: pageSize,
      f: "geojson",
    }));
    const pageFeatures = Array.isArray(payload.features) ? payload.features : [];
    for (const feature of pageFeatures) {
      const id = featureId(feature, objectIdField);
      if (!id) throw new Error(`ArcGIS feature is missing object ID field ${objectIdField}`);
      if (byId.has(id)) throw new Error(`ArcGIS pagination returned duplicate object ID ${id}`);
      byId.set(id, feature);
    }
    if (!payload.exceededTransferLimit && pageFeatures.length < pageSize) break;
    if (!pageFeatures.length) throw new Error("ArcGIS pagination reported more records but returned an empty page");
    offset += pageFeatures.length;
    if (page === MAX_PAGE_REQUESTS - 1) throw new Error("ArcGIS pagination exceeded its safety limit");
  }
  return sortFeatures([...byId.values()], objectIdField);
}

/** Explicit network operation. Normal builds should call readArcGisSnapshot instead. */
export async function fetchArcGisSnapshot(source, {
  bbox,
  fetchImpl = globalThis.fetch,
  pageSize,
  retrievedAt = new Date().toISOString(),
} = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function");
  const layerUrl = requireUrl(source.url, "source.url").replace(/\/$/, "");
  const metadata = await fetchJson(fetchImpl, new URL(`${layerUrl}?f=json`));
  const objectIdField = metadata.objectIdField
    ?? metadata.objectIdFieldName
    ?? metadata.fields?.find((field) => field.type === "esriFieldTypeOID")?.name;
  if (!objectIdField) throw new Error("ArcGIS layer metadata has no object ID field");
  const effectivePageSize = Math.max(1, Math.min(
    Number(pageSize) || Number(metadata.maxRecordCount) || DEFAULT_PAGE_SIZE,
    Number(metadata.maxRecordCount) || DEFAULT_PAGE_SIZE,
  ));
  const query = spatialQuery(bbox);
  const idsPayload = await fetchJson(fetchImpl, queryUrl(layerUrl, {
    where: "1=1",
    ...query,
    returnIdsOnly: true,
    f: "json",
  }));
  const objectIds = Array.isArray(idsPayload.objectIds)
    ? [...new Set(idsPayload.objectIds)].sort((a, b) => String(a).localeCompare(String(b), "en", { numeric: true }))
    : undefined;
  const features = objectIds
    ? await fetchByObjectIds(fetchImpl, layerUrl, objectIds, objectIdField, effectivePageSize)
    : await fetchByOffset(fetchImpl, layerUrl, query, objectIdField, effectivePageSize);
  return validateArcGisSnapshot({
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    source: { provider: source.provider, url: layerUrl },
    retrievedAt: requireTimestamp(retrievedAt, "retrievedAt"),
    features,
  }, source);
}

export async function refreshArcGisSnapshot(source, { cachePath, ...options } = {}) {
  if (!nonEmptyText(cachePath)) throw new TypeError("cachePath is required for a refresh");
  const snapshot = await fetchArcGisSnapshot(source, options);
  await mkdir(dirname(cachePath), { recursive: true });
  await writeFile(cachePath, `${JSON.stringify(snapshot, null, 2)}\n`);
  return snapshot;
}
