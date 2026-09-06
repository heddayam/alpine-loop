import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SourceSnapshot } from "./adapters";
import { areaGeometryBounds, assertValidAreaGeometry, pointInArea, type AreaGeometry } from "./area-geometry";
import { assertPackAuditPassed, auditSqlitePack } from "./audit";
import { compilePack, type PackSeed } from "./compiler";
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
  conflateOfficialTrails,
  OFFICIAL_TRAIL_CONFLATION_VERSION,
  readOfficialTrailConflationPolicy,
  readOfficialTrailSourceConfig,
  readPinnedOfficialTrailSnapshot,
  readUsgsNationalDigitalTrails,
  refreshPinnedOfficialTrailSnapshot,
  USGS_NATIONAL_DIGITAL_TRAILS_ADAPTER_VERSION,
  type OfficialTrailConflationAudit,
} from "./official-trails";
import { deriveTrailheadPortals, PORTAL_DERIVATION_VERSION, stripPortalBuildContext } from "./portals";
import type { RegionalPackBuildOptions, RegionalPackBuildResult } from "./regional-pack";
import { readSearchRegionInput } from "./search-regions";
import type { NormalizedTopology } from "./types";

export const BASIC_REGIONAL_PACK_BUILD_PHASES = [
  "Validate regional inputs and prerequisites",
  "Read pinned source snapshots",
  "Extract and normalize OSM topology",
  "Conflate reviewed official trail gaps",
  "Derive trailhead portals and strip build context",
  "Prepare building context",
  "Set up elevation sampling",
  "Collect named areas and compile the regional pack",
  "Audit and publish regional reports",
  "Regional pack build complete",
] as const;

function reportBuildProgress(options: RegionalPackBuildOptions, phase: number, label?: string): void {
  options.onProgress?.({
    phase,
    phaseCount: BASIC_REGIONAL_PACK_BUILD_PHASES.length,
    label: label ?? BASIC_REGIONAL_PACK_BUILD_PHASES[phase - 1]!,
  });
}

export type BasicRegionalPackConfig = {
  id: string;
  name: string;
  dataVersionPrefix: string;
  compilerVersion: string;
  boundaryVersion: string;
  regionRoot: string;
  display: { center: [number, number]; zoom: number };
  officialTrails?: {
    sourceConfigPath: string;
    conflationPolicyPath: string;
  };
};

type BoundaryFeature = {
  type: "Feature";
  geometry: AreaGeometry;
};

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
}

export function parseBasicRegionalBoundary(config: BasicRegionalPackConfig, contents: string): BoundaryFeature {
  const input: unknown = JSON.parse(contents);
  assertRecord(input, `${config.name} boundary`);
  if (input.type !== "Feature") throw new Error(`${config.name} boundary must be a GeoJSON Feature`);
  assertRecord(input.properties, `${config.name} boundary properties`);
  if (input.properties.id !== config.id || input.properties.boundaryVersion !== config.boundaryVersion) {
    throw new Error(`${config.name} boundary identity or version does not match the pack`);
  }
  return { type: "Feature", geometry: assertValidAreaGeometry(input.geometry, `${config.name} boundary`) };
}

export function basicRegionalDataVersion(
  config: BasicRegionalPackConfig,
  boundaryContents: string,
  searchRegionContents: string,
  snapshots: readonly SourceSnapshot[],
  adapterVersions: readonly string[],
  metricVersions: readonly string[],
): string {
  const hash = createHash("sha256");
  hash.update(boundaryContents);
  hash.update(searchRegionContents);
  hash.update(`${config.compilerVersion}\n`);
  for (const version of [...adapterVersions].sort()) hash.update(`adapter\0${version}\n`);
  for (const version of [...metricVersions].sort()) hash.update(`metric\0${version}\n`);
  for (const snapshot of [...snapshots].sort((first, second) => first.id.localeCompare(second.id))) {
    hash.update(`${snapshot.id}\0${snapshot.version}\0${snapshot.contentHash}\0${snapshot.license}\n`);
  }
  return `${config.dataVersionPrefix}-${hash.digest("hex").slice(0, 16)}`;
}

