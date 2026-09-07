import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  MONTEREY_REVIEWED_ACCESS_SOURCE_ID,
  MontereyReviewedAccessAdapter,
  montereyReviewedAccessSnapshot,
} from "./authorities";
import type { NormalizedAccessEvidence, SourceSnapshot } from "./adapters";
import { areaGeometryBounds, assertValidAreaGeometry, pointInArea, type AreaGeometry } from "./area-geometry";
import type { auditSqlitePack } from "./audit";
import { compileAuditedPack } from "./audited-pack";
import type { PackSeed } from "./compiler";
import { applyCuratedAccessRestrictions, readCuratedAccessFile } from "./curated-access";
import {
  readElevationSourceConfig,
  readPinnedThreeDepCollection,
  refreshPinnedThreeDepCollection,
  UvRasterioThreeDepElevationSampler,
  validateUvRasterioPrerequisites,
} from "./elevation";
import {
  BUILDINGS_ADAPTER_VERSION,
  prepareOsmBuildings,
  OsmPbfNamedAreaAdapter,
  OSM_TOPOLOGY_ADAPTER_VERSION,
  prepareOsmTopology,
  readOsmSourceConfig,
  readPinnedOsmSnapshot,
  refreshPinnedOsmSnapshot,
  validateOsmPrerequisites,
} from "./osm";
import {
  applyOfficialEntranceOverlay,
  deriveTrailheadPortals,
  PORTAL_DERIVATION_VERSION,
  stripPortalBuildContext,
} from "./portals";
import { readSearchRegionInput } from "./search-regions";
import type { NormalizedAccessPoint, NormalizedTopology, PackBuildResult } from "./types";

const PACK_ID = "monterey-carmel";
export const MONTEREY_CARMEL_PACK_SCHEMA_VERSION = "6" as const;
export const MONTEREY_CARMEL_COMPILER_VERSION = "monterey-carmel-pack-compiler-v2";
const CURATED_ACCESS_HASH = "sha256:b9e5faa29030c6c0ea7c86d1a5f675cd5ae2ca0d8d68928cbf98f80a4b67b2f1";

export const MONTEREY_CARMEL_REGION_ROOT = path.resolve("data/regions/monterey-carmel");

type BoundaryFeature = {
  type: "Feature";
  geometry: AreaGeometry;
};

export type MontereyCarmelPackBuildOptions = {
  outputRoot: string;
  sourceCacheRoot: string;
  preparationRoot: string;
  refresh: boolean;
};

type PortalAccessReport = {
  portals: {
    total: number;
    insideCoverageCount: number;
    outsideCoverageCount: number;
    byAccessState: Record<"public" | "unknown" | "private" | "closed" | "prohibited", number>;
    byConfidence: Record<"high" | "medium" | "low", number>;
    withParkingEvidenceCount: number;
  };
  entranceOverlay: {
    sourceId: string;
    inputCount: number;
    matchedEvidenceCount: number;
    unmatchedExternalIds: string[];
    matchedPortalCount: number;
  };
  restrictions: {
    sourceId: string;
    appliedCount: number;
    targetExternalIds: string[];
  };
  buildContext: {
    inputNodeCount: number;
    publishedNodeCount: number;
    inputWayCount: number;
    publishedWayCount: number;
    trailWayCount: number;
    serviceRoadWayCount: number;
    streetWayCount: number;
    sidewalkWayCount: number;
    portalEvidenceCount: number;
    strippedNodeCount: number;
    strippedWayCount: number;
  };
};

export type MontereyCarmelPackBuildResult = {
  pack: PackBuildResult;
  portalAccess: PortalAccessReport;
  regionalAudit: Awaited<ReturnType<typeof auditSqlitePack>>;
};

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
}

function parseBoundary(contents: string): BoundaryFeature {
  const input: unknown = JSON.parse(contents);
  assertRecord(input, "Monterey–Carmel boundary");
  if (input.type !== "Feature") throw new Error("Monterey–Carmel boundary must be a GeoJSON Feature");
  assertRecord(input.properties, "Monterey–Carmel boundary properties");
  if (input.properties.id !== PACK_ID || input.properties.boundaryVersion !== "monterey-carmel-boundary-v1") {
    throw new Error("Monterey–Carmel boundary identity or version does not match the pack");
  }
  return {
    type: "Feature",
    geometry: assertValidAreaGeometry(input.geometry, "Monterey–Carmel boundary"),
  };
}

