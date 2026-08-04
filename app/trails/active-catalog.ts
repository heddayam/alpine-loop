import type { LocatedTrailArtifact, TrailArtifactManifest } from "./artifact-locator";
import type {
  AccessPointFeature,
  NamedTrailRecord,
  RegionalTrailCatalog,
  TrailSearchSummary,
} from "./search";
import type { TrailArtifactObject, TrailArtifactStore } from "./storage";
import { locateTrailArtifact } from "./artifact-locator.ts";
import { parseSelectedSegmentNdjson } from "./segment-reader.ts";

const CURRENT_POINTER_SCHEMA_VERSION = 1;
const MAX_POINTER_BYTES = 64 * 1024;
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_RUNTIME_METADATA_BYTES = 64 * 1024 * 1024;
const MAX_RUNTIME_GEOMETRY_BYTES = 8 * 1024 * 1024;
const MAX_RUNTIME_GEOMETRY_COMPRESSED_BYTES = 2 * 1024 * 1024;
const MAX_RUNTIME_GEOMETRY_EXCEPTION_BYTES = 16 * 1024 * 1024;
const CATALOG_CACHE_TTL_MS = 15_000;
const MAX_CACHED_CATALOGS = 1;

type ArtifactReference = {
  path: string;
  rawBytes: number;
  sha256: string;
};

export type RuntimeArtifactExpectation = Pick<ArtifactReference, "rawBytes" | "sha256">;

export type ActiveBuildReference = {
  buildId: string;
  manifest: ArtifactReference;
  searchIndex: ArtifactReference;
};

export type CurrentTrailPointer = {
  schemaVersion: 1;
  regionId: string;
  active: ActiveBuildReference;
  previous: ActiveBuildReference | null;
  activatedAt: string;
  activatedBy: string;
  reason: "publish" | "rollback";
};

type V2Manifest = RegionalTrailCatalog["manifest"] & TrailArtifactManifest & {
  schemaVersion: 2;
  buildId: string;
  artifacts: Record<string, {
    path: string;
    records: number;
    rawBytes: number;
    compressedBytes: number;
    sha256: string;
    role: "runtime" | "diagnostic";
    application: "required" | "optional";
  }>;
  delivery: {
    lazyTrailGeometryIndex: string;
    partitioning: { algorithm?: string; prefixLength: number };
    shardSizeTargets: {
      rawBytes: number;
      compressedBytes: number;
      exceptions: Array<{
        path: string;
        rawBytes: number;
        compressedBytes: number;
        note: string;
      }>;
    };
  };
  decisions: {
    qa: { decision: "pending" | "pass" | "pass-with-exceptions" | "fail" };
    review: { decision: "pending" | "accepted" | "rejected"; reviewer: string | null };
  };
};

export type ActiveRegionalTrailCatalog = {
  catalog: RegionalTrailCatalog;
  pointer: CurrentTrailPointer;
};

export class TrailRuntimeCatalogError extends Error {
  readonly code = "TRAIL_RUNTIME_CATALOG_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "TrailRuntimeCatalogError";
  }
}

function validRegionId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
}

function validBuildId(value: unknown): value is string {
  return typeof value === "string" && /^build_[a-f0-9]{32}$/.test(value);
}

function validSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function parseArtifactReference(value: unknown, expectedPath: string): ArtifactReference {
  const reference = value as Partial<ArtifactReference> | null;
  if (!reference || reference.path !== expectedPath ||
      !Number.isSafeInteger(reference.rawBytes) || reference.rawBytes! < 1 ||
      !validSha256(reference.sha256)) {
    throw new TrailRuntimeCatalogError(`The active pointer has an invalid ${expectedPath} reference.`);
  }
  return reference as ArtifactReference;
}

function parseBuildReference(value: unknown): ActiveBuildReference {
  const reference = value as Partial<ActiveBuildReference> | null;
  if (!reference || !validBuildId(reference.buildId)) {
    throw new TrailRuntimeCatalogError("The active pointer has an invalid build reference.");
  }
  return {
    buildId: reference.buildId,
    manifest: parseArtifactReference(reference.manifest, "manifest.json"),
    searchIndex: parseArtifactReference(reference.searchIndex, "search-index.json"),
  };
}

