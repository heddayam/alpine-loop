import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { auditSqlitePack } from "./audit";
import { compileAuditedPack } from "./audited-pack";
import { areaGeometryBounds, type AreaGeometry } from "./area-geometry";
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
  OsmPbfTopologyAdapter,
  readOsmSourceConfig,
  readPinnedOsmSnapshot,
  refreshPinnedOsmSnapshot,
  validateOsmPrerequisites,
} from "./osm";
import { deriveTrailheadPortals, PORTAL_DERIVATION_VERSION, stripPortalBuildContext } from "./portals";
import { readSearchRegionInput } from "./search-regions";
import type { AccessState } from "@/lib/graph/types";
import type { NormalizedAccessPoint, NormalizedTopology, PackBuildResult } from "./types";

export const SANTA_CRUZ_REGION_ROOT = path.resolve("data/regions/santa-cruz-mountains");
export const SANTA_CRUZ_CURATED_ACCESS_PATH = path.join(SANTA_CRUZ_REGION_ROOT, "access-restrictions.json");
const SANTA_CRUZ_CURATED_ACCESS_HASH = "sha256:b648fdd3fae2f51d33b72398657ec297ea6a0e69c2c8167161b6c54c26aee5ea";

const PACK_ID = "santa-cruz-mountains";
const COMPILER_VERSION = "santa-cruz-pack-compiler-v14-portals";

type BoundaryFeature = {
  type: "Feature";
  geometry: AreaGeometry;
};

type CountByAccessState = Record<AccessState, number>;
type CountByConfidence = Record<NormalizedAccessPoint["confidence"], number>;

export type SantaCruzPackBuildOptions = {
  outputRoot: string;
  sourceCacheRoot: string;
  preparationRoot: string;
  refresh: boolean;
};

export type SantaCruzPackBuildResult = {
  pack: PackBuildResult;
  portalDerivation: {
    curatedRestrictionCount: number;
    portalCount: number;
    portalByAccessState: CountByAccessState;
    portalByConfidence: CountByConfidence;
    inputWayCount: number;
    trailWayCount: number;
    streetWayCount: number;
    serviceRoadWayCount: number;
    sidewalkWayCount: number;
    publishedWayCount: number;
    strippedBuildContextWayCount: number;
    inputNodeCount: number;
    publishedNodeCount: number;
    strippedBuildContextNodeCount: number;
    inputEvidenceCount: number;
    publishedEvidenceCount: number;
  };
  regionalAudit: Awaited<ReturnType<typeof auditSqlitePack>>;
};

function newestRetrieval(retrievedAt: readonly string[]): string {
  return [...retrievedAt].sort().at(-1)!;
}

function dataVersion(
  boundaryContents: string,
  searchRegionContents: string,
  sourceFingerprints: readonly string[],
  topologyAdapterVersion: string,
  metricAlgorithmVersion: string,
): string {
  const hash = createHash("sha256");
  hash.update(boundaryContents);
  hash.update(searchRegionContents);
  hash.update(COMPILER_VERSION);
  hash.update(topologyAdapterVersion);
  hash.update(metricAlgorithmVersion);
  for (const fingerprint of [...sourceFingerprints].sort()) hash.update(`${fingerprint}\n`);
  return `scm-${hash.digest("hex").slice(0, 16)}`;
}

async function normalizedTopology(
  adapter: OsmPbfTopologyAdapter,
  snapshot: Parameters<OsmPbfTopologyAdapter["normalize"]>[0],
): Promise<NormalizedTopology> {
  const normalized: NormalizedTopology[] = [];
  for await (const topology of adapter.normalize(snapshot)) normalized.push(topology);
  if (normalized.length !== 1) throw new Error(`OSM adapter produced ${normalized.length} topologies`);
  return normalized[0]!;
}

function countByAccessState(points: readonly NormalizedAccessPoint[]): CountByAccessState {
  const counts: CountByAccessState = { public: 0, unknown: 0, private: 0, closed: 0, prohibited: 0 };
  for (const point of points) counts[point.accessState] += 1;
  return counts;
}

function countByConfidence(points: readonly NormalizedAccessPoint[]): CountByConfidence {
  const counts: CountByConfidence = { high: 0, medium: 0, low: 0 };
  for (const point of points) counts[point.confidence] += 1;
  return counts;
}

function portalDerivationReport(
  input: NormalizedTopology,
  portals: NormalizedTopology,
  published: NormalizedTopology,
  curatedRestrictionCount: number,
): SantaCruzPackBuildResult["portalDerivation"] {
  const countClass = (edgeClass: NonNullable<NormalizedTopology["ways"][number]["edgeClass"]>) =>
    input.ways.filter((way) => way.edgeClass === edgeClass).length;
  return {
    curatedRestrictionCount,
    portalCount: portals.accessPoints.length,
    portalByAccessState: countByAccessState(portals.accessPoints),
    portalByConfidence: countByConfidence(portals.accessPoints),
    inputWayCount: input.ways.length,
    trailWayCount: countClass("trail"),
    streetWayCount: countClass("street"),
    serviceRoadWayCount: countClass("service-road"),
    sidewalkWayCount: countClass("sidewalk"),
    publishedWayCount: published.ways.length,
    strippedBuildContextWayCount: input.ways.length - published.ways.length,
    inputNodeCount: input.nodes.length,
    publishedNodeCount: published.nodes.length,
    strippedBuildContextNodeCount: input.nodes.length - published.nodes.length,
    inputEvidenceCount: input.portalEvidence?.length ?? 0,
    publishedEvidenceCount: published.portalEvidence?.length ?? 0,
  };
}