function newestRetrieval(snapshots: readonly SourceSnapshot[]): string {
  return snapshots.map(({ retrievedAt }) => retrievedAt).sort().at(-1)!;
}

export function montereyCarmelDataVersion(
  boundaryContents: string,
  searchRegionContents: string,
  snapshots: readonly SourceSnapshot[],
  adapterVersions: readonly string[],
  metricVersions: readonly string[],
): string {
  const hash = createHash("sha256");
  hash.update(boundaryContents);
  hash.update(searchRegionContents);
  hash.update(`${MONTEREY_CARMEL_COMPILER_VERSION}\n`);
  for (const version of [...adapterVersions].sort()) hash.update(`adapter\0${version}\n`);
  for (const version of [...metricVersions].sort()) hash.update(`metric\0${version}\n`);
  for (const snapshot of [...snapshots].sort((first, second) => first.id.localeCompare(second.id))) {
    hash.update(`${snapshot.id}\0${snapshot.version}\0${snapshot.contentHash}\0${snapshot.license}\n`);
  }
  return `mc-${hash.digest("hex").slice(0, 16)}`;
}

/**
 * The committed reviewed file still records its original closure review for
 * provenance, but only entrance records participate in the portal overlay.
 * Exact way restrictions are exclusively sourced from access-restrictions.json.
 */
export function montereyReviewedEntranceEvidence(
  evidence: readonly NormalizedAccessEvidence[],
): NormalizedAccessEvidence[] {
  const entrances: NormalizedAccessEvidence[] = [];
  for (const item of evidence) {
    if (/^entrance\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item.externalId)) {
      if (item.accessState !== "public" || item.confidence !== "medium") {
        throw new Error(`Reviewed entrance evidence ${item.externalId} must be public with medium confidence`);
      }
      entrances.push(item);
      continue;
    }
    if (/^way\/[1-9]\d*$/.test(item.externalId)) {
      if (item.accessState !== "closed" || item.confidence !== "high") {
        throw new Error(`Reviewed closure provenance ${item.externalId} must be closed with high confidence`);
      }
      continue;
    }
    throw new Error(`Reviewed access evidence has unsupported target ${item.externalId}`);
  }
  return entrances.sort((first, second) => first.externalId.localeCompare(second.externalId));
}

function newlyCarriesSource(
  before: readonly NormalizedAccessPoint[],
  after: readonly NormalizedAccessPoint[],
  sourceId: string,
): boolean {
  const beforeById = new Map(before.map((portal) => [portal.id, portal]));
  return after.some((portal) =>
    portal.sourceRefs.includes(sourceId) && !beforeById.get(portal.id)?.sourceRefs.includes(sourceId));
}

function entranceOverlayReport(
  topology: NormalizedTopology,
  evidence: readonly NormalizedAccessEvidence[],
  overlaid: NormalizedTopology,
): PortalAccessReport["entranceOverlay"] {
  const unmatchedExternalIds: string[] = [];
  for (const item of evidence) {
    const singlyOverlaid = applyOfficialEntranceOverlay(topology, [item]);
    if (!newlyCarriesSource(topology.accessPoints, singlyOverlaid.accessPoints, item.sourceId)) {
      unmatchedExternalIds.push(item.externalId);
    }
  }
  const matchedPortalCount = overlaid.accessPoints.filter((portal) =>
    evidence.some(({ sourceId }) => portal.sourceRefs.includes(sourceId)))
    .length;
  return {
    sourceId: MONTEREY_REVIEWED_ACCESS_SOURCE_ID,
    inputCount: evidence.length,
    matchedEvidenceCount: evidence.length - unmatchedExternalIds.length,
    unmatchedExternalIds: unmatchedExternalIds.sort(),
    matchedPortalCount,
  };
}