export function parseCurrentTrailPointer(value: unknown, expectedRegionId: string) {
  const pointer = value as Partial<CurrentTrailPointer> | null;
  const reason = pointer?.reason;
  if (!pointer || pointer.schemaVersion !== CURRENT_POINTER_SCHEMA_VERSION ||
      pointer.regionId !== expectedRegionId || !validRegionId(pointer.regionId) ||
      (reason !== "publish" && reason !== "rollback") ||
      typeof pointer.activatedAt !== "string" || Number.isNaN(Date.parse(pointer.activatedAt)) ||
      typeof pointer.activatedBy !== "string" || !pointer.activatedBy.trim()) {
    throw new TrailRuntimeCatalogError("The active trail pointer is invalid.");
  }
  return {
    schemaVersion: CURRENT_POINTER_SCHEMA_VERSION,
    regionId: pointer.regionId,
    active: parseBuildReference(pointer.active),
    previous: pointer.previous === null ? null : parseBuildReference(pointer.previous),
    activatedAt: pointer.activatedAt,
    activatedBy: pointer.activatedBy,
    reason,
  } satisfies CurrentTrailPointer;
}

async function sha256(bytes: Uint8Array) {
  const copied = new Uint8Array(bytes.byteLength);
  copied.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copied.buffer);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export async function readVerifiedRuntimeArtifactBytes(
  object: TrailArtifactObject,
  maximumBytes: number,
  expected?: RuntimeArtifactExpectation,
) {
  if (!Number.isSafeInteger(object.size) || object.size < 0 || object.size > maximumBytes) {
    throw new TrailRuntimeCatalogError(`Trail artifact ${object.key} exceeds its runtime byte limit.`);
  }
  if (expected && object.size !== expected.rawBytes) {
    throw new TrailRuntimeCatalogError(`Trail artifact ${object.key} has the wrong size.`);
  }
  const reader = object.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maximumBytes || (expected && size > expected.rawBytes)) {
      await reader.cancel();
      throw new TrailRuntimeCatalogError(`Trail artifact ${object.key} exceeds its declared size.`);
    }
    chunks.push(value);
  }
  if (size !== object.size || (expected && size !== expected.rawBytes)) {
    throw new TrailRuntimeCatalogError(`Trail artifact ${object.key} returned incomplete bytes.`);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (expected && await sha256(bytes) !== expected.sha256) {
    throw new TrailRuntimeCatalogError(`Trail artifact ${object.key} failed content verification.`);
  }
  return bytes;
}

async function readJson(
  store: TrailArtifactStore,
  artifact: LocatedTrailArtifact,
  maximumBytes: number,
  reference?: ArtifactReference,
) {
  const object = await store.get(artifact.key, {
    ...(artifact.expectedSha256 ? { expectedSha256: artifact.expectedSha256 } : {}),
  });
  const bytes = await readVerifiedRuntimeArtifactBytes(object, maximumBytes, reference);
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new TrailRuntimeCatalogError(`Trail artifact ${artifact.key} is not valid JSON.`);
  }
}

function activeArtifact(regionId: string, reference: ActiveBuildReference, artifact: ArtifactReference) {
  return {
    key: `trails/${regionId}/${reference.buildId}/${artifact.path}`,
    backend: "private-r2" as const,
    expectedSha256: artifact.sha256,
  };
}

function validateManifest(
  value: unknown,
  pointer: CurrentTrailPointer,
): V2Manifest {
  const manifest = value as Partial<V2Manifest> | null;
  const prefixLength = manifest?.delivery?.partitioning?.prefixLength;
  if (!manifest || manifest.schemaVersion !== 2 ||
      manifest.region?.id !== pointer.regionId || manifest.buildId !== pointer.active.buildId ||
      !["pass", "pass-with-exceptions"].includes(manifest.decisions?.qa?.decision ?? "") ||
      manifest.decisions?.review?.decision !== "accepted" ||
      typeof manifest.decisions.review.reviewer !== "string" ||
      !manifest.decisions.review.reviewer.trim() ||
      manifest.delivery?.lazyTrailGeometryIndex !== "trail-geometry/index.json" ||
      manifest.delivery?.partitioning?.algorithm !== "segment-id-hex-prefix" ||
      manifest.delivery?.shardSizeTargets?.rawBytes !== MAX_RUNTIME_GEOMETRY_BYTES ||
      manifest.delivery?.shardSizeTargets?.compressedBytes !==
        MAX_RUNTIME_GEOMETRY_COMPRESSED_BYTES ||
      !Array.isArray(manifest.delivery?.shardSizeTargets?.exceptions) ||
      !Number.isInteger(prefixLength) || prefixLength! < 1 || prefixLength! > 8 ||
      !manifest.artifacts || typeof manifest.artifacts !== "object") {
    throw new TrailRuntimeCatalogError("The active manifest is not an accepted v2 build.");
  }
  for (const path of [
    "named-trails.json",
    "access-points.geojson",
    "segments/index.json",
    "trail-geometry/index.json",
  ]) {
    const metadata = manifest.artifacts[path];
    if (!metadata || metadata.path !== path || metadata.role !== "runtime" ||
        metadata.application !== "required" || !validSha256(metadata.sha256) ||
        !Number.isSafeInteger(metadata.rawBytes) || metadata.rawBytes < 1) {
      throw new TrailRuntimeCatalogError(`The active manifest has no valid required ${path}.`);
    }
  }
  return manifest as V2Manifest;
}