export function createBasicRegionalPackSeed(input: {
  config: BasicRegionalPackConfig;
  boundary: AreaGeometry;
  boundaryContents: string;
  searchRegionContents: string;
  snapshots: readonly SourceSnapshot[];
  adapterVersions: readonly string[];
  metricVersions: readonly string[];
}): PackSeed {
  return {
    schemaVersion: "6",
    id: input.config.id,
    name: input.config.name,
    dataVersion: basicRegionalDataVersion(
      input.config,
      input.boundaryContents,
      input.searchRegionContents,
      input.snapshots,
      input.adapterVersions,
      input.metricVersions,
    ),
    compilerVersion: input.config.compilerVersion,
    coverage: { bbox: areaGeometryBounds(input.boundary), boundary: input.boundary },
    display: input.config.display,
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
}

async function collectTopology(adapter: OsmPbfTopologyAdapter, snapshot: SourceSnapshot): Promise<NormalizedTopology> {
  const topologies: NormalizedTopology[] = [];
  for await (const topology of adapter.normalize(snapshot)) topologies.push(topology);
  if (topologies.length !== 1) throw new Error(`OSM adapter produced ${topologies.length} topologies`);
  return topologies[0]!;
}

function portalReport(input: NormalizedTopology, portals: NormalizedTopology, published: NormalizedTopology, boundary: AreaGeometry) {
  const nodes = new Map(portals.nodes.map((node) => [node.id, node]));
  const byAccessState = { public: 0, unknown: 0, private: 0, closed: 0, prohibited: 0 };
  const byConfidence = { high: 0, medium: 0, low: 0 };
  let insideCoverageCount = 0;
  let outsideCoverageCount = 0;
  let withParkingEvidenceCount = 0;
  for (const portal of portals.accessPoints) {
    const node = nodes.get(portal.nodeId);
    if (!node) throw new Error(`Portal ${portal.id} references missing node ${portal.nodeId}`);
    if (pointInArea([node.lon, node.lat], boundary)) insideCoverageCount += 1;
    else outsideCoverageCount += 1;
    byAccessState[portal.accessState] += 1;
    byConfidence[portal.confidence] += 1;
    if (portal.parkingEvidence) withParkingEvidenceCount += 1;
  }
  if (portals.accessPoints.length === 0 || insideCoverageCount === 0) {
    throw new Error("Portal derivation produced no in-coverage access points");
  }
  const countClass = (edgeClass: "trail" | "service-road" | "street" | "sidewalk") =>
    input.ways.filter((way) => way.edgeClass === edgeClass).length;
  return {
    schemaVersion: "1",
    portals: {
      total: portals.accessPoints.length,
      insideCoverageCount,
      outsideCoverageCount,
      byAccessState,
      byConfidence,
      withParkingEvidenceCount,
    },
    buildContext: {
      inputNodeCount: input.nodes.length,
      publishedNodeCount: published.nodes.length,
      inputWayCount: input.ways.length,
      publishedWayCount: published.ways.length,
      trailWayCount: countClass("trail"),
      serviceRoadWayCount: countClass("service-road"),
      streetWayCount: countClass("street"),
      sidewalkWayCount: countClass("sidewalk"),
      portalEvidenceCount: input.portalEvidence?.length ?? 0,
      strippedNodeCount: input.nodes.length - published.nodes.length,
      strippedWayCount: input.ways.length - published.ways.length,
    },
  };
}

function newestRetrieval(snapshots: readonly SourceSnapshot[]): string {
  return snapshots.map(({ retrievedAt }) => retrievedAt).sort().at(-1)!;
}

function addOfficialTrailPublicationCounts(
  audit: OfficialTrailConflationAudit,
  databasePath: string,
  sourceId: string,
): void {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const row = database.prepare(`
      SELECT COUNT(*) AS physical_edge_count, COALESCE(SUM(length_m), 0) AS length_m
      FROM (
        SELECT physical_edge_key, MAX(length_m) AS length_m
        FROM edges
        WHERE source_refs LIKE ?
        GROUP BY physical_edge_key
      )
    `).get(`%"${sourceId}"%`) as { physical_edge_count: number; length_m: number };
    audit.publishedPhysicalEdgeCount = row.physical_edge_count;
    audit.publishedLengthM = row.length_m;
  } finally {
    database.close();
  }
}

/**
 * Builds a schema-6 region whose starts and building context come from the
 * pinned OSM snapshot. A configured official trail source may add only
 * deterministically conflated, connected gaps; it never supplies access truth.
 */
