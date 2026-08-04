#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { finished } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import { createGzip } from "node:zlib";
import {
  ARTIFACT_SCHEMA_VERSION,
  MAX_RUNTIME_SHARD_GZIP_BYTES,
  MAX_RUNTIME_SHARD_RAW_BYTES,
  contentTypeForArtifact,
  createBuildId,
  defaultArtifactPolicy,
  partitionPrefixLength,
  segmentPartitionKey,
} from "./artifact-contract.mjs";

function fail(message) {
  throw new Error(`Invalid trail artifact directory: ${message}`);
}

const EXACT_MANAGED_PATHS = new Set([
  "manifest.json",
  "named-trails.json",
  "access-points.geojson",
  "segments/index.json",
  "nodes.ndjson",
  "qa.json",
  "segment-provenance/index.json",
  "segments.ndjson",
]);

function isManagedPath(path) {
  return EXACT_MANAGED_PATHS.has(path) ||
    /^segments\/[0-9a-f]{1,8}\.ndjson$/.test(path) ||
    /^segment-provenance\/[0-9a-f]{1,8}\.json$/.test(path);
}

function validateDeclaredPaths(paths) {
  for (const path of paths) {
    if (typeof path !== "string" || !path || path.startsWith("/") || path.includes("\\") ||
        path.split("/").some((part) => !part || part === "." || part === "..")) {
      fail(`invalid declared artifact path ${JSON.stringify(path)}`);
    }
  }
}

async function inspectArtifactTree(declaredPaths, current, prefix = "") {
  const regularFiles = new Set();
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolutePath = resolve(current, entry.name);
    const declared = declaredPaths.has(path);
    const managed = isManagedPath(path);
    if (declared || managed) {
      if (!entry.isFile()) {
        fail(`${path} must be a regular file and may not be a symlink or directory`);
      }
      if (!declared) fail(`undeclared managed artifact ${path}`);
      regularFiles.add(path);
      continue;
    }
    if (entry.isDirectory()) {
      for (const child of await inspectArtifactTree(
        declaredPaths,
        absolutePath,
        path,
      )) regularFiles.add(child);
    }
    // Unrelated regular files and symlinks are deliberately ignored. Symlinks
    // are never traversed.
  }
  return regularFiles;
}

async function validateArtifactTree(directory, artifactPaths) {
  validateDeclaredPaths(artifactPaths);
  const declaredPaths = new Set(["manifest.json", ...artifactPaths]);
  const regularFiles = await inspectArtifactTree(declaredPaths, directory);
  for (const path of declaredPaths) {
    if (!regularFiles.has(path)) fail(`declared artifact ${path} is not a regular file`);
  }
}

async function measureFile(path) {
  const hash = createHash("sha256");
  const gzip = createGzip({ level: 9 });
  let rawBytes = 0;
  let compressedBytes = 0;
  gzip.on("data", (chunk) => { compressedBytes += chunk.byteLength; });
  const gzipFinished = finished(gzip);
  for await (const chunk of createReadStream(path)) {
    rawBytes += chunk.byteLength;
    hash.update(chunk);
    if (!gzip.write(chunk)) await new Promise((done) => gzip.once("drain", done));
  }
  gzip.end();
  await gzipFinished;
  return { rawBytes, compressedBytes, sha256: hash.digest("hex") };
}

async function ndjsonRecordCount(path, validate) {
  let records = 0;
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line) continue;
    const record = JSON.parse(line);
    validate?.(record, records);
    records += 1;
  }
  return records;
}

async function artifactRecordCount(path, filename, prefixLength) {
  if (filename.endsWith(".ndjson")) {
    const prefix = /^segments\/([0-9a-f]+)\.ndjson$/.exec(filename)?.[1];
    return ndjsonRecordCount(path, prefix ? (record) => {
      if (segmentPartitionKey(record.id, prefixLength) !== prefix) {
        fail(`${filename} contains record ${record.id} from another partition`);
      }
    } : undefined);
  }
  const value = JSON.parse(await readFile(path, "utf8"));
  if (filename === "named-trails.json") return value.trails?.length;
  if (filename === "access-points.geojson") return value.features?.length;
  if (filename.endsWith("/index.json")) return Object.keys(value.shards ?? {}).length;
  const provenancePrefix = /^segment-provenance\/([0-9a-f]+)\.json$/.exec(filename)?.[1];
  if (provenancePrefix) {
    if (value.partition !== provenancePrefix || !Array.isArray(value.segments)) {
      fail(`${filename} has invalid compact provenance metadata`);
    }
    for (const [segmentId] of value.segments) {
      if (segmentPartitionKey(segmentId, prefixLength) !== provenancePrefix) {
        fail(`${filename} contains record ${segmentId} from another partition`);
      }
    }
    return value.segments.length;
  }
  if (filename === "qa.json") return 1;
  fail(`cannot determine record count for ${filename}`);
}

