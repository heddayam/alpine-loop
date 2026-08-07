import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  EAST_BAY_CURRENT_CLOSURES_AUTHORITY,
  EAST_BAY_CURRENT_CLOSURES_DATASET,
  EAST_BAY_CURRENT_CLOSURES_RETRIEVED_AT,
  EAST_BAY_CURRENT_CLOSURES_SOURCE_ID,
  EAST_BAY_CURRENT_CLOSURES_SOURCE_URL,
  EAST_BAY_CURRENT_CLOSURES_VERSION,
  EastBayRegionalParkDistrictAccessAdapter,
  EastBayRegionalParkDistrictEntranceAdapter,
  EastBayCurrentClosuresAdapter,
  matchOfficialAccessToOsmWithReport,
  readOfficialSourceSnapshots,
  refreshOfficialSourceSnapshots,
  type OfficialAccessJoin,
  type OfficialAccessJoinFeature,
  type OfficialSourceSet,
} from "./authorities";
import { assertPackAuditPassed, auditOfficialAccessJoins, auditSqlitePack } from "./audit";
import type { NormalizedAccessEvidence, SourceSnapshot } from "./adapters";
import { applyOfficialWayEvidenceToAccessPoints } from "./access-point-evidence";
import { snapAccessPointsToTopology } from "./access-point-snap";
import { areaGeometryBounds, assertValidAreaGeometry, pointInArea, type AreaGeometry } from "./area-geometry";
import { compilePack, type PackSeed } from "./compiler";
import {
  readElevationSourceConfig,
  readPinnedThreeDepCollection,
  refreshPinnedThreeDepCollection,
  UvRasterioThreeDepElevationSampler,
  validateUvRasterioPrerequisites,
} from "./elevation";
import { sha256File } from "./file-source";
import { addOfficialAccessPointsToTopology, officialAccessPointId } from "./official-access-points";
import {
  OsmPbfNamedAreaAdapter,
  OsmPbfTopologyAdapter,
  readOsmSourceConfig,
  readPinnedOsmSnapshot,
  refreshPinnedOsmSnapshot,
  validateOsmPrerequisites,
} from "./osm";
import {
  readPinnedPopulationCollection,
  readPopulationSourceConfig,
  refreshPinnedPopulationCollection,
  UvRasterioPopulationSampler,
  validateUvRasterioPopulationPrerequisites,
} from "./population";
import { PreparedOfficialAccessAdapter } from "./prepared-official-access-adapter";
import { PreparedTopologyAdapter } from "./prepared-topology-adapter";
import { POPULATION_RADIUS_M } from "./remoteness";
import { readSearchRegionInput } from "./search-regions";
import type { NormalizedTopology, PackBuildResult } from "./types";

const PACK_ID = "southern-east-bay";
const COMPILER_VERSION = "southern-east-bay-pack-compiler-v2";
const ACCESS_SNAP_DISTANCE_M = 200;
const OFFICIAL_ROADS_SOURCE_ID = "ebrpd-roads-and-trails-access";
const OFFICIAL_ENTRANCES_SOURCE_ID = "ebrpd-park-entrances";
const CURRENT_CLOSURES_LICENSE = "Human-reviewed facts for local evaluation; derivative redistribution requires review";

export const SOUTHERN_EAST_BAY_REGION_ROOT = path.resolve("data/regions/southern-east-bay");

export const SOUTHERN_EAST_BAY_OFFICIAL_SOURCE_SET: OfficialSourceSet = {
  configRoot: path.join(SOUTHERN_EAST_BAY_REGION_ROOT, "official-sources"),
  filenames: ["ebrpd-roads-and-trails.json", "ebrpd-park-entrances.json"],
  cacheNamespace: "southern-east-bay-official-access",
};

type BoundaryFeature = {
  type: "Feature";
  geometry: AreaGeometry;
};

export type SouthernEastBayPackBuildOptions = {
  outputRoot: string;
  sourceCacheRoot: string;
  preparationRoot: string;
  refresh: boolean;
};

