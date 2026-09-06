import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  packManifestV1Schema,
  packManifestV2Schema,
  packManifestV3Schema,
  packManifestV4Schema,
  packManifestV5Schema,
  packManifestV6Schema,
  type PackManifestV1,
  type PackManifestV2,
  type PackManifestV3,
  type PackManifestV4,
  type PackManifestV5,
  type PackManifestV6,
} from "@/lib/contracts";
import type { AccessState } from "@/lib/graph/types";
import type {
  ElevationSampler,
  NamedAreaSourceAdapter,
  NormalizedAccessEvidence,
  OfficialAccessAdapter,
  SourceSnapshot,
} from "./adapters";
import { reconcileAccess } from "./access";
import { calculateEdgeMetricsBatch, distanceMeters } from "./metrics";
import { areaGeometryBounds, edgeInsideCoverage, pointInArea, type AreaGeometry } from "./area-geometry";
import { validateAndSortNamedAreas } from "./named-areas";
import { validateSearchRegions, type SearchRegionInput } from "./search-regions";
import type { BuildingCentroid } from "./osm/buildings";
import { accessPointIsWildEnough, countNearbyBuildings } from "./wilderness";
import { writePackDatabase } from "./sqlite-writer";
import { buildClosedRouteTopology, topologySha256 } from "./topology-compiler";
import type {
  CompiledEdge,
  Coordinate,
  NormalizedAccessPoint,
  NormalizedNamedArea,
  NormalizedSearchRegion,
  NormalizedTopology,
  PackAudit,
  PackBuildResult,
} from "./types";

export type PackSeed =
  | Omit<PackManifestV1, "builtAt" | "metricAlgorithmVersion" | "sources">
  | Omit<PackManifestV2, "builtAt" | "metricAlgorithmVersion" | "sources">
  | Omit<PackManifestV3, "builtAt" | "metricAlgorithmVersion" | "sources">
  | Omit<PackManifestV4, "builtAt" | "metricAlgorithmVersion" | "sources">
  | Omit<PackManifestV5, "builtAt" | "metricAlgorithmVersion" | "sources">
  | Omit<PackManifestV6, "builtAt" | "metricAlgorithmVersion" | "sources">;

export type CompilePackOptions = {
  outputRoot: string;
  seed: PackSeed;
  builtAt: string;
  topology: { data: NormalizedTopology; snapshot: SourceSnapshot };
  officialAccess?: { adapter: OfficialAccessAdapter; snapshot: SourceSnapshot };
  additionalOfficialAccess?: Array<{ adapter: OfficialAccessAdapter; snapshot: SourceSnapshot }>;
  /** Sources already applied to a prepared topology, such as curated way removals. */
  additionalSources?: SourceSnapshot[];
  elevation: { sampler: ElevationSampler; snapshot: SourceSnapshot };
  /**
   * Building centroids for the pack region, from the same OSM snapshot as the
   * topology. Required: a pack with no building evidence cannot tell a
   * trailhead from a street corner, and must fail rather than guess.
   */
  buildings: readonly BuildingCentroid[];
  namedAreas?: { adapter: NamedAreaSourceAdapter; snapshot: SourceSnapshot };
  searchRegions?: SearchRegionInput;
  beforePublish?: () => void | Promise<void>;
};

const EMPTY_ACCESS_COUNTS: Record<AccessState, number> = {
  public: 0,
  unknown: 0,
  private: 0,
  closed: 0,
  prohibited: 0,
};

function evidenceByExternalId(evidence: NormalizedAccessEvidence[]): Map<string, NormalizedAccessEvidence[]> {
  const result = new Map<string, NormalizedAccessEvidence[]>();
  for (const item of evidence) result.set(item.externalId, [...(result.get(item.externalId) ?? []), item]);
  return result;
}