function validateDecisions(decisions) {
  if (!decisions || !decisions.qa || !decisions.review) fail("decisions.qa and decisions.review are required");
  if (!["pending", "pass", "pass-with-exceptions", "fail"].includes(decisions.qa.decision) ||
      !("decidedAt" in decisions.qa) || !Array.isArray(decisions.qa.notes)) {
    fail("decisions.qa must explicitly declare decision, decidedAt, and notes");
  }
  if (!["pending", "accepted", "rejected"].includes(decisions.review.decision) ||
      !("reviewer" in decisions.review) || !("decidedAt" in decisions.review) ||
      !Array.isArray(decisions.review.notes)) {
    fail("decisions.review must explicitly declare decision, reviewer, decidedAt, and notes");
  }
  for (const decision of [decisions.qa, decisions.review]) {
    if (decision.decidedAt !== null && Number.isNaN(Date.parse(decision.decidedAt))) {
      fail("decision dates must be null or valid timestamps");
    }
  }
  if (decisions.qa.decision !== "pending" && decisions.qa.decidedAt === null) {
    fail("a completed QA decision requires a date");
  }
  if (decisions.review.decision !== "pending" && decisions.review.decidedAt === null) {
    fail("a completed review decision requires a date");
  }
  if (decisions.review.decision === "accepted" &&
      (typeof decisions.review.reviewer !== "string" || !decisions.review.reviewer.trim() ||
       decisions.review.decidedAt === null)) {
    fail("an accepted review requires reviewer identity and date");
  }
}

function validateSourceSnapshots(sourceSnapshots) {
  if (!Array.isArray(sourceSnapshots) || sourceSnapshots.length === 0) {
    fail("sourceSnapshots must be a non-empty array");
  }
  const ids = new Set();
  for (const snapshot of sourceSnapshots) {
    if (typeof snapshot.id !== "string" || !snapshot.id || ids.has(snapshot.id) ||
        !/^[0-9a-f]{64}$/.test(snapshot.sha256) ||
        typeof snapshot.retrievedAt !== "string" || Number.isNaN(Date.parse(snapshot.retrievedAt))) {
      fail("every source snapshot requires a unique id, SHA-256, and retrieval timestamp");
    }
    ids.add(snapshot.id);
  }
}

function validateArtifactMetadata(path, metadata) {
  const policy = defaultArtifactPolicy(path);
  if (!metadata || metadata.path !== path || !Number.isInteger(metadata.records) ||
      metadata.records < 0 || !Number.isInteger(metadata.rawBytes) || metadata.rawBytes < 0 ||
      !Number.isInteger(metadata.compressedBytes) || metadata.compressedBytes < 0 ||
      metadata.contentEncoding !== "identity" ||
      metadata.contentType !== contentTypeForArtifact(path) ||
      !/^[0-9a-f]{64}$/.test(metadata.sha256) ||
      !["runtime", "diagnostic"].includes(metadata.role) ||
      !["required", "optional"].includes(metadata.application) ||
      metadata.role !== policy.role || metadata.application !== policy.application) {
    fail(`${path} has incomplete or invalid v2 metadata`);
  }
}

function validateIndex(index, manifest, kind) {
  const prefixLength = partitionPrefixLength(index);
  if (prefixLength !== manifest.delivery.partitioning.prefixLength) {
    fail(`${kind} index prefix length does not match the manifest`);
  }
  for (const [prefix, shard] of Object.entries(index.shards ?? {})) {
    if (prefix.length !== prefixLength || !/^[0-9a-f]+$/.test(prefix) ||
        !Number.isInteger(shard.records) || shard.records < 0) {
      fail(`${kind} index has invalid shard ${prefix}`);
    }
    const metadata = manifest.artifacts[shard.path];
    if (!metadata || metadata.records !== shard.records) {
      fail(`${kind} index shard ${prefix} does not match manifest records`);
    }
  }
  return prefixLength;
}

