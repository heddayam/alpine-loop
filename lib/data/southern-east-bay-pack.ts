import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  EastBayRegionalParkDistrictEntranceAdapter,
  readOfficialSourceSnapshots,
  refreshOfficialSourceSnapshots,
  type OfficialSourceSet,
} from "./authorities";
import type { auditSqlitePack } from "./audit";
import { compileAuditedPack } from "./audited-pack";
import type { NormalizedAccessEvidence, SourceSnapshot } from "./adapters";
import { areaGeometryBounds, assertValidAreaGeometry, pointInArea, type AreaGeometry } from "./area-geometry";
import type { PackSeed } from "./compiler";
import { applyCuratedAccessRestrictions, readCuratedAccessFile, type CuratedAccessRestriction } from "./curated-access";
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
  OsmPbfTopologyAdapter,
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
import type { NormalizedTopology, PackBuildResult } from "./types";

const PACK_ID = "southern-east-bay";
const COMPILER_VERSION = "southern-east-bay-pack-compiler-v3";
const OFFICIAL_ENTRANCES_SOURCE_ID = "ebrpd-park-entrances";
const CURATED_ACCESS_HASH = "sha256:1401faa586587ad34bc49ab675be621709a2fab90a2c3a04418700c1caf27a88";

export const SOUTHERN_EAST_BAY_SCHEMA_VERSION = "6" as const;
export const SOUTHERN_EAST_BAY_REGION_ROOT = path.resolve("data/regions/southern-east-bay");

/** Optional cosmetic source: refresh and offline reads never include EBRPD line data. */
export const SOUTHERN_EAST_BAY_ENTRANCE_SOURCE_SET: OfficialSourceSet = {
  configRoot: path.join(SOUTHERN_EAST_BAY_REGION_ROOT, "official-sources"),
  filenames: ["ebrpd-park-entrances.json"],
  cacheNamespace: "southern-east-bay-official-access",
};

type BoundaryFeature = {
  type: "Feature";
  geometry: AreaGeometry;
};

export type SouthernEastBayPortalBuildContext = {
  inputNodeCount: number;
  inputWayCount: number;
  trailWayCount: number;
  streetWayCount: number;
  serviceRoadWayCount: number;
  sidewalkWayCount: number;
  portalEvidenceCount: number;
  publishedNodeCount: number;
  publishedWayCount: number;
  strippedNodeCount: number;
  strippedWayCount: number;
};

export type SouthernEastBayPortalReport = {
  restrictionCount: number;
  portalCount: number;
  entranceNameInputCount: number;
  namedOverlayCount: number;
  unmatchedEntranceNameCount: number;
  buildContext: SouthernEastBayPortalBuildContext;
};

export type SouthernEastBayPackBuildOptions = {
  outputRoot: string;
  sourceCacheRoot: string;
  preparationRoot: string;
  refresh: boolean;
};

export type SouthernEastBayPackBuildResult = {
  pack: PackBuildResult;
  portalDerivation: SouthernEastBayPortalReport;
  regionalAudit: Awaited<ReturnType<typeof auditSqlitePack>>;
};

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
}

function parseBoundary(contents: string): BoundaryFeature {
  const input: unknown = JSON.parse(contents);
  assertRecord(input, "Southern East Bay boundary");
  if (input.type !== "Feature") throw new Error("Southern East Bay boundary must be a GeoJSON Feature");
  assertRecord(input.properties, "Southern East Bay boundary properties");
  if (input.properties.id !== PACK_ID || input.properties.boundaryVersion !== "southern-east-bay-boundary-v1") {
    throw new Error("Southern East Bay boundary identity or version does not match the pack");
  }
  return {
    type: "Feature",
    geometry: assertValidAreaGeometry(input.geometry, "Southern East Bay boundary"),
  };
}