function manifestArtifact(manifest: V2Manifest, path: string) {
  const metadata = manifest.artifacts[path];
  return {
    located: {
      key: `trails/${manifest.region.id}/${manifest.buildId}/${path}`,
      backend: "private-r2" as const,
      expectedSha256: metadata.sha256,
    },
    reference: { path, rawBytes: metadata.rawBytes, sha256: metadata.sha256 },
  };
}

function requireObject(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TrailRuntimeCatalogError(message);
  }
  return value as Record<string, unknown>;
}

export async function loadActiveRegionalTrailCatalog(
  store: TrailArtifactStore,
  regionId: string,
): Promise<ActiveRegionalTrailCatalog> {
  if (!validRegionId(regionId)) throw new TrailRuntimeCatalogError("Invalid trail region ID.");
  const pointerArtifact = {
    key: `trails/${regionId}/current.json`,
    backend: "private-r2" as const,
  };
  const pointer = parseCurrentTrailPointer(
    await readJson(store, pointerArtifact, MAX_POINTER_BYTES),
    regionId,
  );
  const manifest = validateManifest(
    await readJson(
      store,
      activeArtifact(regionId, pointer.active, pointer.active.manifest),
      MAX_MANIFEST_BYTES,
      pointer.active.manifest,
    ),
    pointer,
  );
  const namedArtifact = manifestArtifact(manifest, "named-trails.json");
  const accessArtifact = manifestArtifact(manifest, "access-points.geojson");
  const segmentIndexArtifact = manifestArtifact(manifest, "segments/index.json");
  const trailGeometryIndexArtifact = manifestArtifact(manifest, "trail-geometry/index.json");
  // Hydrate sequentially so only one serialized metadata object is buffered at
  // a time. The parsed catalog is cached separately below with a one-entry cap.
  const namedValue = await readJson(
    store,
    namedArtifact.located,
    MAX_RUNTIME_METADATA_BYTES,
    namedArtifact.reference,
  );
  const accessValue = await readJson(
    store,
    accessArtifact.located,
    MAX_RUNTIME_METADATA_BYTES,
    accessArtifact.reference,
  );
  const segmentIndexValue = await readJson(
    store,
    segmentIndexArtifact.located,
    MAX_RUNTIME_METADATA_BYTES,
    segmentIndexArtifact.reference,
  );
  const trailGeometryIndexValue = await readJson(
    store,
    trailGeometryIndexArtifact.located,
    MAX_RUNTIME_METADATA_BYTES,
    trailGeometryIndexArtifact.reference,
  );
  const searchIndexValue = await readJson(
    store,
    activeArtifact(regionId, pointer.active, pointer.active.searchIndex),
    MAX_RUNTIME_METADATA_BYTES,
    pointer.active.searchIndex,
  );
  const namedPayload = requireObject(namedValue, "The active named-trail metadata is invalid.");
  const accessPayload = requireObject(accessValue, "The active access-point metadata is invalid.");
  const segmentIndex = requireObject(segmentIndexValue, "The active segment index is invalid.");
  const trailGeometryIndex = requireObject(
    trailGeometryIndexValue,
    "The active trail geometry index is invalid.",
  );
  const searchIndex = requireObject(searchIndexValue, "The active search index is invalid.");
  const partitioning = requireObject(
    segmentIndex.partitioning,
    "The active segment index has no partition contract.",
  );
  const shards = requireObject(segmentIndex.shards, "The active segment index has no shards.");
  const geometryObjects = requireObject(
    trailGeometryIndex.objects,
    "The active trail geometry index has no objects.",
  );
  const source = requireObject(searchIndex.source, "The active search index has no source contract.");
  if (namedPayload.regionId !== regionId || accessPayload.regionId !== regionId ||
      segmentIndex.regionId !== regionId || trailGeometryIndex.regionId !== regionId ||
      searchIndex.regionId !== regionId ||
      segmentIndex.schemaVersion !== 2 || trailGeometryIndex.schemaVersion !== 2 ||
      searchIndex.schemaVersion !== 1 ||
      !Array.isArray(namedPayload.trails) || !Array.isArray(accessPayload.features) ||
      !Number.isInteger(partitioning.prefixLength) ||
      partitioning.prefixLength !== manifest.delivery.partitioning.prefixLength ||
      partitioning.algorithm !== "segment-id-hex-prefix" ||
      source.manifestSha256 !== pointer.active.manifest.sha256 ||
      source.namedTrailsSha256 !== namedArtifact.reference.sha256 ||
      source.segmentsIndexSha256 !== segmentIndexArtifact.reference.sha256 ||
      source.trailGeometryIndexSha256 !== trailGeometryIndexArtifact.reference.sha256 ||
      source.segmentPartitionPrefixLength !== partitioning.prefixLength ||
      !searchIndex.trails || typeof searchIndex.trails !== "object" || Array.isArray(searchIndex.trails)) {
    throw new TrailRuntimeCatalogError("The active runtime metadata does not match its manifest.");
  }
  const shardPaths = Object.fromEntries(Object.entries(shards).map(([prefix, value]) => {
    const shard = requireObject(value, `The active segment shard ${prefix} is invalid.`);
    const path = shard.path;
    const metadata = typeof path === "string" ? manifest.artifacts[path] : undefined;
    if (prefix.length !== partitioning.prefixLength || !/^[0-9a-f]+$/.test(prefix) ||
        !Number.isSafeInteger(shard.records) || (shard.records as number) < 0 ||
        !metadata || metadata.path !== path || metadata.role !== "runtime" ||
        metadata.application !== "required" || !validSha256(metadata.sha256) ||
        metadata.records !== shard.records ||
        !Number.isSafeInteger(metadata.rawBytes) || metadata.rawBytes < 1) {
      throw new TrailRuntimeCatalogError(`The active segment shard ${prefix} is undeclared.`);
    }
    return [prefix, path];
  }));
  const namedTrails = namedPayload.trails as NamedTrailRecord[];
  const expectedTrailIds = namedTrails.map(({ id }) => id).sort();
  if (JSON.stringify(Object.keys(searchIndex.trails as Record<string, unknown>).sort()) !==
      JSON.stringify(expectedTrailIds)) {
    throw new TrailRuntimeCatalogError("The active search index has incomplete trail coverage.");
  }
  const indexedTrailIds = Object.keys(geometryObjects).sort();
  if (JSON.stringify(expectedTrailIds) !== JSON.stringify(indexedTrailIds)) {
    throw new TrailRuntimeCatalogError("The active trail geometry index has incomplete coverage.");
  }
  const trailGeometryPaths = Object.fromEntries(namedTrails.map((trail) => {
    const entry = requireObject(
      geometryObjects[trail.id],
      `The active trail geometry entry ${trail.id} is invalid.`,
    );
    const prefix = /^named-trail_([0-9a-f]{2})[0-9a-f]+$/.exec(trail.id)?.[1];
    const expectedPath = prefix ? `trail-geometry/${prefix}/${trail.id}.ndjson` : null;
    const metadata = typeof entry.path === "string" ? manifest.artifacts[entry.path] : undefined;
    if (entry.path !== expectedPath || entry.records !== trail.segmentIds.length || !metadata ||
        metadata.path !== entry.path || metadata.role !== "runtime" ||
        metadata.application !== "required" || !validSha256(metadata.sha256) ||
        metadata.records !== entry.records ||
        !Number.isSafeInteger(metadata.rawBytes) || metadata.rawBytes < 1 ||
        !Number.isSafeInteger(metadata.compressedBytes) || metadata.compressedBytes < 1) {
      throw new TrailRuntimeCatalogError(`The active trail geometry entry ${trail.id} is invalid.`);
    }
    return [trail.id, entry.path as string];
  }));
  const declaredTrailGeometryPaths = Object.keys(manifest.artifacts)
    .filter((path) => /^trail-geometry\/[0-9a-f]{2}\/named-trail_[0-9a-f]+\.ndjson$/.test(path))
    .sort();
  if (JSON.stringify(Object.values(trailGeometryPaths).sort()) !==
      JSON.stringify(declaredTrailGeometryPaths) ||
      namedTrails.some((trail) => new Set(trail.segmentIds).size !== trail.segmentIds.length)) {
    throw new TrailRuntimeCatalogError(
      "The active trail geometry contract has extra or duplicate records.",
    );
  }
  return {
    pointer,
    catalog: {
      manifest,
      namedTrails,
      accessPoints: accessPayload.features as AccessPointFeature[],
      summaries: searchIndex.trails as Record<string, TrailSearchSummary>,
      shardPaths,
      partitionPrefixLength: partitioning.prefixLength as number,
      trailGeometryPaths,
    },
  };
}