export async function buildSantaCruzPack(options: SantaCruzPackBuildOptions): Promise<SantaCruzPackBuildResult> {
  const boundaryPath = path.join(SANTA_CRUZ_REGION_ROOT, "boundary.geojson");
  const boundaryContents = await readFile(boundaryPath, "utf8");
  const searchRegionPath = path.join(SANTA_CRUZ_REGION_ROOT, "search-regions.json");
  const searchRegionContents = await readFile(searchRegionPath, "utf8");
  const searchRegions = await readSearchRegionInput(searchRegionPath);
  const boundary = JSON.parse(boundaryContents) as BoundaryFeature;
  const [osmConfig, elevationConfig, curatedAccess] = await Promise.all([
    readOsmSourceConfig(path.join(SANTA_CRUZ_REGION_ROOT, "osm-source.json")),
    readElevationSourceConfig(path.join(SANTA_CRUZ_REGION_ROOT, "elevation-source.json")),
    readCuratedAccessFile(SANTA_CRUZ_CURATED_ACCESS_PATH, SANTA_CRUZ_CURATED_ACCESS_HASH),
  ]);

  // Fail before downloading hundreds of megabytes when the local build tools are unavailable.
  await Promise.all([
    validateOsmPrerequisites(),
    validateUvRasterioPrerequisites(),
  ]);
  const [osmSnapshot, dem] = await Promise.all([
    options.refresh
      ? refreshPinnedOsmSnapshot(options.sourceCacheRoot, osmConfig).then(({ snapshot }) => snapshot)
      : readPinnedOsmSnapshot(options.sourceCacheRoot, osmConfig),
    options.refresh
      ? refreshPinnedThreeDepCollection(options.sourceCacheRoot, elevationConfig)
      : readPinnedThreeDepCollection(options.sourceCacheRoot, elevationConfig),
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
  const classifiedTopology = await normalizedTopology(sourceTopologyAdapter, osmSnapshot);
  const restrictedTopology = applyCuratedAccessRestrictions(
    classifiedTopology,
    curatedAccess.snapshot.id,
    curatedAccess.restrictions,
  );
  const portalTopology = deriveTrailheadPortals(restrictedTopology);
  const publishedTopology = stripPortalBuildContext(portalTopology);
  const portalDerivation = portalDerivationReport(
    classifiedTopology,
    portalTopology,
    publishedTopology,
    curatedAccess.restrictions.length,
  );

  const elevationSampler = new UvRasterioThreeDepElevationSampler(dem.collectionPath);
  const buildings = await prepareOsmBuildings(osmSnapshot, {
    boundaryPath,
    preparationRoot: path.join(options.preparationRoot, "osm"),
  });
  const snapshots = [osmSnapshot, curatedAccess.snapshot, dem.snapshot];
  const seed: PackSeed = {
    schemaVersion: "6",
    id: PACK_ID,
    name: "Santa Cruz Mountains",
    dataVersion: dataVersion(
      boundaryContents,
      searchRegionContents,
      snapshots.map((snapshot) => `${snapshot.id}\0${snapshot.version}\0${snapshot.contentHash}\0${snapshot.license}`),
      `${sourceTopologyAdapter.adapterVersion}+${namedAreaAdapter.adapterVersion}+${PORTAL_DERIVATION_VERSION}`,
      `${elevationSampler.algorithmVersion}+${BUILDINGS_ADAPTER_VERSION}`,
    ),
    compilerVersion: COMPILER_VERSION,
    coverage: { bbox: areaGeometryBounds(boundary.geometry), boundary: boundary.geometry },
    display: { center: [-122.18, 37.319], zoom: 13.5 },
    capabilities: {
      elevation: true,
      officialAccess: false,
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
    builtAt: newestRetrieval(snapshots.map(({ retrievedAt }) => retrievedAt)),
    topology: {
      data: publishedTopology,
      snapshot: osmSnapshot,
    },
    additionalSources: [curatedAccess.snapshot],
    elevation: { sampler: elevationSampler, snapshot: dem.snapshot },
    buildings,
    namedAreas: { adapter: namedAreaAdapter, snapshot: osmSnapshot },
    searchRegions,
  }, () => ({
    "portal-derivation-audit.json": {
      schemaVersion: "1",
      curatedAccessSourceId: curatedAccess.snapshot.id,
      ...portalDerivation,
    },
  }));

  return { pack, portalDerivation, regionalAudit };
}
