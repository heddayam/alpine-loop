import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import { contentTypeForArtifact, stableJson } from "./artifact-contract.mjs";
import { validateArtifactDirectory } from "./validate-artifacts.mjs";

export const CURRENT_TRAIL_POINTER_SCHEMA_VERSION = 1;
export const CURRENT_TRAIL_POINTER_PATH = "current.json";
export const RUNTIME_SEARCH_INDEX_PATH = "search-index.json";

export class TrailPublicationError extends Error {
  constructor(message) {
    super(message);
    this.name = "TrailPublicationError";
  }
}

function validPathPart(value) {
  return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value) &&
    value !== "." && value !== "..";
}

function validSha256(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function validateRegionBuild(regionId, buildId) {
  if (!validPathPart(regionId)) throw new TrailPublicationError("The manifest has an invalid region ID.");
  if (!/^build_[a-f0-9]{32}$/.test(buildId ?? "")) {
    throw new TrailPublicationError("The manifest has an invalid build ID.");
  }
}

function validateAcceptedManifest(manifest) {
  if (manifest?.schemaVersion !== 2) {
    throw new TrailPublicationError("Only artifact contract v2 builds may be published.");
  }
  validateRegionBuild(manifest.region?.id, manifest.buildId);
  if (!["pass", "pass-with-exceptions"].includes(manifest.decisions?.qa?.decision)) {
    throw new TrailPublicationError("Publication requires a passing QA decision.");
  }
  if (manifest.decisions?.review?.decision !== "accepted" ||
      typeof manifest.decisions.review.reviewer !== "string" ||
      !manifest.decisions.review.reviewer.trim()) {
    throw new TrailPublicationError("Publication requires an accepted review with reviewer identity.");
  }
  return manifest;
}

function buildPrefix(regionId, buildId) {
  validateRegionBuild(regionId, buildId);
  return `trails/${regionId}/${buildId}`;
}

export function currentTrailPointerKey(regionId) {
  if (!validPathPart(regionId)) throw new TrailPublicationError("Invalid trail region ID.");
  return `trails/${regionId}/${CURRENT_TRAIL_POINTER_PATH}`;
}

function immutableKey(regionId, buildId, path) {
  if (!path || path.startsWith("/") || path.includes("\\") ||
      path.split("/").some((part) => !validPathPart(part))) {
    throw new TrailPublicationError(`Invalid immutable artifact path ${JSON.stringify(path)}.`);
  }
  return `${buildPrefix(regionId, buildId)}/${path}`;
}

async function* bodyChunks(body) {
  if (body instanceof Uint8Array) {
    yield body;
    return;
  }
  if (body instanceof ArrayBuffer) {
    yield new Uint8Array(body);
    return;
  }
  if (body?.getReader instanceof Function) {
    const reader = body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        yield value;
      }
    } finally {
      reader.releaseLock();
    }
    return;
  }
  if (body?.[Symbol.asyncIterator] instanceof Function) {
    for await (const chunk of body) yield chunk;
    return;
  }
  throw new TrailPublicationError("Object storage returned an unreadable body.");
}

async function digestBody(body, maximumBytes = Number.MAX_SAFE_INTEGER) {
  const hash = createHash("sha256");
  let bytes = 0;
  const chunks = [];
  for await (const chunk of bodyChunks(body)) {
    const value = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    bytes += value.byteLength;
    if (bytes > maximumBytes) throw new TrailPublicationError("Object exceeds its declared size.");
    hash.update(value);
    chunks.push(value);
  }
  return { bytes, sha256: hash.digest("hex"), chunks };
}

async function fileMetadata(path) {
  const stats = await lstat(path);
  if (!stats.isFile()) throw new TrailPublicationError(`${path} must be a regular file.`);
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    bytes += chunk.byteLength;
    hash.update(chunk);
  }
  return { rawBytes: bytes, sha256: hash.digest("hex") };
}

function fileBody(path) {
  return Readable.toWeb(createReadStream(path));
}

function immutableHttpMetadata(path, declaredContentType) {
  return {
    contentType: declaredContentType ?? contentTypeForArtifact(path),
    cacheControl: "private, max-age=31536000, immutable",
    contentEncoding: "identity",
  };
}

