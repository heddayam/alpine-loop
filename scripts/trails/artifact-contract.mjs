import { createHash } from "node:crypto";

export const ARTIFACT_SCHEMA_VERSION = 2;
export const DEFAULT_PARTITION_PREFIX_LENGTH = 2;
export const MAX_RUNTIME_SHARD_RAW_BYTES = 8 * 1024 * 1024;
export const MAX_RUNTIME_SHARD_GZIP_BYTES = 2 * 1024 * 1024;

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function partitionPrefixes(prefixLength) {
  if (!Number.isInteger(prefixLength) || prefixLength < 1 || prefixLength > 8) {
    throw new TypeError("partition prefixLength must be an integer from 1 to 8");
  }
  let prefixes = [""];
  for (let index = 0; index < prefixLength; index += 1) {
    prefixes = prefixes.flatMap((prefix) =>
      "0123456789abcdef".split("").map((digit) => `${prefix}${digit}`));
  }
  return prefixes;
}

export function segmentPartitionKey(segmentId, prefixLength) {
  if (typeof segmentId !== "string") throw new TypeError("segment id must be a string");
  const match = /^segment_([0-9a-f]+)$/.exec(segmentId);
  if (!match || match[1].length < prefixLength) {
    throw new TypeError(
      `artifact record id ${JSON.stringify(segmentId)} has no ${prefixLength}-character hex prefix`,
    );
  }
  return match[1].slice(0, prefixLength);
}

export function partitionPrefixLength(index) {
  const declared = index?.partitioning?.prefixLength ?? index?.prefixLength;
  if (declared !== undefined) {
    if (!Number.isInteger(declared) || declared < 1 || declared > 8) {
      throw new TypeError("artifact index prefixLength must be an integer from 1 to 8");
    }
    return declared;
  }
  const keys = Object.keys(index?.shards ?? {});
  if (keys.length === 0 || keys.some((key) => !/^[0-9a-f]+$/.test(key))) {
    throw new TypeError("artifact index must declare valid hexadecimal shards");
  }
  const widths = new Set(keys.map((key) => key.length));
  if (widths.size !== 1) throw new TypeError("artifact index shard widths are inconsistent");
  return [...widths][0];
}

export function createBuildId({ regionId, sourceSnapshots, artifacts }) {
  const stableInputs = {
    schemaVersion: ARTIFACT_SCHEMA_VERSION,
    regionId,
    sourceSnapshots: sourceSnapshots.map(({ id, sha256: digest, retrievedAt }) => ({
      id,
      sha256: digest,
      retrievedAt,
    })).sort((left, right) => left.id.localeCompare(right.id)),
    artifacts: Object.fromEntries(Object.entries(artifacts).sort(([left], [right]) =>
      left.localeCompare(right)).map(([path, metadata]) => [path, metadata.sha256])),
  };
  return `build_${sha256(stableJson(stableInputs)).slice(0, 32)}`;
}

function collectSnapshotRecords(value, retrievedAt, path = [], records = []) {
  if (!value || typeof value !== "object") return records;
  const currentRetrievedAt = typeof value.retrievedAt === "string" ? value.retrievedAt : retrievedAt;
  if (typeof value.sha256 === "string" && /^[0-9a-f]{64}$/.test(value.sha256)) {
    records.push({
      id: path.join("."),
      ...(typeof value.path === "string" ? { path: value.path } : {}),
      sha256: value.sha256,
      retrievedAt: currentRetrievedAt,
    });
  }
  for (const [key, child] of Object.entries(value).sort()) {
    collectSnapshotRecords(child, currentRetrievedAt, [...path, key], records);
  }
  return records;
}

export function sourceSnapshotRecords(input, fallbackInput, retrievedAt) {
  const declared = collectSnapshotRecords(input?.sourceManifest, input?.sourceManifest?.retrievedAt)
    .filter(({ retrievedAt: timestamp }) =>
      typeof timestamp === "string" && !Number.isNaN(Date.parse(timestamp)));
  if (declared.length > 0) return declared.sort((left, right) => left.id.localeCompare(right.id));
  return [{
    id: "canonical-build-input",
    sha256: sha256(stableJson(fallbackInput)),
    retrievedAt,
  }];
}

export function defaultArtifactPolicy(path) {
  if (path === "qa.json" || path.startsWith("segment-provenance/")) {
    return { role: "diagnostic", application: "optional" };
  }
  if (path === "nodes.ndjson") return { role: "runtime", application: "optional" };
  return { role: "runtime", application: "required" };
}

export function contentTypeForArtifact(path) {
  if (path.endsWith(".ndjson")) return "application/x-ndjson";
  if (path.endsWith(".geojson")) return "application/geo+json";
  return "application/json";
}

export function enforceRuntimeShardSizeTargets(
  artifacts,
  paths,
  exceptionNotes = {},
  {
    rawBytes: rawTarget = MAX_RUNTIME_SHARD_RAW_BYTES,
    compressedBytes: compressedTarget = MAX_RUNTIME_SHARD_GZIP_BYTES,
  } = {},
) {
  const exceptions = [];
  for (const path of paths) {
    const metadata = artifacts[path];
    const rawBytes = metadata?.rawBytes ?? metadata?.bytes;
    const compressedBytes = metadata?.compressedBytes ?? metadata?.gzipBytes;
    if (!Number.isInteger(rawBytes) || !Number.isInteger(compressedBytes)) {
      throw new TypeError(`Runtime geometry shard ${path} has no measured sizes`);
    }
    if (rawBytes <= rawTarget && compressedBytes <= compressedTarget) continue;
    const note = exceptionNotes[path];
    if (typeof note !== "string" || !note.trim()) {
      throw new Error(
        `Runtime geometry shard ${path} exceeds the ${rawTarget} raw-byte or ` +
        `${compressedTarget} gzip-byte target; add an explicit shardSizeExceptions note`,
      );
    }
    exceptions.push({ path, rawBytes, compressedBytes, note: note.trim() });
  }
  return exceptions;
}