function portalInventory(topology: NormalizedTopology, boundary: AreaGeometry): PortalAccessReport["portals"] {
  const nodes = new Map(topology.nodes.map((node) => [node.id, node]));
  const byAccessState = { public: 0, unknown: 0, private: 0, closed: 0, prohibited: 0 };
  const byConfidence = { high: 0, medium: 0, low: 0 };
  let insideCoverageCount = 0;
  let outsideCoverageCount = 0;
  let withParkingEvidenceCount = 0;
  for (const portal of topology.accessPoints) {
    const node = nodes.get(portal.nodeId);
    if (!node) throw new Error(`Portal ${portal.id} references missing node ${portal.nodeId}`);
    if (pointInArea([node.lon, node.lat], boundary)) insideCoverageCount += 1;
    else outsideCoverageCount += 1;
    byAccessState[portal.accessState] += 1;
    byConfidence[portal.confidence] += 1;
    if (portal.parkingEvidence) withParkingEvidenceCount += 1;
  }
  if (topology.accessPoints.length === 0 || insideCoverageCount === 0) {
    throw new Error("Portal derivation produced no in-coverage Monterey–Carmel access points");
  }
  return {
    total: topology.accessPoints.length,
    insideCoverageCount,
    outsideCoverageCount,
    byAccessState,
    byConfidence,
    withParkingEvidenceCount,
  };
}

function buildContextReport(
  input: NormalizedTopology,
  published: NormalizedTopology,
): PortalAccessReport["buildContext"] {
  const wayCount = (edgeClass: "trail" | "service-road" | "street" | "sidewalk") =>
    input.ways.filter((way) => way.edgeClass === edgeClass).length;
  return {
    inputNodeCount: input.nodes.length,
    publishedNodeCount: published.nodes.length,
    inputWayCount: input.ways.length,
    publishedWayCount: published.ways.length,
    trailWayCount: wayCount("trail"),
    serviceRoadWayCount: wayCount("service-road"),
    streetWayCount: wayCount("street"),
    sidewalkWayCount: wayCount("sidewalk"),
    portalEvidenceCount: input.portalEvidence?.length ?? 0,
    strippedNodeCount: input.nodes.length - published.nodes.length,
    strippedWayCount: input.ways.length - published.ways.length,
  };
}

