import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CLOSED_ROUTE_TOPOLOGY_ALGORITHM_VERSION } from "@/lib/graph/closed-route-topology";
import type { SourceSnapshot } from "./adapters";
import { areaGeometryBounds, assertValidAreaGeometry, pointInArea, type AreaGeometry } from "./area-geometry";
import { compileAuditedPack } from "./audited-pack";
import type { PackSeed } from "./compiler";
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
import { applyOfficialEntranceOverlayWithReport, deriveTrailheadPortals, PORTAL_DERIVATION_VERSION, stripPortalBuildContext } from "./portals";
import { applyCuratedAccessRestrictions, readCuratedAccessFile } from "./curated-access";
import type { PreparedRegionalEntrances, RegionalPackBuildOptions, RegionalPackDefinition } from "./regional-build-types";
export type { RegionalPackDefinition } from "./regional-build-types";
import { searchRegionInputSchema } from "./search-regions";
import type { NormalizedTopology } from "./types";
import type { CacheDownloadOptions } from "./source-cache";

export const REGIONAL_PACK_BUILD_PHASES = [
  "Validate regional inputs and prerequisites",
  "Read pinned source snapshots",
  "Extract and normalize OSM topology",
  "Conflate reviewed official trail gaps",
  "Apply restrictions, derive trailheads, and apply entrance names",
  "Prepare building context",
  "Set up elevation sampling",
  "Collect named areas and compile the regional pack",
  "Audit and publish regional reports",
  "Regional pack build complete",
] as const;

function reportBuildProgress(options: RegionalPackBuildOptions, phase: number, label?: string, detail?: string): void {
  options.onProgress?.({
    phase,
    phaseCount: REGIONAL_PACK_BUILD_PHASES.length,
    label: label ?? REGIONAL_PACK_BUILD_PHASES[phase - 1]!,
    ...(detail ? { detail } : {}),
  });
}

type BoundaryFeature = {
  type: "Feature";
  geometry: AreaGeometry;
};

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
}

export function parseRegionalBoundary(config: RegionalPackDefinition, contents: string): BoundaryFeature {
  const input: unknown = JSON.parse(contents);
  assertRecord(input, `${config.name} boundary`);
  if (input.type !== "Feature") throw new Error(`${config.name} boundary must be a GeoJSON Feature`);
  assertRecord(input.properties, `${config.name} boundary properties`);
  if (input.properties.id !== config.id || (config.boundaryVersion !== undefined && input.properties.boundaryVersion !== config.boundaryVersion)) {
    throw new Error(`${config.name} boundary identity or version does not match the pack`);
  }
  return { type: "Feature", geometry: assertValidAreaGeometry(input.geometry, `${config.name} boundary`) };
}

export function regionalDataVersion(
  config: RegionalPackDefinition,
  boundaryContents: string,
  searchRegionContents: string,
  snapshots: readonly SourceSnapshot[],
  adapterVersions: readonly string[],
  metricVersions: readonly string[],
): string {
  const hash = createHash("sha256");
  hash.update(boundaryContents);
  hash.update(searchRegionContents);
  hash.update(`topology\0${CLOSED_ROUTE_TOPOLOGY_ALGORITHM_VERSION}\n`);
  if (config.fingerprintFormat === "joined-v1") {
    hash.update(config.compilerVersion);
    hash.update(adapterVersions.join("+"));
    hash.update(metricVersions.join("+"));
    for (const fingerprint of snapshots.map(({ id, version, contentHash, license }) =>
      `${id}\0${version}\0${contentHash}\0${license}`).sort()) hash.update(`${fingerprint}\n`);
  } else {
    hash.update(`${config.compilerVersion}\n`);
    for (const version of [...adapterVersions].sort()) hash.update(`adapter\0${version}\n`);
    for (const version of [...metricVersions].sort()) hash.update(`metric\0${version}\n`);
    for (const snapshot of [...snapshots].sort((first, second) => first.id.localeCompare(second.id))) {
      hash.update(`${snapshot.id}\0${snapshot.version}\0${snapshot.contentHash}\0${snapshot.license}\n`);
    }
  }
  return `${config.dataVersionPrefix}-${hash.digest("hex").slice(0, 16)}`;
}

