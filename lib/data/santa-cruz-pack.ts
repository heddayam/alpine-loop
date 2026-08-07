import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  MidpenOfficialAccessAdapter,
  SantaClaraCountyParksAccessAdapter,
  matchOfficialAccessToOsmWithReport,
  readOfficialSourceSnapshots,
  refreshOfficialSourceSnapshots,
  type OfficialAccessJoin,
  type OfficialAccessJoinFeature,
} from "./authorities";
import { assertPackAuditPassed, auditOfficialAccessJoins, auditSqlitePack } from "./audit";
import type { OfficialAccessAdapter, SourceSnapshot } from "./adapters";
import { snapAccessPointsToTopology } from "./access-point-snap";
import { applyOfficialWayEvidenceToAccessPoints } from "./access-point-evidence";
import { areaGeometryBounds, type AreaGeometry } from "./area-geometry";
import { compilePack, type PackSeed } from "./compiler";
import {
  readElevationSourceConfig,
  readPinnedThreeDepCollection,
  refreshPinnedThreeDepCollection,
  UvRasterioThreeDepElevationSampler,
  validateUvRasterioPrerequisites,
} from "./elevation";
import {
  OsmPbfTopologyAdapter,
  OsmPbfNamedAreaAdapter,
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
import { POPULATION_RADIUS_M } from "./remoteness";
import { PreparedOfficialAccessAdapter } from "./prepared-official-access-adapter";
import { PreparedTopologyAdapter } from "./prepared-topology-adapter";
import { readSearchRegionInput } from "./search-regions";
import type { NormalizedTopology, PackBuildResult } from "./types";

const PACK_ID = "santa-cruz-mountains";
const COMPILER_VERSION = "santa-cruz-pack-compiler-v13";
const ACCESS_SNAP_DISTANCE_M = 200;
const REPRESENTATIVE_MOUNTAIN_BBOX = [-122.195, 37.305, -122.165, 37.333] as const;
const UCSC_AUDIT_BBOX = [-122.075, 36.975, -122.045, 37.01] as const;

type BoundaryFeature = {
  type: "Feature";
  geometry: AreaGeometry;
};

type AuthorityInput = {
  adapter: MidpenOfficialAccessAdapter | SantaClaraCountyParksAccessAdapter;
  sourceAdapter: OfficialAccessAdapter;
  snapshot: SourceSnapshot;
  features: OfficialAccessJoinFeature[];
  joins: OfficialAccessJoin[];
  ambiguousOsmWayCount: number;
  unmatchedAuthorityFeatureCount: number;
  rejectedGeometryFeatureIds: string[];
};

export type SantaCruzPackBuildOptions = {
  outputRoot: string;
  sourceCacheRoot: string;
  preparationRoot: string;
  refresh: boolean;
};

export type SantaCruzPackBuildResult = {
  pack: PackBuildResult;
  accessNormalization: {
    snapDistanceM: number;
    snappedCount: number;
    alreadyConnectedCount: number;
    deduplicatedCount: number;
    officialPublicCount: number;
    officialRestrictedCount: number;
    officialConflictCount: number;
    rejectedAccessPointIds: string[];
  };
  officialAccess: Array<{
    sourceId: string;
    authorityFeatureCount: number;
    appliedJoinCount: number;
    ambiguousOsmWayCount: number;
    unmatchedAuthorityFeatureCount: number;
    rejectedGeometryFeatureCount: number;
  }>;
  regionalAudit: Awaited<ReturnType<typeof auditSqlitePack>>;
};

function pointInside(lon: number, lat: number, bbox: readonly [number, number, number, number]): boolean {
  return lon >= bbox[0] && lon <= bbox[2] && lat >= bbox[1] && lat <= bbox[3];
}

function accessInventory(topology: NormalizedTopology) {
  const nodes = new Map(topology.nodes.map((node) => [node.id, node]));
  const byKind = { trailhead: 0, parking: 0 };
  const byState = { public: 0, unknown: 0, private: 0, closed: 0, prohibited: 0 };
  let representativeMountainCount = 0;
  let representativeMountainPublicCount = 0;
  let publicOutsideUcscCount = 0;
  for (const point of topology.accessPoints) {
    byKind[point.kind] += 1;
    byState[point.accessState] += 1;
    const node = nodes.get(point.nodeId);
    if (!node) throw new Error(`Access point ${point.id} references missing node ${point.nodeId}`);
    const representative = pointInside(node.lon, node.lat, REPRESENTATIVE_MOUNTAIN_BBOX);
    if (representative) representativeMountainCount += 1;
    if (representative && point.accessState === "public") representativeMountainPublicCount += 1;
    if (point.accessState === "public" && !pointInside(node.lon, node.lat, UCSC_AUDIT_BBOX)) publicOutsideUcscCount += 1;
  }
  const inventory = {
    total: topology.accessPoints.length,
    byKind,
    byState,
    defaultPublicCount: byState.public,
    publicOutsideUcscCount,
    representativeMountain: {
      bbox: REPRESENTATIVE_MOUNTAIN_BBOX,
      totalCount: representativeMountainCount,
      publicCount: representativeMountainPublicCount,
    },
  };
  if (inventory.defaultPublicCount < 100 || inventory.publicOutsideUcscCount < 50
    || inventory.representativeMountain.publicCount < 2) {
    throw new Error(`Access inventory is not regionally useful: ${JSON.stringify(inventory)}`);
  }
  return inventory;
}

function requiredSnapshot(snapshots: SourceSnapshot[], id: string): SourceSnapshot {
  const snapshot = snapshots.find((candidate) => candidate.id === id);
  if (!snapshot) throw new Error(`Missing official snapshot ${id}`);
  return snapshot;
}

function newestRetrieval(snapshots: SourceSnapshot[]): string {
  return snapshots.map(({ retrievedAt }) => retrievedAt).sort().at(-1)!;
}

function dataVersion(
  boundaryContents: string,
  searchRegionContents: string,
  snapshots: SourceSnapshot[],
  topologyAdapterVersion: string,
  metricAlgorithmVersion: string,
): string {
  const hash = createHash("sha256");
  hash.update(boundaryContents);
  hash.update(searchRegionContents);
  hash.update(COMPILER_VERSION);
  hash.update(topologyAdapterVersion);
  hash.update(metricAlgorithmVersion);
  for (const snapshot of [...snapshots].sort((first, second) => first.id.localeCompare(second.id))) {
    hash.update(`${snapshot.id}\0${snapshot.version}\0${snapshot.contentHash}\0${snapshot.license}\n`);
  }
  return `scm-${hash.digest("hex").slice(0, 16)}`;
}

async function authorityInput(
  adapter: MidpenOfficialAccessAdapter | SantaClaraCountyParksAccessAdapter,
  snapshot: SourceSnapshot,
  topology: NormalizedTopology,
): Promise<AuthorityInput> {
  const normalized = await adapter.normalizeForJoinWithReport(snapshot);
  const features = normalized.features;
  const matched = matchOfficialAccessToOsmWithReport(topology, features);
  return {
    adapter,
    sourceAdapter: adapter,
    snapshot,
    features,
    joins: matched.joins,
    ambiguousOsmWayCount: matched.ambiguousOsmWayCount,
    unmatchedAuthorityFeatureCount: matched.unmatchedAuthorityFeatureCount,
    rejectedGeometryFeatureIds: normalized.rejectedGeometryFeatureIds,
  };
}

export async function buildSantaCruzPack(options: SantaCruzPackBuildOptions): Promise<SantaCruzPackBuildResult> {
  const regionRoot = path.resolve("data/regions/santa-cruz-mountains");
  const boundaryPath = path.join(regionRoot, "boundary.geojson");
  const boundaryContents = await readFile(boundaryPath, "utf8");
  const searchRegionPath = path.join(regionRoot, "search-regions.json");
  const searchRegionContents = await readFile(searchRegionPath, "utf8");
  const searchRegions = await readSearchRegionInput(searchRegionPath);
  const boundary = JSON.parse(boundaryContents) as BoundaryFeature;
  const osmConfig = await readOsmSourceConfig(path.join(regionRoot, "osm-source.json"));
  const elevationConfig = await readElevationSourceConfig(path.join(regionRoot, "elevation-source.json"));
  const populationConfig = await readPopulationSourceConfig(path.join(regionRoot, "population-source.json"));

  // Fail before downloading hundreds of megabytes when the local build tools are unavailable.
  await Promise.all([
    validateOsmPrerequisites(),
    validateUvRasterioPrerequisites(),
    validateUvRasterioPopulationPrerequisites(),
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
      ? refreshOfficialSourceSnapshots(options.sourceCacheRoot)
      : readOfficialSourceSnapshots(options.sourceCacheRoot),
  ]);

  const sourceTopologyAdapter = new OsmPbfTopologyAdapter({
    boundaryPath,
    preparationRoot: path.join(options.preparationRoot, "osm"),
  });
  const namedAreaAdapter = new OsmPbfNamedAreaAdapter({
    boundaryPath,
    preparationRoot: path.join(options.preparationRoot, "osm"),
    namedAreaPreparationRoot: path.join(options.preparationRoot, "osm-named-areas"),
  });
  const preparedTopology = snapAccessPointsToTopology(
    await (async () => {
      const normalized: NormalizedTopology[] = [];
      for await (const topology of sourceTopologyAdapter.normalize(osmSnapshot)) normalized.push(topology);
      if (normalized.length !== 1) throw new Error(`OSM adapter produced ${normalized.length} topologies`);
      return normalized[0];
    })(),
    ACCESS_SNAP_DISTANCE_M,
  );

  const authorities = await Promise.all([
    authorityInput(
      new MidpenOfficialAccessAdapter(),
      requiredSnapshot(officialSnapshots, "midpen-trails"),
      preparedTopology.topology,
    ),
    authorityInput(
      new SantaClaraCountyParksAccessAdapter(),
      requiredSnapshot(officialSnapshots, "santa-clara-county-parks-trails"),
      preparedTopology.topology,
    ),
  ]);
  const allFeatures = authorities.flatMap(({ features }) => features);
  const allJoins = authorities.flatMap(({ joins }) => joins);
  const accessEvidence = applyOfficialWayEvidenceToAccessPoints(preparedTopology.topology, allJoins);
  const inventory = accessInventory(accessEvidence.topology);
  const joinAudit = auditOfficialAccessJoins(
    allFeatures,
    allJoins,
    new Set(preparedTopology.topology.ways.map(({ externalId }) => externalId)),
  );
  if (joinAudit.errors.length) throw new Error(`Official access join audit failed:\n${joinAudit.errors.join("\n")}`);

  const elevationSampler = new UvRasterioThreeDepElevationSampler(dem.collectionPath);
  const populationSampler = new UvRasterioPopulationSampler(population.collectionPath, POPULATION_RADIUS_M);
  // Confirms the downloaded rasters are georeferenced where the GHSL tile index
  // predicted. Without this a grid irregularity in a future region would sample
  // population from the wrong part of the world and silently call everything remote.
  await populationSampler.verify(population.collection);
  const snapshots = [osmSnapshot, ...authorities.map(({ snapshot }) => snapshot), dem.snapshot, population.snapshot];
  const seed: PackSeed = {
    schemaVersion: "5",
    id: PACK_ID,
    name: "Santa Cruz Mountains",
    dataVersion: dataVersion(
      boundaryContents,
      searchRegionContents,
      snapshots,
      `${sourceTopologyAdapter.adapterVersion}+${namedAreaAdapter.adapterVersion}`,
      // Retuning the population radius must produce a new pack version.
      `${elevationSampler.algorithmVersion}+${populationSampler.algorithmVersion}`,
    ),
    compilerVersion: COMPILER_VERSION,
    coverage: { bbox: areaGeometryBounds(boundary.geometry), boundary: boundary.geometry },
    display: { center: [-122.18, 37.319], zoom: 13.5 },
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
  const [firstAuthority, ...additionalAuthorities] = authorities;
  const pack = await compilePack({
    outputRoot: options.outputRoot,
    seed,
    builtAt: newestRetrieval(snapshots),
    topology: {
      adapter: new PreparedTopologyAdapter(sourceTopologyAdapter, accessEvidence.topology),
      snapshot: osmSnapshot,
    },
    officialAccess: {
      adapter: new PreparedOfficialAccessAdapter(firstAuthority.sourceAdapter, firstAuthority.joins.map(({ evidence }) => evidence)),
      snapshot: firstAuthority.snapshot,
    },
    additionalOfficialAccess: additionalAuthorities.map((authority) => ({
      adapter: new PreparedOfficialAccessAdapter(authority.sourceAdapter, authority.joins.map(({ evidence }) => evidence)),
      snapshot: authority.snapshot,
    })),
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
  await writeFile(path.join(pack.packDirectory, "regional-audit.json"), `${JSON.stringify(regionalAudit, null, 2)}\n`);
  await writeFile(path.join(pack.packDirectory, "access-join-audit.json"), `${JSON.stringify({
    schemaVersion: "1",
    snapDistanceM: ACCESS_SNAP_DISTANCE_M,
    accessNormalization: {
      snappedCount: preparedTopology.snappedCount,
      alreadyConnectedCount: preparedTopology.alreadyConnectedCount,
      deduplicatedCount: preparedTopology.deduplicatedCount,
      officialPublicCount: accessEvidence.promotedPublicCount,
      officialRestrictedCount: accessEvidence.restrictedCount,
      officialConflictCount: accessEvidence.conflictedCount,
      rejectedAccessPointIds: preparedTopology.rejectedAccessPointIds,
    },
    accessInventory: inventory,
    joinAudit,
    matchReports: authorities.map((authority) => ({
      sourceId: authority.snapshot.id,
      authorityFeatureCount: authority.features.length,
      appliedJoinCount: authority.joins.length,
      ambiguousOsmWayCount: authority.ambiguousOsmWayCount,
      unmatchedAuthorityFeatureCount: authority.unmatchedAuthorityFeatureCount,
      rejectedGeometryFeatureIds: authority.rejectedGeometryFeatureIds,
    })),
    joins: allJoins,
  }, null, 2)}\n`);

  return {
    pack,
    accessNormalization: {
      snapDistanceM: ACCESS_SNAP_DISTANCE_M,
      snappedCount: preparedTopology.snappedCount,
      alreadyConnectedCount: preparedTopology.alreadyConnectedCount,
      deduplicatedCount: preparedTopology.deduplicatedCount,
      officialPublicCount: accessEvidence.promotedPublicCount,
      officialRestrictedCount: accessEvidence.restrictedCount,
      officialConflictCount: accessEvidence.conflictedCount,
      rejectedAccessPointIds: preparedTopology.rejectedAccessPointIds,
    },
    officialAccess: authorities.map((authority) => ({
      sourceId: authority.snapshot.id,
      authorityFeatureCount: authority.features.length,
      appliedJoinCount: authority.joins.length,
      ambiguousOsmWayCount: authority.ambiguousOsmWayCount,
      unmatchedAuthorityFeatureCount: authority.unmatchedAuthorityFeatureCount,
      rejectedGeometryFeatureCount: authority.rejectedGeometryFeatureIds.length,
    })),
    regionalAudit,
  };
}