async function compileGraph(
  topology: NormalizedTopology,
  evidence: NormalizedAccessEvidence[],
  sampler: ElevationSampler,
  coverage?: AreaGeometry,
  trailOnlyElevation = false,
): Promise<{
  nodes: NormalizedTopology["nodes"];
  edges: CompiledEdge[];
  accessPoints: NormalizedAccessPoint[];
  conflicts: number;
  rejectedCoverageEdgeCount: number;
}> {
  const byExternalId = evidenceByExternalId(evidence);
  const knownExternalIds = new Set([
    ...topology.ways.map(({ externalId }) => externalId),
    ...topology.accessPoints.map(({ externalId }) => externalId),
  ]);
  for (const externalId of byExternalId.keys()) {
    if (!knownExternalIds.has(externalId)) throw new Error(`Official access record targets unknown feature ${externalId}`);
  }

  const elevationNodeIds = trailOnlyElevation
    ? new Set(topology.ways.filter(({ edgeClass }) => edgeClass === undefined || edgeClass === "trail").flatMap(({ nodeIds }) => nodeIds))
    : new Set(topology.nodes.map(({ id }) => id));
  const elevationNodes = topology.nodes.filter(({ id }) => elevationNodeIds.has(id));
  const sampledElevations = await sampler.sample(elevationNodes.map(({ lon, lat }) => [lon, lat]));
  const elevationByNodeId = new Map(elevationNodes.map((node, index) => [node.id, sampledElevations[index] ?? null]));
  const nodes = topology.nodes.map((node) => ({ ...node, elevationM: elevationByNodeId.get(node.id) ?? null }));
  let conflicts = 0;
  const edges: CompiledEdge[] = [];
  const segmentPlans = topology.ways.flatMap((way) => {
    const official = byExternalId.get(way.externalId) ?? [];
    const resolution = reconcileAccess(way.accessState, official.map(({ accessState }) => accessState));
    if (resolution.conflict) conflicts += 1;
    const sourceRefs = [...new Set([...way.sourceRefs, ...official.map(({ sourceId }) => sourceId)])];
    return Array.from({ length: way.nodeIds.length - 1 }, (_, segment) => ({
      way,
      segment,
      resolution,
      sourceRefs,
      geometry: [way.coordinates[segment], way.coordinates[segment + 1]] as [Coordinate, Coordinate],
    }));
  });
  let rejectedCoverageEdgeCount = 0;
  const retainedSegmentPlans = coverage ? segmentPlans.filter(({ geometry, way }) => {
    const accepted = edgeInsideCoverage({ geometry }, coverage);
    if (!accepted) rejectedCoverageEdgeCount += way.bidirectional ? 2 : 1;
    return accepted;
  }) : segmentPlans;
  const trailSegmentPlans = retainedSegmentPlans.filter(({ way }) => way.edgeClass === undefined || way.edgeClass === "trail");
  const trailSegmentMetrics = await calculateEdgeMetricsBatch(trailSegmentPlans.map(({ geometry }) => geometry), sampler);
  let trailMetricIndex = 0;

  retainedSegmentPlans.forEach(({ way, segment, resolution, sourceRefs, geometry }) => {
      const trail = way.edgeClass === undefined || way.edgeClass === "trail";
      const metrics = trail ? trailSegmentMetrics[trailMetricIndex++]! : {
        lengthM: distanceMeters(geometry[0], geometry[1]),
        gainM: null,
        lossM: null,
        maxElevationM: null,
        maxSustainedGradePct: null,
        elevationProfile: null,
      };
      const common = {
        lengthM: metrics.lengthM,
        maxElevationM: metrics.maxElevationM,
        maxSustainedGradePct: metrics.maxSustainedGradePct,
        accessState: resolution.state,
        edgeClass: way.edgeClass ?? "trail",
        sourceRefs,
        flags: [...way.flags, ...(way.name ? [`trail-name:${way.name}`] : [])],
      };
      edges.push({
        id: `${way.id}:${segment}:forward`,
        stablePhysicalId: `${way.id}:${segment}`,
        fromNode: way.nodeIds[segment],
        toNode: way.nodeIds[segment + 1],
        geometry,
        gainM: metrics.gainM,
        lossM: metrics.lossM,
        elevationProfile: metrics.elevationProfile,
        ...common,
      });
      if (way.bidirectional) {
        edges.push({
          id: `${way.id}:${segment}:reverse`,
          stablePhysicalId: `${way.id}:${segment}`,
          fromNode: way.nodeIds[segment + 1],
          toNode: way.nodeIds[segment],
          geometry: [...geometry].reverse(),
          gainM: metrics.lossM,
          lossM: metrics.gainM,
          elevationProfile: metrics.elevationProfile?.map(({ distanceMeters, elevationMeters }) => ({
            distanceMeters: metrics.lengthM - distanceMeters,
            elevationMeters,
          })).reverse() ?? null,
          ...common,
        });
      }
  });

  let accessPoints = topology.accessPoints.map((point) => {
    const official = byExternalId.get(point.externalId) ?? [];
    const resolution = reconcileAccess(point.accessState, official.map(({ accessState }) => accessState));
    if (resolution.conflict) conflicts += 1;
    const confidence = official.reduce<NormalizedAccessPoint["confidence"]>(
      (best, item) => item.confidence === "high" || (item.confidence === "medium" && best === "low")
        ? item.confidence
        : best,
      point.confidence,
    );
    return {
      ...point,
      accessState: resolution.state,
      confidence,
      sourceRefs: [...new Set([...point.sourceRefs, ...official.map(({ sourceId }) => sourceId)])],
    };
  });

  if (coverage) {
    const incidentNodeIds = new Set(edges.flatMap((edge) => [edge.fromNode, edge.toNode]));
    const retainedNodes = nodes.filter(({ id }) => incidentNodeIds.has(id));
    const nodeById = new Map(retainedNodes.map((node) => [node.id, node]));
    accessPoints = accessPoints.filter((point) => {
      const node = nodeById.get(point.nodeId);
      return node !== undefined && pointInArea([node.lon, node.lat], coverage);
    });
    return { nodes: retainedNodes, edges, accessPoints, conflicts, rejectedCoverageEdgeCount };
  }
  return { nodes, edges, accessPoints, conflicts, rejectedCoverageEdgeCount };
}