export async function buildMontereyCarmelPack(
  options: MontereyCarmelPackBuildOptions,
): Promise<MontereyCarmelPackBuildResult> {
  const regionRoot = MONTEREY_CARMEL_REGION_ROOT;
  const boundaryPath = path.join(regionRoot, "boundary.geojson");
  const searchRegionPath = path.join(regionRoot, "search-regions.json");
  const restrictionPath = path.join(regionRoot, "access-restrictions.json");
  const [boundaryContents, searchRegionContents, curatedAccess] = await Promise.all([
    readFile(boundaryPath, "utf8"),
    readFile(searchRegionPath, "utf8"),
    readCuratedAccessFile(restrictionPath, CURATED_ACCESS_HASH),
  ]);
  const boundary = parseBoundary(boundaryContents);
  const reviewedSnapshot = montereyReviewedAccessSnapshot(regionRoot);
  if (reviewedSnapshot.id !== MONTEREY_REVIEWED_ACCESS_SOURCE_ID) {
    throw new Error(`Reviewed access snapshot has unexpected source ID ${reviewedSnapshot.id}`);
  }
  const reviewedAdapter = new MontereyReviewedAccessAdapter();
  const [searchRegions, osmConfig, elevationConfig] = await Promise.all([
    readSearchRegionInput(searchRegionPath),
    readOsmSourceConfig(path.join(regionRoot, "osm-source.json")),
    readElevationSourceConfig(path.join(regionRoot, "elevation-source.json")),
  ]);

  await Promise.all([
    validateOsmPrerequisites(),
    validateUvRasterioPrerequisites(),
    reviewedAdapter.validate(reviewedSnapshot),
  ]);
  const [osmSnapshot, dem] = await Promise.all([
    options.refresh
      ? refreshPinnedOsmSnapshot(options.sourceCacheRoot, osmConfig).then(({ snapshot }) => snapshot)
      : readPinnedOsmSnapshot(options.sourceCacheRoot, osmConfig),
    options.refresh
      ? refreshPinnedThreeDepCollection(options.sourceCacheRoot, elevationConfig)
      : readPinnedThreeDepCollection(options.sourceCacheRoot, elevationConfig),
  ]);

  const namedAreaAdapter = new OsmPbfNamedAreaAdapter({
    boundaryPath,
    preparationRoot: path.join(options.preparationRoot, "osm"),
    namedAreaPreparationRoot: path.join(options.preparationRoot, "osm-named-areas"),
  });
  const classifiedTopology = await prepareOsmTopology(osmSnapshot, {
    boundaryPath,
    preparationRoot: path.join(options.preparationRoot, "osm"),
  });
  const restrictedTopology = applyCuratedAccessRestrictions(
    classifiedTopology,
    curatedAccess.snapshot.id,
    curatedAccess.restrictions,
  );
  const reviewedEntrances = montereyReviewedEntranceEvidence(
    await reviewedAdapter.normalize(reviewedSnapshot),
  );
  const derivedTopology = deriveTrailheadPortals(restrictedTopology);
  const overlaidTopology = applyOfficialEntranceOverlay(derivedTopology, reviewedEntrances);
  const publishedTopology = stripPortalBuildContext(overlaidTopology);
  const portalAccess: PortalAccessReport = {
    portals: portalInventory(overlaidTopology, boundary.geometry),
    entranceOverlay: entranceOverlayReport(derivedTopology, reviewedEntrances, overlaidTopology),
    restrictions: {
      sourceId: curatedAccess.snapshot.id,
      appliedCount: curatedAccess.restrictions.length,
      targetExternalIds: curatedAccess.restrictions.map(({ externalId }) => externalId),
    },
    buildContext: buildContextReport(restrictedTopology, publishedTopology),
  };

  const elevationSampler = new UvRasterioThreeDepElevationSampler(dem.collectionPath);
  const buildings = await prepareOsmBuildings(osmSnapshot, {
    boundaryPath,
    preparationRoot: path.join(options.preparationRoot, "osm"),
  });
  const snapshots = [
    osmSnapshot,
    curatedAccess.snapshot,
    reviewedSnapshot,
    dem.snapshot,
  ];
  const adapterVersions = [
    OSM_TOPOLOGY_ADAPTER_VERSION,
    namedAreaAdapter.adapterVersion,
    reviewedAdapter.adapterVersion,
    PORTAL_DERIVATION_VERSION,
  ];
  const metricVersions = [elevationSampler.algorithmVersion, BUILDINGS_ADAPTER_VERSION];
  const seed: PackSeed = {
    schemaVersion: MONTEREY_CARMEL_PACK_SCHEMA_VERSION,
    id: PACK_ID,
    name: "Monterey–Carmel",
    dataVersion: montereyCarmelDataVersion(
      boundaryContents,
      searchRegionContents,
      snapshots,
      adapterVersions,
      metricVersions,
    ),
    compilerVersion: MONTEREY_CARMEL_COMPILER_VERSION,
    coverage: { bbox: areaGeometryBounds(boundary.geometry), boundary: boundary.geometry },
    display: { center: [-121.83, 36.52], zoom: 10.5 },
    capabilities: {
      elevation: true,
      officialAccess: true,
      namedAreas: true,
      closedRouteTopology: true,
      batchSearchRegions: true,
      elevationProfiles: true,
      portalAccessPoints: true,
    },
    closedRouteTopology: {
      runtimeMode: "reachable-graph-fallback",
      algorithmVersion: "closed-route-safe-pruning-v1",
      policyVersion: "penalized-closed-route-search-v1",
      profiles: ["known", "inclusive"],
    },
    fieldConfidence: { topology: "high", access: "medium", elevation: "high" },
  };
  const { pack, regionalAudit } = await compileAuditedPack({
    outputRoot: options.outputRoot,
    seed,
    builtAt: newestRetrieval(snapshots),
    topology: {
      data: publishedTopology,
      snapshot: osmSnapshot,
    },
    additionalSources: [curatedAccess.snapshot, reviewedSnapshot],
    elevation: { sampler: elevationSampler, snapshot: dem.snapshot },
    buildings,
    namedAreas: { adapter: namedAreaAdapter, snapshot: osmSnapshot },
    searchRegions,
  }, () => ({ "portal-access-audit.json": { schemaVersion: "1", ...portalAccess } }));

  return { pack, portalAccess, regionalAudit };
}