function pointerHttpMetadata() {
  return {
    contentType: "application/json; charset=utf-8",
    cacheControl: "private, no-store",
    contentEncoding: "identity",
  };
}

async function verifyRemoteObject(store, expected) {
  let object;
  try {
    object = await store.get(expected.key);
  } catch (error) {
    throw new TrailPublicationError(
      `Unable to verify uploaded object ${expected.key}: ${error?.message ?? "storage failure"}`,
    );
  }
  if (!object) throw new TrailPublicationError(`Uploaded object ${expected.key} is missing.`);
  if (object.size !== expected.rawBytes) {
    throw new TrailPublicationError(`Uploaded object ${expected.key} has the wrong size.`);
  }
  if (object.customMetadata?.sha256 !== expected.sha256) {
    throw new TrailPublicationError(`Uploaded object ${expected.key} has invalid hash metadata.`);
  }
  const actualHttpMetadata = object.httpMetadata ?? {
    contentType: object.headers?.get?.("content-type") ?? undefined,
    cacheControl: object.headers?.get?.("cache-control") ?? undefined,
    contentEncoding: object.headers?.get?.("content-encoding") ?? undefined,
  };
  for (const field of ["contentType", "cacheControl", "contentEncoding"]) {
    if (actualHttpMetadata[field] !== expected.httpMetadata[field]) {
      throw new TrailPublicationError(
        `Uploaded object ${expected.key} has invalid ${field} metadata.`,
      );
    }
  }
  const measured = await digestBody(object.body, expected.rawBytes);
  if (measured.bytes !== expected.rawBytes || measured.sha256 !== expected.sha256) {
    throw new TrailPublicationError(`Uploaded object ${expected.key} failed byte verification.`);
  }
}

async function uploadImmutableFile(store, file) {
  const httpMetadata = immutableHttpMetadata(file.path, file.contentType);
  let result;
  try {
    result = await store.putImmutable(file.key, fileBody(file.absolutePath), {
      size: file.rawBytes,
      httpMetadata,
      customMetadata: { sha256: file.sha256 },
    });
  } catch (error) {
    throw new TrailPublicationError(
      `Unable to upload immutable object ${file.key}: ${error?.message ?? "storage failure"}`,
    );
  }
  if (result !== "created" && result !== "already-present") {
    throw new TrailPublicationError(`Storage returned an invalid immutable upload result for ${file.key}.`);
  }
  await verifyRemoteObject(store, { ...file, httpMetadata });
  return result;
}

function namedTrailIds(namedPayload) {
  if (!Array.isArray(namedPayload?.trails) ||
      namedPayload.trails.some(({ id }) => typeof id !== "string" || !id)) {
    throw new TrailPublicationError("The named-trail metadata is invalid.");
  }
  const ids = namedPayload.trails.map(({ id }) => id).sort();
  if (new Set(ids).size !== ids.length) {
    throw new TrailPublicationError("The named-trail metadata contains duplicate IDs.");
  }
  return ids;
}

function validateSearchIndex(searchIndex, manifest, manifestSha256, expectedTrailIds) {
  if (searchIndex?.schemaVersion !== 1 || searchIndex.regionId !== manifest.region.id ||
      searchIndex.source?.manifestSha256 !== manifestSha256 ||
      searchIndex.source?.namedTrailsSha256 !== manifest.artifacts["named-trails.json"]?.sha256 ||
      searchIndex.source?.segmentsIndexSha256 !== manifest.artifacts["segments/index.json"]?.sha256 ||
      searchIndex.source?.trailGeometryIndexSha256 !==
        manifest.artifacts["trail-geometry/index.json"]?.sha256 ||
      searchIndex.source?.segmentPartitionPrefixLength !==
        manifest.delivery?.partitioning?.prefixLength ||
      !searchIndex.trails || typeof searchIndex.trails !== "object" || Array.isArray(searchIndex.trails)) {
    throw new TrailPublicationError("The runtime search index does not match the accepted manifest.");
  }
  if (JSON.stringify(Object.keys(searchIndex.trails).sort()) !== JSON.stringify(expectedTrailIds)) {
    throw new TrailPublicationError("The runtime search index must exactly cover named trails.");
  }
}