function weakConnectivity(
  nodes: readonly NormalizedTopology["nodes"][number][],
  edges: readonly CompiledEdge[],
  acceptedStates: ReadonlySet<AccessState>,
): Map<string, number> {
  const adjacency = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (!acceptedStates.has(edge.accessState)) continue;
    const from = adjacency.get(edge.fromNode) ?? new Set<string>();
    const to = adjacency.get(edge.toNode) ?? new Set<string>();
    from.add(edge.toNode);
    to.add(edge.fromNode);
    adjacency.set(edge.fromNode, from);
    adjacency.set(edge.toNode, to);
  }
  const result = new Map<string, number>();
  const visited = new Set<string>();
  for (const node of nodes) {
    if (visited.has(node.id) || !adjacency.has(node.id)) continue;
    const component: string[] = [];
    const pending = [node.id];
    visited.add(node.id);
    while (pending.length) {
      const id = pending.pop()!;
      component.push(id);
      for (const neighbor of adjacency.get(id) ?? []) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          pending.push(neighbor);
        }
      }
    }
    for (const id of component) result.set(id, component.length);
  }
  return result;
}

function addAccessRankingFields(
  nodes: readonly NormalizedTopology["nodes"][number][],
  edges: readonly CompiledEdge[],
  accessPoints: readonly NormalizedAccessPoint[],
): NormalizedAccessPoint[] {
  const knownStates = new Set<AccessState>(["public"]);
  const inclusiveStates = new Set<AccessState>(["public", "unknown"]);
  const knownConnectivity = weakConnectivity(nodes, edges, knownStates);
  const inclusiveConnectivity = weakConnectivity(nodes, edges, inclusiveStates);
  const outDegrees = (states: ReadonlySet<AccessState>): Map<string, number> => {
    const result = new Map<string, number>();
    for (const edge of edges) if (states.has(edge.accessState)) result.set(edge.fromNode, (result.get(edge.fromNode) ?? 0) + 1);
    return result;
  };
  const knownOutDegree = outDegrees(knownStates);
  const inclusiveOutDegree = outDegrees(inclusiveStates);
  return accessPoints.map((point) => ({
    ...point,
    knownConnectivity: knownConnectivity.get(point.nodeId) ?? 0,
    inclusiveConnectivity: inclusiveConnectivity.get(point.nodeId) ?? 0,
    knownOutDegree: knownOutDegree.get(point.nodeId) ?? 0,
    inclusiveOutDegree: inclusiveOutDegree.get(point.nodeId) ?? 0,
  }));
}