export function createRegionalPackSeed(input: {
  config: RegionalPackDefinition;
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
    dataVersion: regionalDataVersion(
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
      officialAccess: Boolean(input.config.entrances),
      namedAreas: true,
      closedRouteTopology: true,
      batchSearchRegions: true,
      elevationProfiles: true,
      portalAccessPoints: true,
    },
    closedRouteTopology: {
      runtimeMode: "reachable-graph-fallback",
      algorithmVersion: CLOSED_ROUTE_TOPOLOGY_ALGORITHM_VERSION,
      policyVersion: "penalized-closed-route-search-v1",
      profiles: ["known", "inclusive"],
    },
    fieldConfidence: { topology: "high", access: "medium", elevation: "high" },
  };
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
  const wayCounts = { trail: 0, "service-road": 0, street: 0, sidewalk: 0 };
  for (const way of input.ways) if (way.edgeClass) wayCounts[way.edgeClass] += 1;
  return {
    schemaVersion: "2",
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
      trailWayCount: wayCounts["trail"],
      serviceRoadWayCount: wayCounts["service-road"],
      streetWayCount: wayCounts["street"],
      sidewalkWayCount: wayCounts["sidewalk"],
      portalEvidenceCount: input.portalEvidence?.length ?? 0,
      strippedNodeCount: input.nodes.length - published.nodes.length,
      strippedWayCount: input.ways.length - published.ways.length,
    },
  };
}

