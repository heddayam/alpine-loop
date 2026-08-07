import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  MONTEREY_OFFICIAL_SOURCE_SET,
  MONTEREY_REVIEWED_ACCESS_SOURCE_ID,
  MontereyLosPadresTrailsAdapter,
  MontereyReviewedAccessAdapter,
  matchOfficialAccessToOsmWithReport,
  montereyReviewedAccessSnapshot,
  readOfficialSourceSnapshots,
  refreshOfficialSourceSnapshots,
  type OfficialAccessJoin,
  type OfficialAccessJoinFeature,
} from "./authorities";
import { applyOfficialWayEvidenceToAccessPoints } from "./access-point-evidence";
import { snapAccessPointsToTopology } from "./access-point-snap";
import type { NormalizedAccessEvidence, SourceSnapshot } from "./adapters";
import { areaGeometryBounds, assertValidAreaGeometry, pointInArea, type AreaGeometry } from "./area-geometry";
import { assertPackAuditPassed, auditOfficialAccessJoins, auditSqlitePack } from "./audit";
import { compilePack, type PackSeed } from "./compiler";
import {
  readElevationSourceConfig,
  readPinnedThreeDepCollection,
  refreshPinnedThreeDepCollection,
  UvRasterioThreeDepElevationSampler,
  validateUvRasterioPrerequisites,
} from "./elevation";
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

const PACK_ID = "monterey-carmel";
const COMPILER_VERSION = "monterey-carmel-pack-compiler-v1";
const ACCESS_SNAP_DISTANCE_M = 200;
const OFFICIAL_TRAILS_SOURCE_ID = "usfs-los-padres-northern-connector-trails";

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