export async function validateArtifactDirectory(directory) {
  const root = resolve(directory);
  const manifestPath = resolve(root, "manifest.json");
  const manifestStats = await lstat(manifestPath);
  if (!manifestStats.isFile()) fail("manifest.json must be a regular file and may not be a symlink");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest.schemaVersion === 1) {
    const declaredFiles = Object.keys(manifest.artifacts ?? {}).sort();
    await validateArtifactTree(root, declaredFiles);
    for (const path of declaredFiles) {
      const measured = await measureFile(resolve(root, path));
      const metadata = manifest.artifacts[path];
      if (metadata?.path !== path) fail(`v1 metadata path mismatch for ${path}`);
      if (measured.rawBytes !== metadata.bytes || measured.compressedBytes !== metadata.gzipBytes ||
          measured.sha256 !== metadata.sha256) fail(`v1 metadata mismatch for ${path}`);
    }
    return { schemaVersion: 1, regionId: manifest.region?.id, files: declaredFiles.length };
  }
  if (manifest.schemaVersion !== ARTIFACT_SCHEMA_VERSION) fail("unsupported manifest schemaVersion");
  if (!/^build_[0-9a-f]{32}$/.test(manifest.buildId) ||
      typeof manifest.region?.id !== "string" || !manifest.region.id) fail("invalid build or region id");
  validateSourceSnapshots(manifest.sourceSnapshots);
  validateDecisions(manifest.decisions);
  if (manifest.delivery?.partitioning?.algorithm !== "segment-id-hex-prefix") {
    fail("manifest partitioning algorithm must be segment-id-hex-prefix");
  }
  if (manifest.delivery.partitioning.prefixLength !== 2 &&
      (typeof manifest.delivery.partitioning.exceptionNote !== "string" ||
       !manifest.delivery.partitioning.exceptionNote.trim())) {
    fail("a non-default partition prefix length requires a measured exception note");
  }

  const declaredFiles = Object.keys(manifest.artifacts ?? {}).sort();
  await validateArtifactTree(root, declaredFiles);
  for (const requiredPath of ["named-trails.json", "access-points.geojson", "segments/index.json"]) {
    const metadata = manifest.artifacts[requiredPath];
    if (metadata?.role !== "runtime" || metadata.application !== "required") {
      fail(`${requiredPath} must be a required runtime artifact`);
    }
  }

  const segmentIndex = JSON.parse(await readFile(resolve(root, "segments/index.json"), "utf8"));
  const provenanceIndex = JSON.parse(await readFile(
    resolve(root, "segment-provenance/index.json"),
    "utf8",
  ));
  const prefixLength = validateIndex(segmentIndex, manifest, "segment");
  validateIndex(provenanceIndex, manifest, "provenance");

  for (const path of declaredFiles) {
    const metadata = manifest.artifacts[path];
    validateArtifactMetadata(path, metadata);
    const measured = await measureFile(resolve(root, path));
    if (measured.rawBytes !== metadata.rawBytes ||
        measured.compressedBytes !== metadata.compressedBytes || measured.sha256 !== metadata.sha256) {
      fail(`hash or size mismatch for ${path}`);
    }
    const records = await artifactRecordCount(resolve(root, path), path, prefixLength);
    if (records !== metadata.records) fail(`record count mismatch for ${path}`);
  }

  const targets = manifest.delivery.shardSizeTargets;
  if (targets?.rawBytes !== MAX_RUNTIME_SHARD_RAW_BYTES ||
      targets?.compressedBytes !== MAX_RUNTIME_SHARD_GZIP_BYTES ||
      !Array.isArray(targets.exceptions)) fail("invalid runtime shard size targets");
  const exceptions = new Map(targets.exceptions.map((exception) => [exception.path, exception]));
  for (const shard of Object.values(segmentIndex.shards)) {
    const metadata = manifest.artifacts[shard.path];
    const oversized = metadata.rawBytes > targets.rawBytes ||
      metadata.compressedBytes > targets.compressedBytes;
    const exception = exceptions.get(shard.path);
    if (oversized && (!exception || typeof exception.note !== "string" || !exception.note.trim() ||
        exception.rawBytes !== metadata.rawBytes ||
        exception.compressedBytes !== metadata.compressedBytes)) {
      fail(`oversized runtime shard ${shard.path} lacks an exact exception note`);
    }
    if (!oversized && exception) fail(`runtime shard ${shard.path} has an unnecessary exception`);
    exceptions.delete(shard.path);
  }
  if (exceptions.size > 0) fail("shard exceptions reference unknown geometry shards");

  const expectedBuildId = createBuildId({
    regionId: manifest.region.id,
    sourceSnapshots: manifest.sourceSnapshots,
    artifacts: manifest.artifacts,
  });
  if (manifest.buildId !== expectedBuildId) fail("buildId is inconsistent with stable inputs and artifacts");
  return {
    schemaVersion: ARTIFACT_SCHEMA_VERSION,
    regionId: manifest.region.id,
    buildId: manifest.buildId,
    files: declaredFiles.length,
  };
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) {
  const directory = process.argv[2];
  if (!directory) throw new Error("Usage: node scripts/trails/validate-artifacts.mjs <directory>");
  const result = await validateArtifactDirectory(directory);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