function requiredSnapshot(snapshots: readonly SourceSnapshot[], id: string): SourceSnapshot {
  const snapshot = snapshots.find((candidate) => candidate.id === id);
  if (!snapshot) throw new Error(`Missing official snapshot ${id}`);
  return snapshot;
}

function newestRetrieval(snapshots: readonly SourceSnapshot[]): string {
  return snapshots.map(({ retrievedAt }) => retrievedAt).sort().at(-1)!;
}

export function southernEastBayDataVersion(
  boundaryContents: string,
  searchRegionContents: string,
  snapshots: readonly SourceSnapshot[],
  adapterVersions: readonly string[],
  metricVersions: readonly string[],
): string {
  const hash = createHash("sha256");
  hash.update(boundaryContents);
  hash.update(searchRegionContents);
  hash.update(`${COMPILER_VERSION}\n`);
  for (const version of [...adapterVersions].sort()) hash.update(`adapter\0${version}\n`);
  for (const version of [...metricVersions].sort()) hash.update(`metric\0${version}\n`);
  for (const snapshot of [...snapshots].sort((first, second) => first.id.localeCompare(second.id))) {
    hash.update(`${snapshot.id}\0${snapshot.version}\0${snapshot.contentHash}\0${snapshot.license}\n`);
  }
  return `seb-${hash.digest("hex").slice(0, 16)}`;
}