/**
 * Attaches the nearby building count, measured at the access point's snapped
 * network node so it describes the same place the map draws.
 */
function addNearbyBuildingCounts(
  nodes: readonly NormalizedTopology["nodes"][number][],
  accessPoints: readonly NormalizedAccessPoint[],
  buildings: readonly BuildingCentroid[],
): NormalizedAccessPoint[] {
  const counts = countNearbyBuildings(buildings, accessPoints, nodes);
  return accessPoints.map((point) => ({
    ...point,
    nearbyBuildingCount: counts.get(point.id) ?? 0,
  }));
}

function createAudit(
  seed: PackSeed,
  topology: NormalizedTopology,
  graph: Awaited<ReturnType<typeof compileGraph>> & {
    namedAreas: NormalizedNamedArea[];
    searchRegions: NormalizedSearchRegion[];
  },
  sourceCount: number,
): PackAudit {
  const accessStateCounts = { ...EMPTY_ACCESS_COUNTS };
  for (const edge of graph.edges) accessStateCounts[edge.accessState] += 1;
  const elevationEdges = seed.schemaVersion === "6"
    ? graph.edges.filter(({ edgeClass }) => edgeClass === "trail")
    : graph.edges;
  const elevationNodeIds = seed.schemaVersion === "6"
    ? new Set(elevationEdges.flatMap(({ fromNode, toNode }) => [fromNode, toNode]))
    : new Set(graph.nodes.map(({ id }) => id));
  return {
    schemaVersion: seed.schemaVersion,
    packId: seed.id,
    dataVersion: seed.dataVersion,
    nodeCount: graph.nodes.length,
    directedEdgeCount: graph.edges.length,
    accessPointCount: graph.accessPoints.length,
    sourceCount,
    rejectedWayCount: topology.rejectedWayCount,
    conflictCount: graph.conflicts,
    missingElevationNodeCount: graph.nodes.filter(({ id, elevationM }) => elevationNodeIds.has(id) && elevationM === null).length,
    missingElevationEdgeCount: elevationEdges.filter(({ maxElevationM }) => maxElevationM === null).length,
    accessStateCounts,
    ...(seed.schemaVersion !== "1" ? {
      namedAreaCount: graph.namedAreas.length,
      rejectedCoverageEdgeCount: graph.rejectedCoverageEdgeCount,
    } : {}),
    ...(seed.schemaVersion === "4" || seed.schemaVersion === "5" || seed.schemaVersion === "6" ? { searchRegionCount: graph.searchRegions.length } : {}),
    // Surfaced so an implausible building join is obvious in the audit rather
    // than quietly filtering every access point out at query time.
    builtUpAccessPointCount: graph.accessPoints.filter(
      ({ nearbyBuildingCount }) => !accessPointIsWildEnough({ nearbyBuildingCount: nearbyBuildingCount ?? 0 }),
    ).length,
  };
}