export async function loadVerifiedTrailGeometry(
  store: TrailArtifactStore,
  catalog: RegionalTrailCatalog,
  trail: NamedTrailRecord,
) {
  const path = catalog.trailGeometryPaths?.[trail.id];
  if (!path || catalog.manifest.schemaVersion !== 2) {
    throw new TrailRuntimeCatalogError(`Trail ${trail.id} has no v2 geometry object.`);
  }
  const metadata = catalog.manifest.artifacts?.[path];
  if (!metadata || !Number.isSafeInteger(metadata.rawBytes) || metadata.rawBytes! < 1 ||
      !validSha256(metadata.sha256)) {
    throw new TrailRuntimeCatalogError(`Trail ${trail.id} has no valid geometry byte contract.`);
  }
  const exceedsOrdinaryTarget = metadata.rawBytes! > MAX_RUNTIME_GEOMETRY_BYTES ||
    metadata.compressedBytes! > MAX_RUNTIME_GEOMETRY_COMPRESSED_BYTES;
  if (exceedsOrdinaryTarget) {
    const exception = (catalog.manifest as V2Manifest).delivery.shardSizeTargets.exceptions
      .find((candidate) => candidate.path === path);
    if (!exception || exception.rawBytes !== metadata.rawBytes ||
        !Number.isSafeInteger(metadata.compressedBytes) ||
        exception.compressedBytes !== metadata.compressedBytes ||
        typeof exception.note !== "string" || !exception.note.trim() ||
        metadata.rawBytes! > MAX_RUNTIME_GEOMETRY_EXCEPTION_BYTES) {
      throw new TrailRuntimeCatalogError(
        `Trail ${trail.id} exceeds the reviewed runtime geometry byte limit.`,
      );
    }
  }
  const located = locateTrailArtifact(catalog.manifest, path);
  const object = await store.get(located.key, { expectedSha256: located.expectedSha256 });
  const bytes = await readVerifiedRuntimeArtifactBytes(object, metadata.rawBytes!, {
    rawBytes: metadata.rawBytes!,
    sha256: metadata.sha256,
  });
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  const segments = await parseSelectedSegmentNdjson(body, new Set(trail.segmentIds));
  if (segments.length !== trail.segmentIds.length ||
      segments.some(({ id }, index) => id !== trail.segmentIds[index])) {
    throw new TrailRuntimeCatalogError(`Trail ${trail.id} geometry is incomplete or out of order.`);
  }
  return segments;
}

type CachedCatalog = {
  expiresAt: number;
  value: Promise<ActiveRegionalTrailCatalog>;
};

const catalogCache = new Map<string, CachedCatalog>();

export function loadCachedActiveRegionalTrailCatalog(store: TrailArtifactStore, regionId: string) {
  const now = Date.now();
  const cached = catalogCache.get(regionId);
  if (cached && cached.expiresAt > now) return cached.value;
  const value = loadActiveRegionalTrailCatalog(store, regionId).catch((error) => {
    if (catalogCache.get(regionId)?.value === value) catalogCache.delete(regionId);
    throw error;
  });
  catalogCache.delete(regionId);
  catalogCache.set(regionId, { expiresAt: now + CATALOG_CACHE_TTL_MS, value });
  while (catalogCache.size > MAX_CACHED_CATALOGS) {
    catalogCache.delete(catalogCache.keys().next().value!);
  }
  return value;
}