function artifactReference(file) {
  return {
    path: file.path,
    rawBytes: file.rawBytes,
    sha256: file.sha256,
  };
}

function buildReference(manifest, manifestFile, searchIndexFile) {
  return {
    buildId: manifest.buildId,
    manifest: artifactReference(manifestFile),
    searchIndex: artifactReference(searchIndexFile),
  };
}

function validateArtifactReference(reference, path) {
  if (!reference || reference.path !== path || !Number.isSafeInteger(reference.rawBytes) ||
      reference.rawBytes < 1 || !validSha256(reference.sha256)) {
    throw new TrailPublicationError(`Active pointer has an invalid ${path} reference.`);
  }
}

export function parseCurrentTrailPointer(value, expectedRegionId) {
  if (!value || value.schemaVersion !== CURRENT_TRAIL_POINTER_SCHEMA_VERSION ||
      value.regionId !== expectedRegionId || !value.active ||
      !Object.hasOwn(value, "previous") ||
      !["publish", "rollback"].includes(value.reason) ||
      typeof value.activatedAt !== "string" || Number.isNaN(Date.parse(value.activatedAt)) ||
      typeof value.activatedBy !== "string" || !value.activatedBy.trim()) {
    throw new TrailPublicationError("The active trail pointer is invalid.");
  }
  if (value.previous !== null && (!value.previous || typeof value.previous !== "object")) {
    throw new TrailPublicationError("The active trail pointer has an invalid previous reference.");
  }
  for (const reference of [value.active, ...(value.previous ? [value.previous] : [])]) {
    validateRegionBuild(value.regionId, reference.buildId);
    validateArtifactReference(reference.manifest, "manifest.json");
    validateArtifactReference(reference.searchIndex, RUNTIME_SEARCH_INDEX_PATH);
  }
  return value;
}