export type MontereyCarmelPackBuildResult = {
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

function requiredSnapshot(snapshots: readonly SourceSnapshot[], id: string): SourceSnapshot {
  const snapshot = snapshots.find((candidate) => candidate.id === id);
  if (!snapshot) throw new Error(`Missing official snapshot ${id}`);
  return snapshot;
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
  hash.update(`${COMPILER_VERSION}\n`);
  for (const version of [...adapterVersions].sort()) hash.update(`adapter\0${version}\n`);
  for (const version of [...metricVersions].sort()) hash.update(`metric\0${version}\n`);
  for (const snapshot of [...snapshots].sort((first, second) => first.id.localeCompare(second.id))) {
    hash.update(`${snapshot.id}\0${snapshot.version}\0${snapshot.contentHash}\0${snapshot.license}\n`);
  }
  return `mc-${hash.digest("hex").slice(0, 16)}`;
}

function accessInventory(topology: NormalizedTopology, boundary: AreaGeometry) {
  const nodes = new Map(topology.nodes.map((node) => [node.id, node]));
  const byKind = { trailhead: 0, parking: 0 };
  const byState = { public: 0, unknown: 0, private: 0, closed: 0, prohibited: 0 };
  const cluster = {
    northernFortOrd: 0,
    carmelValley: 0,
    coastal: 0,
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
    if (node.lat >= 36.58) cluster.northernFortOrd += 1;
    else if (node.lon <= -121.84) cluster.coastal += 1;
    else cluster.carmelValley += 1;
  }
  const total = byKind.trailhead + byKind.parking;
  const inventory = { total, byKind, byState, cluster, outsideCoverageCount };
  if (total < 1_000 || byKind.trailhead < 10 || byState.public < 1
    || cluster.northernFortOrd < 1 || cluster.carmelValley < 1 || cluster.coastal < 1) {
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

export function splitMontereyReviewedAccessEvidence(evidence: readonly NormalizedAccessEvidence[]): {
  entrances: NormalizedAccessEvidence[];
  currentClosures: NormalizedAccessEvidence[];
} {
  const entrances: NormalizedAccessEvidence[] = [];
  const currentClosures: NormalizedAccessEvidence[] = [];
  for (const item of evidence) {
    if (/^entrance\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item.externalId)) {
      if (item.accessState !== "public" || item.confidence !== "medium") {
        throw new Error(`Reviewed entrance evidence ${item.externalId} must be public with medium confidence`);
      }
      entrances.push(item);
    } else if (/^way\/[1-9]\d*$/.test(item.externalId)) {
      if (item.accessState !== "closed" || item.confidence !== "high") {
        throw new Error(`Reviewed way evidence ${item.externalId} must be a high-confidence current closure`);
      }
      currentClosures.push(item);
    } else {
      throw new Error(`Reviewed access evidence has unsupported target ${item.externalId}`);
    }
  }
  const order = (first: NormalizedAccessEvidence, second: NormalizedAccessEvidence) =>
    first.externalId.localeCompare(second.externalId);
  return { entrances: entrances.sort(order), currentClosures: currentClosures.sort(order) };
}

export function prioritizeMontereyCurrentClosureJoins(
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

export async function buildMontereyCarmelPack(
  options: MontereyCarmelPackBuildOptions,
): Promise<MontereyCarmelPackBuildResult> {
  const regionRoot = MONTEREY_CARMEL_REGION_ROOT;
  const boundaryPath = path.join(regionRoot, "boundary.geojson");
  const searchRegionPath = path.join(regionRoot, "search-regions.json");
  const [boundaryContents, searchRegionContents] = await Promise.all([
    readFile(boundaryPath, "utf8"),
    readFile(searchRegionPath, "utf8"),
  ]);
  const boundary = parseBoundary(boundaryContents);
  const reviewedSnapshot = montereyReviewedAccessSnapshot(regionRoot);
  if (reviewedSnapshot.id !== MONTEREY_REVIEWED_ACCESS_SOURCE_ID) {
    throw new Error(`Reviewed access snapshot has unexpected source ID ${reviewedSnapshot.id}`);
  }
  const reviewedAdapter = new MontereyReviewedAccessAdapter();
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
    reviewedAdapter.validate(reviewedSnapshot),
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
      ? refreshOfficialSourceSnapshots(options.sourceCacheRoot, MONTEREY_OFFICIAL_SOURCE_SET)
      : readOfficialSourceSnapshots(options.sourceCacheRoot, MONTEREY_OFFICIAL_SOURCE_SET),
  ]);

  const trailsSnapshot = requiredSnapshot(officialSnapshots, OFFICIAL_TRAILS_SOURCE_ID);
  const trailsAdapter = new MontereyLosPadresTrailsAdapter();
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
  const reviewedEvidence = splitMontereyReviewedAccessEvidence(
    await reviewedAdapter.normalize(reviewedSnapshot),
  );
  const entrances = addOfficialAccessPointsToTopology(
    osmAccess.topology,
    reviewedEvidence.entrances,
    ACCESS_SNAP_DISTANCE_M,
  );
  const acceptedEntranceIds = new Set(entrances.topology.accessPoints.map(({ id }) => id));
  const acceptedEntranceEvidence = reviewedEvidence.entrances.filter((evidence) =>
    acceptedEntranceIds.has(officialAccessPointId(evidence)));

  // The reviewed entrance points are handled by the conservative node snap
  // above and never produce invented connector edges. Only the official USFS
  // trail lines participate in spatial matching to OSM ways.
  const lineFeatures = await trailsAdapter.normalizeForJoin(trailsSnapshot);
  const lineMatch = matchOfficialAccessToOsmWithReport(entrances.topology, lineFeatures);
  const currentClosureMatches = exactCurrentClosureJoins(
    entrances.topology,
    reviewedEvidence.currentClosures,
  );
  const prioritizedJoins = prioritizeMontereyCurrentClosureJoins(
    lineMatch.joins,
    currentClosureMatches.joins,
  );
  const accessEvidence = applyOfficialWayEvidenceToAccessPoints(
    entrances.topology,
    prioritizedJoins.combinedJoins,
  );
  const inventory = accessInventory(accessEvidence.topology, boundary.geometry);
  const officialJoinAudit = auditOfficialAccessJoins(
    [...lineFeatures, ...currentClosureMatches.features],
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
    trailsSnapshot,
    reviewedSnapshot,
    dem.snapshot,
    population.snapshot,
  ];
  const adapterVersions = [
    sourceTopologyAdapter.adapterVersion,
    namedAreaAdapter.adapterVersion,
    trailsAdapter.adapterVersion,
    reviewedAdapter.adapterVersion,
  ];
  const metricVersions = [elevationSampler.algorithmVersion, populationSampler.algorithmVersion];
  const seed: PackSeed = {
    schemaVersion: "5",
    id: PACK_ID,
    name: "Monterey–Carmel",
    dataVersion: montereyCarmelDataVersion(
      boundaryContents,
      searchRegionContents,
      snapshots,
      adapterVersions,
      metricVersions,
    ),
    compilerVersion: COMPILER_VERSION,
    coverage: { bbox: areaGeometryBounds(boundary.geometry), boundary: boundary.geometry },
    display: { center: [-121.83, 36.52], zoom: 10.5 },
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
        trailsAdapter,
        prioritizedJoins.lineJoins.map(({ evidence }) => evidence),
      ),
      snapshot: trailsSnapshot,
    },
    additionalOfficialAccess: [
      {
        adapter: new PreparedOfficialAccessAdapter(
          reviewedAdapter,
          [...acceptedEntranceEvidence, ...reviewedEvidence.currentClosures],
        ),
        snapshot: reviewedSnapshot,
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
    officialEntranceInputCount: reviewedEvidence.entrances.length,
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
      sourceId: reviewedSnapshot.id,
      inputCount: reviewedEvidence.entrances.length,
      addedCount: entrances.addedCount,
      rejectedCount: entrances.rejectedCount,
      deduplicatedCount: entrances.deduplicatedCount,
    },
    lineMatch: {
      sourceId: trailsSnapshot.id,
      authorityFeatureCount: lineFeatures.length,
      appliedJoinCount: lineMatch.joins.length,
      ambiguousOsmWayCount: lineMatch.ambiguousOsmWayCount,
      unmatchedAuthorityFeatureCount: lineMatch.unmatchedAuthorityFeatureCount,
    },
    currentClosures: {
      sourceId: reviewedSnapshot.id,
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
      sourceId: trailsSnapshot.id,
      ambiguousOsmWayCount: lineMatch.ambiguousOsmWayCount,
      unmatchedAuthorityFeatureCount: lineMatch.unmatchedAuthorityFeatureCount,
    },
    joins: [...lineMatch.joins, ...currentClosureMatches.joins].sort(joinOrder),
  }, null, 2)}\n`);

  return { pack, accessNormalization, officialAccess, regionalAudit };
}