export function createBasicRegionalPackBuilder(config: BasicRegionalPackConfig) {
  return async function buildBasicRegionalPack(
    options: RegionalPackBuildOptions,
  ): Promise<RegionalPackBuildResult> {
    reportBuildProgress(options, 1);
    const boundaryPath = path.join(config.regionRoot, "boundary.geojson");
    const searchRegionPath = path.join(config.regionRoot, "search-regions.json");
    const [boundaryContents, searchRegionContents, searchRegions, osmConfig, elevationConfig, officialTrailConfig, officialTrailPolicy] = await Promise.all([
      readFile(boundaryPath, "utf8"),
      readFile(searchRegionPath, "utf8"),
      readSearchRegionInput(searchRegionPath),
      readOsmSourceConfig(path.join(config.regionRoot, "osm-source.json")),
      readElevationSourceConfig(path.join(config.regionRoot, "elevation-source.json")),
      config.officialTrails ? readOfficialTrailSourceConfig(config.officialTrails.sourceConfigPath) : Promise.resolve(null),
      config.officialTrails ? readOfficialTrailConflationPolicy(config.officialTrails.conflationPolicyPath) : Promise.resolve(null),
    ]);
    const boundary = parseBasicRegionalBoundary(config, boundaryContents);

    await Promise.all([validateOsmPrerequisites(), validateUvRasterioPrerequisites()]);
    reportBuildProgress(options, 2, options.refresh ? "Refresh pinned source snapshots" : undefined);
    const [osmSnapshot, dem, officialTrailSnapshot] = await Promise.all([
      options.refresh
        ? refreshPinnedOsmSnapshot(options.sourceCacheRoot, osmConfig).then(({ snapshot }) => snapshot)
        : readPinnedOsmSnapshot(options.sourceCacheRoot, osmConfig),
      options.refresh
        ? refreshPinnedThreeDepCollection(options.sourceCacheRoot, elevationConfig)
        : readPinnedThreeDepCollection(options.sourceCacheRoot, elevationConfig),
      officialTrailConfig
        ? options.refresh
          ? refreshPinnedOfficialTrailSnapshot(options.sourceCacheRoot, officialTrailConfig).then(({ snapshot }) => snapshot)
          : readPinnedOfficialTrailSnapshot(options.sourceCacheRoot, officialTrailConfig)
        : Promise.resolve(null),
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
    reportBuildProgress(options, 3);
    const sourceTopology = await collectTopology(sourceTopologyAdapter, osmSnapshot);
    reportBuildProgress(options, 4);
    let inputTopology = sourceTopology;
    let officialTrailConflationAudit: OfficialTrailConflationAudit | null = null;
    if (officialTrailSnapshot && officialTrailPolicy) {
      const features = await readUsgsNationalDigitalTrails(officialTrailSnapshot);
      const conflated = conflateOfficialTrails({
        topology: sourceTopology,
        features,
        sourceId: officialTrailSnapshot.id,
        policy: officialTrailPolicy,
      });
      inputTopology = conflated.topology;
      officialTrailConflationAudit = conflated.audit;
    }
    reportBuildProgress(options, 5);
    const portals = deriveTrailheadPortals(inputTopology);
    const publishedTopology = stripPortalBuildContext(portals);
    const portalAudit = portalReport(inputTopology, portals, publishedTopology, boundary.geometry);
    reportBuildProgress(options, 6);
    const buildings = await prepareOsmBuildings(osmSnapshot, {
      boundaryPath,
      preparationRoot: path.join(options.preparationRoot, "osm"),
    });
    reportBuildProgress(options, 7);
    const elevationSampler = new UvRasterioThreeDepElevationSampler(dem.collectionPath);
    const snapshots = [osmSnapshot, dem.snapshot, ...(officialTrailSnapshot ? [officialTrailSnapshot] : [])];
    const adapterVersions = [
      sourceTopologyAdapter.adapterVersion,
      namedAreaAdapter.adapterVersion,
      PORTAL_DERIVATION_VERSION,
      ...(officialTrailSnapshot ? [OFFICIAL_TRAIL_CONFLATION_VERSION, USGS_NATIONAL_DIGITAL_TRAILS_ADAPTER_VERSION] : []),
      ...(officialTrailPolicy ? [
        `official-trail-policy:${createHash("sha256").update(JSON.stringify(officialTrailPolicy)).digest("hex")}`,
      ] : []),
    ];
    const metricVersions = [elevationSampler.algorithmVersion, BUILDINGS_ADAPTER_VERSION];
    const seed = createBasicRegionalPackSeed({
      config,
      boundary: boundary.geometry,
      boundaryContents,
      searchRegionContents,
      snapshots,
      adapterVersions,
      metricVersions,
    });
    reportBuildProgress(options, 8);
    const pack = await compilePack({
      outputRoot: options.outputRoot,
      seed,
      builtAt: newestRetrieval(snapshots),
      topology: {
        data: publishedTopology,
        snapshot: osmSnapshot,
      },
      elevation: { sampler: elevationSampler, snapshot: dem.snapshot },
      buildings,
      namedAreas: { adapter: namedAreaAdapter, snapshot: osmSnapshot },
      searchRegions,
      ...(officialTrailSnapshot ? { additionalSources: [officialTrailSnapshot] } : {}),
    });
    reportBuildProgress(options, 9);
    const regionalAudit = await auditSqlitePack({
      databasePath: pack.databasePath,
      manifestPath: pack.manifestPath,
      auditPath: pack.auditPath,
    });
    assertPackAuditPassed(regionalAudit);
    if (officialTrailConflationAudit && officialTrailSnapshot) {
      addOfficialTrailPublicationCounts(officialTrailConflationAudit, pack.databasePath, officialTrailSnapshot.id);
    }
    await Promise.all([
      writeFile(path.join(pack.packDirectory, "regional-audit.json"), `${JSON.stringify(regionalAudit, null, 2)}\n`),
      writeFile(path.join(pack.packDirectory, "portal-audit.json"), `${JSON.stringify(portalAudit, null, 2)}\n`),
      ...(officialTrailConflationAudit ? [
        writeFile(path.join(pack.packDirectory, "official-trail-conflation-audit.json"), `${JSON.stringify(officialTrailConflationAudit, null, 2)}\n`),
      ] : []),
    ]);
    reportBuildProgress(options, 10);
    return { pack, portalAudit, regionalAudit, ...(officialTrailConflationAudit ? { officialTrailConflationAudit } : {}) };
  };
}