export function createSouthernEastBayPackSeed(input: {
  boundary: AreaGeometry;
  boundaryContents: string;
  searchRegionContents: string;
  snapshots: readonly SourceSnapshot[];
  adapterVersions: readonly string[];
  metricVersions: readonly string[];
}): PackSeed {
  return {
    schemaVersion: SOUTHERN_EAST_BAY_SCHEMA_VERSION,
    id: PACK_ID,
    name: "Southern East Bay",
    dataVersion: southernEastBayDataVersion(
      input.boundaryContents,
      input.searchRegionContents,
      input.snapshots,
      input.adapterVersions,
      input.metricVersions,
    ),
    compilerVersion: COMPILER_VERSION,
    coverage: { bbox: areaGeometryBounds(input.boundary), boundary: input.boundary },
    display: { center: [-121.82, 37.56], zoom: 10.5 },
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
}

function portalInventory(topology: NormalizedTopology, boundary: AreaGeometry) {
  const nodes = new Map(topology.nodes.map((node) => [node.id, node]));
  const byState = { public: 0, unknown: 0, private: 0, closed: 0, prohibited: 0 };
  const corridor = { westernFoothills: 0, sunolOhlone: 0, delValle: 0 };
  let outsideCoverageCount = 0;
  for (const portal of topology.accessPoints) {
    const node = nodes.get(portal.nodeId);
    if (!node) throw new Error(`Portal ${portal.id} references missing node ${portal.nodeId}`);
    if (!pointInArea([node.lon, node.lat], boundary)) {
      outsideCoverageCount += 1;
      continue;
    }
    byState[portal.accessState] += 1;
    if (node.lon <= -121.84) corridor.westernFoothills += 1;
    else if (node.lon <= -121.72) corridor.sunolOhlone += 1;
    else corridor.delValle += 1;
  }
  const inventory = { total: topology.accessPoints.length, byState, corridor, outsideCoverageCount };
  if (inventory.total === 0 || Object.values(corridor).some((count) => count === 0)) {
    throw new Error(`Portal inventory is not regionally useful: ${JSON.stringify(inventory)}`);
  }
  return inventory;
}

async function collectTopology(adapter: OsmPbfTopologyAdapter, snapshot: SourceSnapshot): Promise<NormalizedTopology> {
  const topologies: NormalizedTopology[] = [];
  for await (const topology of adapter.normalize(snapshot)) topologies.push(topology);
  if (topologies.length !== 1) throw new Error(`OSM adapter produced ${topologies.length} topologies`);
  return topologies[0]!;
}

function overlayMatchedEntranceCount(
  topology: NormalizedTopology,
  entranceEvidence: readonly NormalizedAccessEvidence[],
): number {
  const before = new Map(topology.accessPoints.map((portal) => [portal.id, portal]));
  return entranceEvidence.filter((item) => {
    const individuallyOverlaid = applyOfficialEntranceOverlay(topology, [item]);
    return individuallyOverlaid.accessPoints.some((portal) => {
      const original = before.get(portal.id)!;
      return portal.name !== original.name || portal.confidence !== original.confidence
        || portal.sourceRefs.join("\0") !== original.sourceRefs.join("\0");
    });
  }).length;
}

/** Applies the fixed regional flow: restrictions, portals, optional names, then context stripping. */
export function prepareSouthernEastBayPortalTopology(
  topology: NormalizedTopology,
  curatedSourceId: string,
  restrictions: readonly CuratedAccessRestriction[],
  entranceEvidence: readonly NormalizedAccessEvidence[],
): { topology: NormalizedTopology; report: SouthernEastBayPortalReport } {
  const restricted = applyCuratedAccessRestrictions(topology, curatedSourceId, restrictions);
  const portals = deriveTrailheadPortals(restricted);
  const matchedEntranceCount = overlayMatchedEntranceCount(portals, entranceEvidence);
  const named = applyOfficialEntranceOverlay(portals, entranceEvidence);
  const portalBeforeById = new Map(portals.accessPoints.map((portal) => [portal.id, portal]));
  const namedOverlayCount = named.accessPoints.filter((portal) => {
    const original = portalBeforeById.get(portal.id)!;
    return portal.name !== original.name || portal.confidence !== original.confidence
      || portal.sourceRefs.join("\0") !== original.sourceRefs.join("\0");
  }).length;
  const published = stripPortalBuildContext(named);
  const countClass = (edgeClass: "trail" | "street" | "service-road" | "sidewalk") =>
    topology.ways.filter((way) => way.edgeClass === edgeClass).length;
  return {
    topology: published,
    report: {
      restrictionCount: restrictions.length,
      portalCount: portals.accessPoints.length,
      entranceNameInputCount: entranceEvidence.length,
      namedOverlayCount,
      unmatchedEntranceNameCount: entranceEvidence.length - matchedEntranceCount,
      buildContext: {
        inputNodeCount: topology.nodes.length,
        inputWayCount: topology.ways.length,
        trailWayCount: countClass("trail"),
        streetWayCount: countClass("street"),
        serviceRoadWayCount: countClass("service-road"),
        sidewalkWayCount: countClass("sidewalk"),
        portalEvidenceCount: topology.portalEvidence?.length ?? 0,
        publishedNodeCount: published.nodes.length,
        publishedWayCount: published.ways.length,
        strippedNodeCount: topology.nodes.length - published.nodes.length,
        strippedWayCount: topology.ways.length - published.ways.length,
      },
    },
  };
}

export async function buildSouthernEastBayPack(
  options: SouthernEastBayPackBuildOptions,
): Promise<SouthernEastBayPackBuildResult> {
  const regionRoot = SOUTHERN_EAST_BAY_REGION_ROOT;
  const boundaryPath = path.join(regionRoot, "boundary.geojson");
  const searchRegionPath = path.join(regionRoot, "search-regions.json");
  const accessRestrictionsPath = path.join(regionRoot, "access-restrictions.json");
  const [boundaryContents, searchRegionContents, curatedAccess] = await Promise.all([
    readFile(boundaryPath, "utf8"),
    readFile(searchRegionPath, "utf8"),
    readCuratedAccessFile(accessRestrictionsPath, CURATED_ACCESS_HASH),
  ]);
  const boundary = parseBoundary(boundaryContents);
  const [searchRegions, osmConfig, elevationConfig] = await Promise.all([
    readSearchRegionInput(searchRegionPath),
    readOsmSourceConfig(path.join(regionRoot, "osm-source.json")),
    readElevationSourceConfig(path.join(regionRoot, "elevation-source.json")),
  ]);

  await Promise.all([
    validateOsmPrerequisites(),
    validateUvRasterioPrerequisites(),
  ]);
  const [osmSnapshot, dem, officialSnapshots] = await Promise.all([
    options.refresh
      ? refreshPinnedOsmSnapshot(options.sourceCacheRoot, osmConfig).then(({ snapshot }) => snapshot)
      : readPinnedOsmSnapshot(options.sourceCacheRoot, osmConfig),
    options.refresh
      ? refreshPinnedThreeDepCollection(options.sourceCacheRoot, elevationConfig)
      : readPinnedThreeDepCollection(options.sourceCacheRoot, elevationConfig),
    options.refresh
      ? refreshOfficialSourceSnapshots(options.sourceCacheRoot, SOUTHERN_EAST_BAY_ENTRANCE_SOURCE_SET)
      : readOfficialSourceSnapshots(options.sourceCacheRoot, SOUTHERN_EAST_BAY_ENTRANCE_SOURCE_SET),
  ]);

  const entrancesSnapshot = requiredSnapshot(officialSnapshots, OFFICIAL_ENTRANCES_SOURCE_ID);
  const entrancesAdapter = new EastBayRegionalParkDistrictEntranceAdapter();
  await entrancesAdapter.validate(entrancesSnapshot);
  const sourceTopologyAdapter = new OsmPbfTopologyAdapter({
    boundaryPath,
    preparationRoot: path.join(options.preparationRoot, "osm"),
  });
  const namedAreaAdapter = new OsmPbfNamedAreaAdapter({
    boundaryPath,
    preparationRoot: path.join(options.preparationRoot, "osm"),
    namedAreaPreparationRoot: path.join(options.preparationRoot, "osm-named-areas"),
  });

  const entranceEvidence = await entrancesAdapter.normalize(entrancesSnapshot);
  const prepared = prepareSouthernEastBayPortalTopology(
    await collectTopology(sourceTopologyAdapter, osmSnapshot),
    curatedAccess.snapshot.id,
    curatedAccess.restrictions,
    entranceEvidence,
  );
  const inventory = portalInventory(prepared.topology, boundary.geometry);

  const elevationSampler = new UvRasterioThreeDepElevationSampler(dem.collectionPath);
  const buildings = await prepareOsmBuildings(osmSnapshot, {
    boundaryPath,
    preparationRoot: path.join(options.preparationRoot, "osm"),
  });
  const snapshots = [
    osmSnapshot,
    entrancesSnapshot,
    curatedAccess.snapshot,
    dem.snapshot,
  ];
  const adapterVersions = [
    sourceTopologyAdapter.adapterVersion,
    namedAreaAdapter.adapterVersion,
    entrancesAdapter.adapterVersion,
    PORTAL_DERIVATION_VERSION,
  ];
  const metricVersions = [elevationSampler.algorithmVersion, BUILDINGS_ADAPTER_VERSION];
  const seed = createSouthernEastBayPackSeed({
    boundary: boundary.geometry,
    boundaryContents,
    searchRegionContents,
    snapshots,
    adapterVersions,
    metricVersions,
  });
  const { pack, regionalAudit } = await compileAuditedPack({
    outputRoot: options.outputRoot,
    seed,
    builtAt: newestRetrieval(snapshots),
    topology: {
      data: prepared.topology,
      snapshot: osmSnapshot,
    },
    additionalSources: [entrancesSnapshot, curatedAccess.snapshot],
    elevation: { sampler: elevationSampler, snapshot: dem.snapshot },
    buildings,
    namedAreas: { adapter: namedAreaAdapter, snapshot: osmSnapshot },
    searchRegions,
  }, () => ({
    "portal-audit.json": {
      schemaVersion: "1",
      portalDerivation: prepared.report,
      portalInventory: inventory,
    },
  }));

  return { pack, portalDerivation: prepared.report, regionalAudit };
}