export type SouthernEastBayPackBuildResult = {
  pack: PackBuildResult;
  accessNormalization: {
    snapDistanceM: number;
    osmSnappedCount: number;
    osmAlreadyConnectedCount: number;
    osmDeduplicatedCount: number;
    osmRejectedAccessPointIds: string[];
    officialEntranceInputCount: number;
    officialEntranceAddedCount: number;
    officialEntranceRejectedCount: number;
    officialEntranceDeduplicatedCount: number;
    officialEntranceRejectedAccessPointIds: string[];
    linePromotedPublicCount: number;
    lineRestrictedCount: number;
    lineConflictCount: number;
    currentClosureCount: number;
  };
  officialAccess: {
    entrances: {
      sourceId: string;
      inputCount: number;
      addedCount: number;
      rejectedCount: number;
      deduplicatedCount: number;
    };
    lineMatch: {
      sourceId: string;
      authorityFeatureCount: number;
      appliedJoinCount: number;
      ambiguousOsmWayCount: number;
      unmatchedAuthorityFeatureCount: number;
      rejectedGeometryFeatureCount: number;
    };
    currentClosures: {
      sourceId: string;
      exactJoinCount: number;
      suppressedLineJoinCount: number;
      targetExternalIds: string[];
    };
  };
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

function dataVersion(
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

function accessInventory(topology: NormalizedTopology, boundary: AreaGeometry) {
  const nodes = new Map(topology.nodes.map((node) => [node.id, node]));
  const byKind = { trailhead: 0, parking: 0 };
  const byState = { public: 0, unknown: 0, private: 0, closed: 0, prohibited: 0 };
  const corridor = {
    westernFoothills: 0,
    sunolOhlone: 0,
    delValle: 0,
  };
  let outsideCoverageCount = 0;
  for (const accessPoint of topology.accessPoints) {
    const node = nodes.get(accessPoint.nodeId);
    if (!node) throw new Error(`Access point ${accessPoint.id} references missing node ${accessPoint.nodeId}`);
    if (!pointInArea([node.lon, node.lat], boundary)) {
      outsideCoverageCount += 1;
      continue;
    }
    byKind[accessPoint.kind] += 1;
    byState[accessPoint.accessState] += 1;
    if (node.lon <= -121.84) corridor.westernFoothills += 1;
    else if (node.lon <= -121.72) corridor.sunolOhlone += 1;
    else corridor.delValle += 1;
  }
  const total = byKind.trailhead + byKind.parking;
  const inventory = { total, byKind, byState, corridor, outsideCoverageCount };
  if (total < 1_000 || byKind.trailhead < 10 || byState.public < 10
    || corridor.westernFoothills < 1 || corridor.sunolOhlone < 1 || corridor.delValle < 1) {
    throw new Error(`Access inventory is not regionally useful: ${JSON.stringify(inventory)}`);
  }
  return inventory;
}

async function collectTopology(adapter: OsmPbfTopologyAdapter, snapshot: SourceSnapshot): Promise<NormalizedTopology> {
  const topologies: NormalizedTopology[] = [];
  for await (const topology of adapter.normalize(snapshot)) topologies.push(topology);
  if (topologies.length !== 1) throw new Error(`OSM adapter produced ${topologies.length} topologies`);
  return topologies[0]!;
}

function joinOrder(first: OfficialAccessJoin, second: OfficialAccessJoin): number {
  return first.sourceId.localeCompare(second.sourceId)
    || first.authorityFeatureId.localeCompare(second.authorityFeatureId)
    || first.targetExternalId.localeCompare(second.targetExternalId);
}

export function prioritizeCurrentClosureJoins(
  lineJoins: readonly OfficialAccessJoin[],
  closureJoins: readonly OfficialAccessJoin[],
): {
  lineJoins: OfficialAccessJoin[];
  combinedJoins: OfficialAccessJoin[];
  suppressedLineJoinCount: number;
} {
  const closureTargets = new Set(closureJoins.map(({ targetExternalId }) => targetExternalId));
  const retainedLineJoins = lineJoins.filter(({ targetExternalId }) => !closureTargets.has(targetExternalId));
  return {
    lineJoins: retainedLineJoins,
    combinedJoins: [...retainedLineJoins, ...closureJoins].sort(joinOrder),
    suppressedLineJoinCount: lineJoins.length - retainedLineJoins.length,
  };
}

function exactCurrentClosureJoins(
  topology: NormalizedTopology,
  evidence: readonly NormalizedAccessEvidence[],
): { features: OfficialAccessJoinFeature[]; joins: OfficialAccessJoin[] } {
  const ways = new Map(topology.ways.map((way) => [way.externalId, way]));
  const features: OfficialAccessJoinFeature[] = [];
  const joins: OfficialAccessJoin[] = [];
  for (const item of evidence) {
    const way = ways.get(item.externalId);
    if (!way) throw new Error(`Current closure targets missing pinned topology way ${item.externalId}`);
    if (item.accessState !== "closed") throw new Error(`Current closure ${item.externalId} is not closed evidence`);
    features.push({
      sourceId: item.sourceId,
      authorityFeatureId: item.externalId,
      geometry: { type: "LineString", coordinates: way.coordinates.map((coordinate) => [...coordinate]) },
      evidence: item,
    });
    joins.push({
      sourceId: item.sourceId,
      authorityFeatureId: item.externalId,
      targetExternalId: item.externalId,
      matchMethod: "spatial-intersection",
      distanceM: 0,
      evidence: item,
    });
  }
  return { features, joins: joins.sort(joinOrder) };
}

export async function buildSouthernEastBayPack(
  options: SouthernEastBayPackBuildOptions,
): Promise<SouthernEastBayPackBuildResult> {
  const regionRoot = SOUTHERN_EAST_BAY_REGION_ROOT;
  const boundaryPath = path.join(regionRoot, "boundary.geojson");
  const searchRegionPath = path.join(regionRoot, "search-regions.json");
  const currentClosuresPath = path.join(regionRoot, "current-closures.json");
  const [boundaryContents, searchRegionContents, currentClosuresContentHash] = await Promise.all([
    readFile(boundaryPath, "utf8"),
    readFile(searchRegionPath, "utf8"),
    sha256File(currentClosuresPath),
  ]);
  const boundary = parseBoundary(boundaryContents);
  const currentClosuresSnapshot: SourceSnapshot = {
    id: EAST_BAY_CURRENT_CLOSURES_SOURCE_ID,
    authority: EAST_BAY_CURRENT_CLOSURES_AUTHORITY,
    dataset: EAST_BAY_CURRENT_CLOSURES_DATASET,
    version: EAST_BAY_CURRENT_CLOSURES_VERSION,
    retrievedAt: EAST_BAY_CURRENT_CLOSURES_RETRIEVED_AT,
    url: EAST_BAY_CURRENT_CLOSURES_SOURCE_URL,
    license: CURRENT_CLOSURES_LICENSE,
    contentHash: currentClosuresContentHash,
    localPath: currentClosuresPath,
  };
  const currentClosuresAdapter = new EastBayCurrentClosuresAdapter();
  const [searchRegions, osmConfig, elevationConfig, populationConfig] = await Promise.all([
    readSearchRegionInput(searchRegionPath),
    readOsmSourceConfig(path.join(regionRoot, "osm-source.json")),
    readElevationSourceConfig(path.join(regionRoot, "elevation-source.json")),
    readPopulationSourceConfig(path.join(regionRoot, "population-source.json")),
  ]);

  await Promise.all([
    validateOsmPrerequisites(),
    validateUvRasterioPrerequisites(),
    validateUvRasterioPopulationPrerequisites(),
    currentClosuresAdapter.validate(currentClosuresSnapshot),
  ]);
  const [osmSnapshot, dem, population, officialSnapshots] = await Promise.all([
    options.refresh
      ? refreshPinnedOsmSnapshot(options.sourceCacheRoot, osmConfig).then(({ snapshot }) => snapshot)
      : readPinnedOsmSnapshot(options.sourceCacheRoot, osmConfig),
    options.refresh
      ? refreshPinnedThreeDepCollection(options.sourceCacheRoot, elevationConfig)
      : readPinnedThreeDepCollection(options.sourceCacheRoot, elevationConfig),
    options.refresh
      ? refreshPinnedPopulationCollection(options.sourceCacheRoot, populationConfig)
      : readPinnedPopulationCollection(options.sourceCacheRoot, populationConfig),
    options.refresh
      ? refreshOfficialSourceSnapshots(options.sourceCacheRoot, SOUTHERN_EAST_BAY_OFFICIAL_SOURCE_SET)
      : readOfficialSourceSnapshots(options.sourceCacheRoot, SOUTHERN_EAST_BAY_OFFICIAL_SOURCE_SET),
  ]);

  const roadsSnapshot = requiredSnapshot(officialSnapshots, OFFICIAL_ROADS_SOURCE_ID);
  const entrancesSnapshot = requiredSnapshot(officialSnapshots, OFFICIAL_ENTRANCES_SOURCE_ID);
  const roadsAdapter = new EastBayRegionalParkDistrictAccessAdapter();
  const entrancesAdapter = new EastBayRegionalParkDistrictEntranceAdapter();
  const sourceTopologyAdapter = new OsmPbfTopologyAdapter({
    boundaryPath,
    preparationRoot: path.join(options.preparationRoot, "osm"),
  });
  const namedAreaAdapter = new OsmPbfNamedAreaAdapter({
    boundaryPath,
    preparationRoot: path.join(options.preparationRoot, "osm"),
    namedAreaPreparationRoot: path.join(options.preparationRoot, "osm-named-areas"),
  });

  const osmAccess = snapAccessPointsToTopology(
    await collectTopology(sourceTopologyAdapter, osmSnapshot),
    ACCESS_SNAP_DISTANCE_M,
  );
  const entranceEvidence = await entrancesAdapter.normalize(entrancesSnapshot);
  const entrances = addOfficialAccessPointsToTopology(
    osmAccess.topology,
    entranceEvidence,
    ACCESS_SNAP_DISTANCE_M,
  );
  const acceptedEntranceIds = new Set(entrances.topology.accessPoints.map(({ id }) => id));
  const acceptedEntranceEvidence = entranceEvidence.filter((evidence) =>
    acceptedEntranceIds.has(officialAccessPointId(evidence)));

  // Only the EBRPD road/trail polylines are spatially matched to OSM ways.
  // Entrance points are handled above by the conservative node snap and never
  // produce connector edges.
  const lineNormalization = await roadsAdapter.normalizeForJoinWithReport(roadsSnapshot);
  const lineMatch = matchOfficialAccessToOsmWithReport(entrances.topology, lineNormalization.features);
  const currentClosureEvidence = await currentClosuresAdapter.normalize(currentClosuresSnapshot);
  const currentClosureMatches = exactCurrentClosureJoins(entrances.topology, currentClosureEvidence);
  // A current reviewed closure supersedes the older EBRPD permission for the
  // same way. Removing that stale permission lets the existing official-
  // restriction reconciliation close both the way and unknown trailheads.
  const prioritizedJoins = prioritizeCurrentClosureJoins(lineMatch.joins, currentClosureMatches.joins);
  const accessEvidence = applyOfficialWayEvidenceToAccessPoints(entrances.topology, prioritizedJoins.combinedJoins);
  const inventory = accessInventory(accessEvidence.topology, boundary.geometry);
  const officialJoinAudit = auditOfficialAccessJoins(
    [...lineNormalization.features, ...currentClosureMatches.features],
    [...lineMatch.joins, ...currentClosureMatches.joins],
    new Set(entrances.topology.ways.map(({ externalId }) => externalId)),
  );
  if (officialJoinAudit.errors.length) {
    throw new Error(`Official access join audit failed:\n${officialJoinAudit.errors.join("\n")}`);
  }

  const elevationSampler = new UvRasterioThreeDepElevationSampler(dem.collectionPath);
  const populationSampler = new UvRasterioPopulationSampler(population.collectionPath, POPULATION_RADIUS_M);
  await populationSampler.verify(population.collection);
  const snapshots = [
    osmSnapshot,
    roadsSnapshot,
    entrancesSnapshot,
    currentClosuresSnapshot,
    dem.snapshot,
    population.snapshot,
  ];
  const adapterVersions = [
    sourceTopologyAdapter.adapterVersion,
    namedAreaAdapter.adapterVersion,
    roadsAdapter.adapterVersion,
    entrancesAdapter.adapterVersion,
    currentClosuresAdapter.adapterVersion,
  ];
  const metricVersions = [elevationSampler.algorithmVersion, populationSampler.algorithmVersion];
  const seed: PackSeed = {
    schemaVersion: "5",
    id: PACK_ID,
    name: "Southern East Bay",
    dataVersion: dataVersion(
      boundaryContents,
      searchRegionContents,
      snapshots,
      adapterVersions,
      metricVersions,
    ),
    compilerVersion: COMPILER_VERSION,
    coverage: { bbox: areaGeometryBounds(boundary.geometry), boundary: boundary.geometry },
    display: { center: [-121.82, 37.56], zoom: 10.5 },
    capabilities: {
      elevation: true,
      officialAccess: true,
      namedAreas: true,
      closedRouteTopology: true,
      batchSearchRegions: true,
      elevationProfiles: true,
    },
    closedRouteTopology: {
      runtimeMode: "reachable-graph-fallback",
      algorithmVersion: "closed-route-safe-pruning-v1",
      policyVersion: "penalized-closed-route-search-v1",
      profiles: ["known", "inclusive"],
    },
    fieldConfidence: { topology: "high", access: "medium", elevation: "high" },
  };
  const pack = await compilePack({
    outputRoot: options.outputRoot,
    seed,
    builtAt: newestRetrieval(snapshots),
    topology: {
      adapter: new PreparedTopologyAdapter(sourceTopologyAdapter, accessEvidence.topology),
      snapshot: osmSnapshot,
    },
    officialAccess: {
      adapter: new PreparedOfficialAccessAdapter(
        roadsAdapter,
        prioritizedJoins.lineJoins.map(({ evidence }) => evidence),
      ),
      snapshot: roadsSnapshot,
    },
    additionalOfficialAccess: [
      {
        adapter: new PreparedOfficialAccessAdapter(entrancesAdapter, acceptedEntranceEvidence),
        snapshot: entrancesSnapshot,
      },
      {
        adapter: new PreparedOfficialAccessAdapter(currentClosuresAdapter, currentClosureEvidence),
        snapshot: currentClosuresSnapshot,
      },
    ],
    elevation: { sampler: elevationSampler, snapshot: dem.snapshot },
    population: { sampler: populationSampler, snapshot: population.snapshot },
    namedAreas: { adapter: namedAreaAdapter, snapshot: osmSnapshot },
    searchRegions,
  });

  const regionalAudit = await auditSqlitePack({
    databasePath: pack.databasePath,
    manifestPath: pack.manifestPath,
    auditPath: pack.auditPath,
  });
  assertPackAuditPassed(regionalAudit);
  const accessNormalization = {
    snapDistanceM: ACCESS_SNAP_DISTANCE_M,
    osmSnappedCount: osmAccess.snappedCount,
    osmAlreadyConnectedCount: osmAccess.alreadyConnectedCount,
    osmDeduplicatedCount: osmAccess.deduplicatedCount,
    osmRejectedAccessPointIds: osmAccess.rejectedAccessPointIds,
    officialEntranceInputCount: entranceEvidence.length,
    officialEntranceAddedCount: entrances.addedCount,
    officialEntranceRejectedCount: entrances.rejectedCount,
    officialEntranceDeduplicatedCount: entrances.deduplicatedCount,
    officialEntranceRejectedAccessPointIds: entrances.rejectedAccessPointIds,
    linePromotedPublicCount: accessEvidence.promotedPublicCount,
    lineRestrictedCount: accessEvidence.restrictedCount,
    lineConflictCount: accessEvidence.conflictedCount,
    currentClosureCount: currentClosureMatches.joins.length,
  };
  const officialAccess = {
    entrances: {
      sourceId: entrancesSnapshot.id,
      inputCount: entranceEvidence.length,
      addedCount: entrances.addedCount,
      rejectedCount: entrances.rejectedCount,
      deduplicatedCount: entrances.deduplicatedCount,
    },
    lineMatch: {
      sourceId: roadsSnapshot.id,
      authorityFeatureCount: lineNormalization.features.length,
      appliedJoinCount: lineMatch.joins.length,
      ambiguousOsmWayCount: lineMatch.ambiguousOsmWayCount,
      unmatchedAuthorityFeatureCount: lineMatch.unmatchedAuthorityFeatureCount,
      rejectedGeometryFeatureCount: lineNormalization.rejectedGeometryFeatureIds.length,
    },
    currentClosures: {
      sourceId: currentClosuresSnapshot.id,
      exactJoinCount: currentClosureMatches.joins.length,
      suppressedLineJoinCount: prioritizedJoins.suppressedLineJoinCount,
      targetExternalIds: currentClosureMatches.joins.map(({ targetExternalId }) => targetExternalId),
    },
  };
  await writeFile(
    path.join(pack.packDirectory, "regional-audit.json"),
    `${JSON.stringify(regionalAudit, null, 2)}\n`,
  );
  await writeFile(path.join(pack.packDirectory, "access-join-audit.json"), `${JSON.stringify({
    schemaVersion: "1",
    accessNormalization,
    accessInventory: inventory,
    officialAccess,
    officialJoinAudit,
    lineMatchReport: {
      sourceId: roadsSnapshot.id,
      rejectedGeometryFeatureIds: lineNormalization.rejectedGeometryFeatureIds,
      ambiguousOsmWayCount: lineMatch.ambiguousOsmWayCount,
      unmatchedAuthorityFeatureCount: lineMatch.unmatchedAuthorityFeatureCount,
    },
    joins: [...lineMatch.joins, ...currentClosureMatches.joins].sort(joinOrder),
  }, null, 2)}\n`);

  return { pack, accessNormalization, officialAccess, regionalAudit };
}