async function readCurrentPointer(store, regionId, { allowMissing = false } = {}) {
  const key = currentTrailPointerKey(regionId);
  let object;
  try {
    object = await store.get(key);
  } catch (error) {
    if (allowMissing && error?.code === "TRAIL_ARTIFACT_NOT_FOUND") {
      return { pointer: null, version: null };
    }
    throw new TrailPublicationError(
      `Unable to read active pointer ${key}: ${error?.message ?? "storage failure"}`,
    );
  }
  if (!object) {
    if (allowMissing) return { pointer: null, version: null };
    throw new TrailPublicationError(`Active pointer ${key} is missing.`);
  }
  if (object.size > 64 * 1024) throw new TrailPublicationError("The active pointer is too large.");
  const measured = await digestBody(object.body, 64 * 1024);
  const version = object.etag ?? object.version ??
    object.headers?.get?.("etag")?.replace(/^\"|\"$/g, "");
  if (typeof version !== "string" || !version) {
    throw new TrailPublicationError("The active pointer has no storage version for compare-and-swap.");
  }
  try {
    return {
      pointer: parseCurrentTrailPointer(
        JSON.parse(Buffer.concat(measured.chunks.map((chunk) => Buffer.from(chunk))).toString("utf8")),
        regionId,
      ),
      version,
    };
  } catch (error) {
    if (error instanceof TrailPublicationError) throw error;
    throw new TrailPublicationError("The active pointer is not valid JSON.");
  }
}

async function activatePointer(store, pointer, expectedVersion) {
  const bytes = Buffer.from(`${stableJson(pointer)}\n`);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const result = await store.putCurrent(
    currentTrailPointerKey(pointer.regionId),
    new Uint8Array(bytes),
    {
      size: bytes.byteLength,
      httpMetadata: pointerHttpMetadata(),
      customMetadata: { sha256 },
      expectedVersion,
    },
  );
  if (result !== "updated") {
    throw new TrailPublicationError(
      "The active trail pointer changed concurrently; publication was not activated.",
    );
  }
}

async function remoteFileForReference(store, regionId, reference, artifact) {
  const expected = {
    key: immutableKey(regionId, reference.buildId, artifact.path),
    path: artifact.path,
    rawBytes: artifact.rawBytes,
    sha256: artifact.sha256,
    httpMetadata: immutableHttpMetadata(artifact.path),
  };
  await verifyRemoteObject(store, expected);
  return expected;
}

async function remoteJsonForReference(store, regionId, reference, artifact) {
  const expected = await remoteFileForReference(store, regionId, reference, artifact);
  const object = await store.get(expected.key);
  const measured = await digestBody(object.body, expected.rawBytes);
  try {
    return JSON.parse(Buffer.concat(measured.chunks.map((chunk) => Buffer.from(chunk))).toString("utf8"));
  } catch {
    throw new TrailPublicationError(`Remote object ${expected.key} is not valid JSON.`);
  }
}

async function verifyAcceptedRemoteBuild(store, regionId, reference) {
  const manifest = validateAcceptedManifest(await remoteJsonForReference(
    store,
    regionId,
    reference,
    reference.manifest,
  ));
  if (manifest.region.id !== regionId || manifest.buildId !== reference.buildId) {
    throw new TrailPublicationError("The retained manifest does not match the rollback reference.");
  }
  for (const [path, metadata] of Object.entries(manifest.artifacts).sort(([left], [right]) =>
    left.localeCompare(right))) {
    await verifyRemoteObject(store, {
      key: immutableKey(regionId, reference.buildId, path),
      path,
      rawBytes: metadata.rawBytes,
      sha256: metadata.sha256,
      httpMetadata: immutableHttpMetadata(path, metadata.contentType),
    });
  }
  const searchIndex = await remoteJsonForReference(
    store,
    regionId,
    reference,
    reference.searchIndex,
  );
  const namedMetadata = manifest.artifacts["named-trails.json"];
  const namedPayload = await remoteJsonForReference(store, regionId, reference, {
    path: "named-trails.json",
    rawBytes: namedMetadata.rawBytes,
    sha256: namedMetadata.sha256,
  });
  validateSearchIndex(
    searchIndex,
    manifest,
    reference.manifest.sha256,
    namedTrailIds(namedPayload),
  );
  return manifest;
}

export async function publishRegionalBuild({
  artifactDirectory,
  searchIndexPath = resolve(artifactDirectory, RUNTIME_SEARCH_INDEX_PATH),
  store,
  activatedAt,
  activatedBy,
}) {
  if (!store?.get || !store?.putImmutable || !store?.putCurrent) {
    throw new TypeError("A versioned trail publication store is required.");
  }
  if (typeof activatedAt !== "string" || Number.isNaN(Date.parse(activatedAt)) ||
      typeof activatedBy !== "string" || !activatedBy.trim()) {
    throw new TypeError("Publication requires an activation timestamp and reviewer identity.");
  }
  const root = resolve(artifactDirectory);
  const validation = await validateArtifactDirectory(root);
  if (validation.schemaVersion !== 2) {
    throw new TrailPublicationError("Only artifact contract v2 builds may be published.");
  }
  const manifestPath = resolve(root, "manifest.json");
  const manifestText = await readFile(manifestPath, "utf8");
  const manifest = validateAcceptedManifest(JSON.parse(manifestText));
  if (manifest.region.id !== validation.regionId || manifest.buildId !== validation.buildId) {
    throw new TrailPublicationError("Artifact validation did not return the manifest build.");
  }

  const manifestMetadata = await fileMetadata(manifestPath);
  const resolvedSearchIndexPath = resolve(searchIndexPath);
  const searchIndexMetadata = await fileMetadata(resolvedSearchIndexPath);
  const searchIndex = JSON.parse(await readFile(resolvedSearchIndexPath, "utf8"));
  const namedPayload = JSON.parse(await readFile(resolve(root, "named-trails.json"), "utf8"));
  validateSearchIndex(
    searchIndex,
    manifest,
    manifestMetadata.sha256,
    namedTrailIds(namedPayload),
  );

  const prefix = buildPrefix(manifest.region.id, manifest.buildId);
  const artifactFiles = Object.entries(manifest.artifacts).sort(([left], [right]) =>
    left.localeCompare(right)).map(([path, metadata]) => ({
      key: `${prefix}/${path}`,
      path,
      absolutePath: resolve(root, path),
      rawBytes: metadata.rawBytes,
      sha256: metadata.sha256,
      contentType: metadata.contentType,
    }));
  const searchIndexFile = {
    key: `${prefix}/${RUNTIME_SEARCH_INDEX_PATH}`,
    path: RUNTIME_SEARCH_INDEX_PATH,
    absolutePath: resolvedSearchIndexPath,
    ...searchIndexMetadata,
    contentType: "application/json",
  };
  const manifestFile = {
    key: `${prefix}/manifest.json`,
    path: "manifest.json",
    absolutePath: manifestPath,
    ...manifestMetadata,
    contentType: "application/json",
  };

  const uploads = [];
  for (const file of [...artifactFiles, searchIndexFile, manifestFile]) {
    uploads.push({ key: file.key, result: await uploadImmutableFile(store, file) });
  }

  const active = buildReference(manifest, manifestFile, searchIndexFile);
  const currentState = await readCurrentPointer(store, manifest.region.id, { allowMissing: true });
  const current = currentState.pointer;
  if (current?.active.buildId === active.buildId) {
    if (stableJson(current.active) !== stableJson(active)) {
      throw new TrailPublicationError("The active build ID has conflicting immutable references.");
    }
    return { regionId: manifest.region.id, buildId: manifest.buildId, activated: false, uploads };
  }

  await activatePointer(store, {
    schemaVersion: CURRENT_TRAIL_POINTER_SCHEMA_VERSION,
    regionId: manifest.region.id,
    active,
    previous: current?.active ?? null,
    activatedAt,
    activatedBy: activatedBy.trim(),
    reason: "publish",
  }, currentState.version);
  return { regionId: manifest.region.id, buildId: manifest.buildId, activated: true, uploads };
}

export async function rollbackRegionalBuild({ regionId, store, activatedAt, activatedBy }) {
  if (typeof activatedAt !== "string" || Number.isNaN(Date.parse(activatedAt)) ||
      typeof activatedBy !== "string" || !activatedBy.trim()) {
    throw new TypeError("Rollback requires an activation timestamp and reviewer identity.");
  }
  const currentState = await readCurrentPointer(store, regionId);
  const current = currentState.pointer;
  if (!current.previous) throw new TrailPublicationError("No prior accepted build is available.");
  await verifyAcceptedRemoteBuild(store, regionId, current.previous);
  await activatePointer(store, {
    schemaVersion: CURRENT_TRAIL_POINTER_SCHEMA_VERSION,
    regionId,
    active: current.previous,
    previous: current.active,
    activatedAt,
    activatedBy: activatedBy.trim(),
    reason: "rollback",
  }, currentState.version);
  return { regionId, buildId: current.previous.buildId, rolledBackFrom: current.active.buildId };
}

/**
 * Thin adapter for a private R2 binding. Immutable conflicts are never
 * overwritten; the mutable current pointer uses an ETag compare-and-swap.
 */
export class R2VersionedTrailPublicationStore {
  constructor(bucket) {
    this.bucket = bucket;
  }

  async get(key) {
    return this.bucket.get(key);
  }

  async putImmutable(key, body, options) {
    const existing = await this.bucket.head(key);
    if (existing) return "already-present";
    const result = await this.bucket.put(key, body, {
      onlyIf: { etagDoesNotMatch: "*" },
      httpMetadata: options.httpMetadata,
      customMetadata: options.customMetadata,
    });
    if (!result) {
      if (await this.bucket.head(key)) return "already-present";
      throw new Error("conditional immutable upload failed");
    }
    return "created";
  }

  async putCurrent(key, body, options) {
    const onlyIf = options.expectedVersion === null
      ? { etagDoesNotMatch: "*" }
      : { etagMatches: options.expectedVersion };
    const result = await this.bucket.put(key, body, {
      onlyIf,
      httpMetadata: options.httpMetadata,
      customMetadata: options.customMetadata,
    });
    return result ? "updated" : "conflict";
  }
}