/** Restrictions precede portal derivation; entrance evidence can only label those portals. */
export function prepareRegionalPortals(input: {
  topology: NormalizedTopology;
  boundary: AreaGeometry;
  restrictions?: Awaited<ReturnType<typeof readCuratedAccessFile>>;
  entrances?: PreparedRegionalEntrances;
  checkPortals?: RegionalPackDefinition["checkPortals"];
}) {
  const restricted = input.restrictions
    ? applyCuratedAccessRestrictions(input.topology, input.restrictions.snapshot.id, input.restrictions.restrictions)
    : input.topology;
  const portals = deriveTrailheadPortals(restricted);
  const overlaid = input.entrances
    ? applyOfficialEntranceOverlayWithReport(portals, input.entrances.evidence)
    : { topology: portals, report: undefined };
  const topology = stripPortalBuildContext(overlaid.topology);
  const report = {
    ...portalReport(input.topology, overlaid.topology, topology, input.boundary),
    ...(input.restrictions ? { restrictions: {
      sourceId: input.restrictions.snapshot.id,
      appliedCount: input.restrictions.restrictions.length,
      targetExternalIds: input.restrictions.restrictions.map(({ externalId }) => externalId),
    } } : {}),
    ...(input.entrances ? { entranceOverlay: { sourceId: input.entrances.snapshot.id, ...overlaid.report } } : {}),
    ...(input.checkPortals ? { regionalChecks: input.checkPortals(topology, input.boundary) } : {}),
  };
  return { topology, report };
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
export function createRegionalPackBuilder(config: RegionalPackDefinition) {
  return async function buildDefinedRegionalPack(
    options: RegionalPackBuildOptions,
  ) {
    reportBuildProgress(options, 1);
    const boundaryPath = path.join(config.regionRoot, "boundary.geojson");
    const searchRegionPath = path.join(config.regionRoot, "search-regions.json");
    const [boundaryContents, searchRegionContents, osmConfig, elevationConfig, officialTrailConfig, officialTrailPolicy, restrictions] = await Promise.all([
      readFile(boundaryPath, "utf8"),
      readFile(searchRegionPath, "utf8"),
      readOsmSourceConfig(path.join(config.regionRoot, "osm-source.json")),
      readElevationSourceConfig(path.join(config.regionRoot, "elevation-source.json")),
      config.officialTrails ? readOfficialTrailSourceConfig(config.officialTrails.sourceConfigPath) : Promise.resolve(null),
      config.officialTrails ? readOfficialTrailConflationPolicy(config.officialTrails.conflationPolicyPath) : Promise.resolve(null),
      config.restrictions ? readCuratedAccessFile(path.join(config.regionRoot, "access-restrictions.json"), config.restrictions.contentHash) : undefined,
    ]);
    const boundary = parseRegionalBoundary(config, boundaryContents);
    const searchRegions = searchRegionInputSchema.parse(JSON.parse(searchRegionContents));

    await Promise.all([validateOsmPrerequisites(), validateUvRasterioPrerequisites()]);
    reportBuildProgress(options, 2, options.refresh ? "Refresh pinned source snapshots" : undefined);
    // Validate regional entrance sources before starting the large common downloads.
    const entrances = await config.entrances?.(options);
    const onDownload: CacheDownloadOptions["onProgress"] = options.onProgress ? ({ fileName, receivedBytes, totalBytes, state }) => {
      const amount = `${(receivedBytes / 1e6).toFixed(1)}${totalBytes ? ` / ${(totalBytes / 1e6).toFixed(1)}` : ""} MB`;
      const status = state === "downloading" && totalBytes ? `${Math.floor(100 * receivedBytes / totalBytes)}%` : state;
      reportBuildProgress(options, 2, undefined, `${fileName}: ${amount} (${status})`);
    } : undefined;
    const [osmSnapshot, dem, officialTrailSnapshot] = await Promise.all([
      options.refresh
        ? refreshPinnedOsmSnapshot(options.sourceCacheRoot, osmConfig, undefined, onDownload).then(({ snapshot }) => snapshot)
        : readPinnedOsmSnapshot(options.sourceCacheRoot, osmConfig),
      options.refresh
        ? refreshPinnedThreeDepCollection(options.sourceCacheRoot, elevationConfig, undefined, onDownload)
        : readPinnedThreeDepCollection(options.sourceCacheRoot, elevationConfig),
      officialTrailConfig
        ? options.refresh
          ? refreshPinnedOfficialTrailSnapshot(options.sourceCacheRoot, officialTrailConfig, undefined, onDownload).then(({ snapshot }) => snapshot)
          : readPinnedOfficialTrailSnapshot(options.sourceCacheRoot, officialTrailConfig)
        : Promise.resolve(null),
    ]);

    const namedAreaAdapter = new OsmPbfNamedAreaAdapter({
      boundaryPath,
      preparationRoot: path.join(options.preparationRoot, "osm"),
      namedAreaPreparationRoot: path.join(options.preparationRoot, "osm-named-areas"),
    });
    reportBuildProgress(options, 3);
    const sourceTopology = await prepareOsmTopology(osmSnapshot, {
      boundaryPath,
      preparationRoot: path.join(options.preparationRoot, "osm"),
    });
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
    const { topology: publishedTopology, report: portalAudit } = prepareRegionalPortals({
      topology: inputTopology, boundary: boundary.geometry, restrictions, entrances,
      checkPortals: config.checkPortals,
    });
    reportBuildProgress(options, 6);
    const buildings = await prepareOsmBuildings(osmSnapshot, {
      boundaryPath,
      preparationRoot: path.join(options.preparationRoot, "osm"),
    });
    reportBuildProgress(options, 7);
    const elevationSampler = new UvRasterioThreeDepElevationSampler(dem.collectionPath);
    const additionalSources = [
      ...(restrictions ? [restrictions.snapshot] : []),
      ...(entrances ? [entrances.snapshot] : []),
      ...(officialTrailSnapshot ? [officialTrailSnapshot] : []),
    ];
    const snapshots = [osmSnapshot, dem.snapshot, ...additionalSources];
    const adapterVersions = [
      OSM_TOPOLOGY_ADAPTER_VERSION,
      namedAreaAdapter.adapterVersion,
      ...(entrances ? [entrances.adapterVersion] : []),
      PORTAL_DERIVATION_VERSION,
      ...(officialTrailSnapshot ? [OFFICIAL_TRAIL_CONFLATION_VERSION, USGS_NATIONAL_DIGITAL_TRAILS_ADAPTER_VERSION] : []),
      ...(officialTrailPolicy ? [
        `official-trail-policy:${createHash("sha256").update(JSON.stringify(officialTrailPolicy)).digest("hex")}`,
      ] : []),
    ];
    const metricVersions = [elevationSampler.algorithmVersion, BUILDINGS_ADAPTER_VERSION];
    const seed = createRegionalPackSeed({
      config,
      boundary: boundary.geometry,
      boundaryContents,
      searchRegionContents,
      snapshots,
      adapterVersions,
      metricVersions,
    });
    reportBuildProgress(options, 8);
    const { pack, regionalAudit } = await compileAuditedPack({
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
      additionalSources,
      beforePublish: () => reportBuildProgress(options, 9),
      onProgress: options.onProgress ? (detail) => reportBuildProgress(options, 8, undefined, detail) : undefined,
    }, (artifact) => {
      if (officialTrailConflationAudit && officialTrailSnapshot) {
        addOfficialTrailPublicationCounts(officialTrailConflationAudit, artifact.databasePath, officialTrailSnapshot.id);
      }
      return {
        "portal-audit.json": portalAudit,
        ...(officialTrailConflationAudit ? { "official-trail-conflation-audit.json": officialTrailConflationAudit } : {}),
      };
    }, options.onProgress ? (detail) => reportBuildProgress(options, 9, undefined, detail) : undefined);
    reportBuildProgress(options, 10);
    return { pack, portalAudit, regionalAudit, ...(officialTrailConflationAudit ? { officialTrailConflationAudit } : {}) };
  };
}