async function existingBuild(finalDirectory: string, schemaVersion: "1" | "2" | "3" | "4" | "5" | "6"): Promise<PackBuildResult | null> {
  try {
    const manifestPath = path.join(finalDirectory, "manifest.json");
    const auditPath = path.join(finalDirectory, "audit.json");
    const databasePath = path.join(finalDirectory, "pack.sqlite");
    const manifest = (schemaVersion === "1" ? packManifestV1Schema
      : schemaVersion === "2" ? packManifestV2Schema
      : schemaVersion === "3" ? packManifestV3Schema : schemaVersion === "4" ? packManifestV4Schema
        : schemaVersion === "5" ? packManifestV5Schema : packManifestV6Schema)
      .parse(JSON.parse(await readFile(manifestPath, "utf8")));
    if (manifest.schemaVersion !== schemaVersion) return null;
    const audit = JSON.parse(await readFile(auditPath, "utf8")) as PackAudit;
    await access(databasePath, constants.R_OK);
    if (manifest.schemaVersion === "3" || manifest.schemaVersion === "4" || manifest.schemaVersion === "5" || manifest.schemaVersion === "6") {
      const database = new DatabaseSync(databasePath, { readOnly: true });
      try {
        const metadata = database.prepare("SELECT value FROM metadata WHERE key='topologyContentHash'").get() as { value?: string } | undefined;
        const profiles = database.prepare("SELECT profile, content_hash FROM topology_profiles ORDER BY profile DESC").all() as Array<{ profile: string; content_hash: string }>;
        const expected = topologySha256({
          runtimeMode: manifest.closedRouteTopology.runtimeMode,
          algorithmVersion: manifest.closedRouteTopology.algorithmVersion,
          policyVersion: manifest.closedRouteTopology.policyVersion,
          profiles: profiles.map(({ profile, content_hash: contentHash }) => ({ profile, contentHash })),
        });
        if (profiles.map(({ profile }) => profile).join(",") !== "known,inclusive" || metadata?.value !== expected || audit.topologyContentHash !== expected) return null;
        if (manifest.schemaVersion === "4" || manifest.schemaVersion === "5" || manifest.schemaVersion === "6") {
          const regions = database.prepare("SELECT display_order FROM search_regions ORDER BY display_order")
            .all() as Array<{ display_order: number }>;
          if (regions.length === 0 || regions.length !== audit.searchRegionCount
            || regions.some(({ display_order: displayOrder }, index) => displayOrder !== index)) return null;
        }
      } finally { database.close(); }
    }
    return { packDirectory: finalDirectory, manifestPath, auditPath, databasePath, audit, reusedExisting: true };
  } catch {
    return null;
  }
}

async function writeCurrentPointer(packRoot: string, dataVersion: string): Promise<void> {
  const temporary = path.join(packRoot, `.current-${randomUUID()}.json`);
  await writeFile(temporary, `${JSON.stringify({ dataVersion, path: `${dataVersion}/manifest.json` }, null, 2)}\n`);
  await rename(temporary, path.join(packRoot, "current.json"));
}

async function pruneOldPackVersions(packRoot: string, packId: string, currentDataVersion: string): Promise<void> {
  const entries = await readdir(packRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === currentDataVersion || entry.name.startsWith(".")) continue;
    const directory = path.join(packRoot, entry.name);
    let candidate: unknown;
    try {
      candidate = JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8"));
    } catch {
      continue;
    }
    if (!candidate || typeof candidate !== "object") continue;
    const manifest = candidate as { id?: unknown; dataVersion?: unknown };
    if (manifest.id !== packId || manifest.dataVersion !== entry.name) continue;
    await rm(directory, { recursive: true });
  }
}

function manifestSource(source: SourceSnapshot): Omit<SourceSnapshot, "localPath"> {
  return {
    id: source.id,
    authority: source.authority,
    dataset: source.dataset,
    version: source.version,
    retrievedAt: source.retrievedAt,
    url: source.url,
    license: source.license,
    contentHash: source.contentHash,
  };
}

