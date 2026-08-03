import { normalizeLineString } from "../model.mjs";
import { normalizeSegmentText } from "./segments.mjs";

export const PROVENANCE_FIELDS = Object.freeze([
  "geometry",
  "fromNodeId",
  "toNodeId",
  "name",
  "manager",
  "hiking",
  "access",
  "status",
  "surface",
  "lengthMeters",
  "sourceLength",
]);

const LAND_MANAGER_PROVIDER = /(^|[-_ ])(nps|usfs|state[-_ ]?parks?|ebrpd)($|[-_ ])/i;

function normalizedProvider(provider) {
  return String(provider).normalize("NFKC").trim().toLowerCase();
}

export function providerClass(provider) {
  const normalized = normalizedProvider(provider);
  if (normalized === "osm" || normalized === "openstreetmap") return "osm";
  if (normalized === "usgs") return "usgs";
  if (LAND_MANAGER_PROVIDER.test(normalized)) return "land-manager";
  return "agency";
}

/** Field-specific authority; larger numbers win. */
export function sourceAuthority(provider, field) {
  const kind = providerClass(provider);
  if (field === "fromNodeId" || field === "toNodeId") {
    return { osm: 500, "land-manager": 300, usgs: 250, agency: 300 }[kind];
  }
  if (field === "geometry") {
    return { usgs: 500, "land-manager": 475, agency: 425, osm: 200 }[kind];
  }
  if (["hiking", "access", "status"].includes(field)) {
    return { "land-manager": 500, agency: 450, osm: 200, usgs: 150 }[kind];
  }
  if (["name", "manager"].includes(field)) {
    return { "land-manager": 500, usgs: 450, agency: 425, osm: 200 }[kind];
  }
  if (field === "surface") {
    return { "land-manager": 500, agency: 450, osm: 300, usgs: 250 }[kind];
  }
  return { "land-manager": 500, agency: 450, usgs: 400, osm: 300 }[kind];
}

function sourceIdentity(sourceRef) {
  return `${normalizedProvider(sourceRef.provider)}:${String(sourceRef.sourceId).toLowerCase()}`;
}

function comparableValue(field, value) {
  if (field === "geometry") return JSON.stringify(normalizeLineString(value));
  if (typeof value === "object") return JSON.stringify(value);
  if (["name", "manager", "surface"].includes(field)) return normalizeSegmentText(value);
  return String(value).toLowerCase();
}

function safetyRank(field, value) {
  const ranks = {
    hiking: { blocked: 3, allowed: 2, unknown: 1 },
    access: { private: 3, public: 2, unknown: 1 },
    status: { closed: 4, seasonal: 3, open: 2, unknown: 1 },
  };
  return ranks[field]?.[value] ?? 0;
}

function candidateProvider(candidate) {
  return [...candidate.sourceRefs]
    .sort((left, right) =>
      sourceAuthority(right.provider, "geometry") - sourceAuthority(left.provider, "geometry") ||
      sourceIdentity(left).localeCompare(sourceIdentity(right)))[0];
}

function fieldDetail(candidate, field) {
  const detail = candidate.fieldProvenance?.[field];
  return detail === undefined ? undefined : structuredClone(detail);
}

export function provenanceEntries(candidates, field) {
  const entries = [];
  for (const candidate of candidates) {
    const value = candidate[field];
    if (value === undefined) continue;
    for (const sourceRef of candidate.sourceRefs) {
      entries.push({
        provider: sourceRef.provider,
        sourceId: sourceRef.sourceId,
        value: typeof value === "object" ? structuredClone(value) : value,
        authority: sourceAuthority(sourceRef.provider, field),
        ...(fieldDetail(candidate, field) !== undefined
          ? { sourceField: fieldDetail(candidate, field) }
          : {}),
      });
    }
  }

  const unique = new Map();
  for (const entry of entries) {
    const key = `${normalizedProvider(entry.provider)}\u0000${entry.sourceId}\u0000` +
      comparableValue(field, entry.value);
    if (!unique.has(key)) unique.set(key, entry);
  }
  return [...unique.values()].sort((left, right) =>
    right.authority - left.authority ||
    sourceIdentity(left).localeCompare(sourceIdentity(right)) ||
    comparableValue(field, left.value).localeCompare(comparableValue(field, right.value)));
}

export function selectPreferredCandidate(candidates, field) {
  let populated = candidates.filter((candidate) => candidate[field] !== undefined);
  if (populated.length === 0) return undefined;
  if (["hiking", "access", "status"].includes(field)) {
    const explicit = populated.filter((candidate) => candidate[field] !== "unknown");
    if (explicit.length > 0) populated = explicit;
  }
  return [...populated].sort((left, right) => {
    const leftSource = candidateProvider(left);
    const rightSource = candidateProvider(right);
    return sourceAuthority(rightSource.provider, field) - sourceAuthority(leftSource.provider, field) ||
      safetyRank(field, right[field]) - safetyRank(field, left[field]) ||
      sourceIdentity(leftSource).localeCompare(sourceIdentity(rightSource)) ||
      comparableValue(field, left[field]).localeCompare(comparableValue(field, right[field]));
  })[0];
}

export function buildSegmentProvenance(candidates, selectedValues) {
  return Object.fromEntries(PROVENANCE_FIELDS.flatMap((field) => {
    if (field === "lengthMeters") {
      return [[field, [{
        provider: "alpine-search",
        sourceId: "geometry-calculation",
        value: selectedValues.lengthMeters,
        authority: Number.MAX_SAFE_INTEGER,
        selected: true,
      }]]];
    }
    const entries = provenanceEntries(candidates, field);
    if (entries.length === 0) return [];
    const selectedComparable = comparableValue(field, selectedValues[field]);
    const selected = entries.map((entry) => ({
      ...entry,
      selected: comparableValue(field, entry.value) === selectedComparable,
    }));
    return [[field, selected]];
  }));
}

export function provenanceConflicts(segmentId, provenance) {
  const conflicts = [];
  for (const field of ["name", "manager", "hiking", "access", "status", "surface"]) {
    const entries = provenance[field] ?? [];
    const meaningful = entries.filter(({ value }) => value !== undefined && value !== "unknown");
    const values = new Set(meaningful.map(({ value }) => comparableValue(field, value)));
    if (values.size <= 1) continue;
    conflicts.push({
      type: "merge-conflict",
      segmentId,
      field,
      selectedValue: entries.find(({ selected }) => selected)?.value,
      observations: meaningful.map(({ provider, sourceId, value, selected }) => ({
        provider,
        sourceId,
        value,
        selected,
      })),
    });
  }
  return conflicts;
}

export const mergeProvenance = buildSegmentProvenance;