export async function compilePack(options: CompilePackOptions): Promise<PackBuildResult> {
  if (options.seed.schemaVersion !== "1" && !options.namedAreas) throw new Error(`Schema ${options.seed.schemaVersion} pack requires a named-area adapter`);
  if (options.seed.schemaVersion === "1" && options.namedAreas) throw new Error("Schema 1 pack cannot include named areas");
  if ((options.seed.schemaVersion === "4" || options.seed.schemaVersion === "5" || options.seed.schemaVersion === "6") && !options.searchRegions) throw new Error(`Schema ${options.seed.schemaVersion} pack requires reviewed search regions`);
  if (options.seed.schemaVersion !== "4" && options.seed.schemaVersion !== "5" && options.seed.schemaVersion !== "6" && options.searchRegions) throw new Error(`Schema ${options.seed.schemaVersion} pack cannot include search regions`);
  const officialAccess = [...(options.officialAccess ? [options.officialAccess] : []), ...(options.additionalOfficialAccess ?? [])];
  const sourceCandidates = [
    options.topology.snapshot,
    ...(options.additionalSources ?? []),
    ...officialAccess.map(({ snapshot }) => snapshot),
    options.elevation.snapshot,
    ...(options.namedAreas ? [options.namedAreas.snapshot] : []),
  ];
  const sources = [...new Map(sourceCandidates.map((source) => [source.id, source])).values()];
  const manifestSchema = options.seed.schemaVersion === "1" ? packManifestV1Schema
    : options.seed.schemaVersion === "2" ? packManifestV2Schema
    : options.seed.schemaVersion === "3" ? packManifestV3Schema : options.seed.schemaVersion === "4" ? packManifestV4Schema
      : options.seed.schemaVersion === "5" ? packManifestV5Schema : packManifestV6Schema;
  const manifest = manifestSchema.parse({
    ...options.seed,
    builtAt: options.builtAt,
    metricAlgorithmVersion: options.elevation.sampler.algorithmVersion,
    sources: sources.map(manifestSource),
  });
  const packRoot = path.join(options.outputRoot, manifest.id);
  const finalDirectory = path.join(packRoot, manifest.dataVersion);
  await mkdir(packRoot, { recursive: true });
  const existing = await existingBuild(finalDirectory, manifest.schemaVersion);
  if (existing) {
    await writeCurrentPointer(packRoot, manifest.dataVersion);
    return existing;
  }

  const stagingDirectory = path.join(packRoot, `.staging-${manifest.dataVersion}-${randomUUID()}`);
  await mkdir(stagingDirectory);
  try {
    const topology = options.topology.data;
    const evidence = [] as NormalizedAccessEvidence[];
    for (const official of officialAccess) {
      await official.adapter.validate(official.snapshot);
      evidence.push(...await official.adapter.normalize(official.snapshot));
    }
    const compiledGraph = await compileGraph(
      topology,
      evidence,
      options.elevation.sampler,
      manifest.schemaVersion !== "1" ? manifest.coverage.boundary : undefined,
      manifest.schemaVersion === "6",
    );
    let namedAreas: NormalizedNamedArea[] = [];
    if (manifest.schemaVersion !== "1") {
      await options.namedAreas!.adapter.validate(options.namedAreas!.snapshot);
      const providedAreas = await options.namedAreas!.adapter.normalize(options.namedAreas!.snapshot);
      namedAreas = validateAndSortNamedAreas([{
        id: `pack:${manifest.id}`,
        name: manifest.name,
        kind: "pack",
        aliases: [],
        bbox: areaGeometryBounds(manifest.coverage.boundary),
        geometry: manifest.coverage.boundary,
        sourceIds: [options.topology.snapshot.id],
      }, ...providedAreas], new Set(sources.map(({ id }) => id)));
    }
    const searchRegions = manifest.schemaVersion === "4" || manifest.schemaVersion === "5" || manifest.schemaVersion === "6"
      ? validateSearchRegions(options.searchRegions!, namedAreas)
      : [];
    const rankedAccessPoints = manifest.schemaVersion !== "1"
      ? addAccessRankingFields(compiledGraph.nodes, compiledGraph.edges, compiledGraph.accessPoints)
      : compiledGraph.accessPoints;
    const graph = {
      ...compiledGraph,
      accessPoints: addNearbyBuildingCounts(compiledGraph.nodes, rankedAccessPoints, options.buildings),
      namedAreas,
      searchRegions,
    };
    const closedRouteTopology = manifest.schemaVersion === "3" || manifest.schemaVersion === "4" || manifest.schemaVersion === "5" || manifest.schemaVersion === "6"
      ? buildClosedRouteTopology(graph.nodes, graph.edges, graph.accessPoints, {
          builtAt: manifest.builtAt,
          runtimeMode: manifest.closedRouteTopology.runtimeMode,
          algorithmVersion: manifest.closedRouteTopology.algorithmVersion,
          policyVersion: manifest.closedRouteTopology.policyVersion,
        })
      : undefined;
    const audit = createAudit(options.seed, topology, graph, sources.length);
    if (closedRouteTopology) {
      audit.topologyContentHash = closedRouteTopology.contentHash;
      audit.topologyProfiles = closedRouteTopology.profiles.map((profile) => ({
        profile: profile.profile,
        contentHash: profile.contentHash,
        nodeCount: profile.nodeCount,
        physicalEdgeCount: profile.physicalEdgeCount,
        decisionNodeCount: profile.decisionNodeCount,
        decisionEdgeCount: profile.decisionEdgeCount,
        blockCount: profile.blocks.length,
        cycleBlockCount: profile.blocks.filter(({ cycleRank }) => cycleRank > 0).length,
        networkCount: profile.networks.length,
        feasibleAccessPointCount: profile.accessTopology.filter(({ canReachCycle }) => canReachCycle).length,
        noCycleAccessPointCount: profile.accessTopology.filter(({ canReachCycle }) => !canReachCycle).length,
      }));
    }
    const databasePath = path.join(stagingDirectory, "pack.sqlite");
    writePackDatabase(databasePath, {
      nodes: graph.nodes,
      edges: graph.edges,
      accessPoints: graph.accessPoints,
      ...(manifest.schemaVersion !== "1" ? { namedAreas: graph.namedAreas } : {}),
      ...(manifest.schemaVersion === "4" || manifest.schemaVersion === "5" || manifest.schemaVersion === "6" ? { searchRegions: graph.searchRegions } : {}),
      ...(closedRouteTopology ? { closedRouteTopology } : {}),
      sources,
      metadata: {
        schemaVersion: manifest.schemaVersion,
        packId: manifest.id,
        dataVersion: manifest.dataVersion,
        builtAt: manifest.builtAt,
        compilerVersion: manifest.compilerVersion,
        metricAlgorithmVersion: manifest.metricAlgorithmVersion,
        ...(closedRouteTopology ? { topologyContentHash: closedRouteTopology.contentHash } : {}),
      },
    });
    await writeFile(path.join(stagingDirectory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    await writeFile(path.join(stagingDirectory, "audit.json"), `${JSON.stringify(audit, null, 2)}\n`);

    const verificationDatabase = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const row = verificationDatabase.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
      if (row.integrity_check !== "ok") throw new Error(`Pack validation failed: ${row.integrity_check}`);
    } finally {
      verificationDatabase.close();
    }
    await options.beforePublish?.();
    await rename(stagingDirectory, finalDirectory);
    await writeCurrentPointer(packRoot, manifest.dataVersion);
    await pruneOldPackVersions(packRoot, manifest.id, manifest.dataVersion);
    return {
      packDirectory: finalDirectory,
      databasePath: path.join(finalDirectory, "pack.sqlite"),
      manifestPath: path.join(finalDirectory, "manifest.json"),
      auditPath: path.join(finalDirectory, "audit.json"),
      audit,
      reusedExisting: false,
    };
  } catch (error) {
    await rm(stagingDirectory, { recursive: true, force: true });
    throw error;
  }
}
