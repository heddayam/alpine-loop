import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { packManifestV1Schema, type PackManifestV1 } from "@/lib/contracts";
import type { AccessState } from "@/lib/graph/types";
import type {
  ElevationSampler,
  NormalizedAccessEvidence,
  OfficialAccessAdapter,
  SourceSnapshot,
  TopologySourceAdapter,
} from "./adapters";
import { reconcileAccess } from "./access";
import { calculateEdgeMetricsBatch } from "./metrics";
import { writePackDatabase } from "./sqlite-writer";
import type {
  CompiledEdge,
  Coordinate,
  NormalizedAccessPoint,
  NormalizedTopology,
  PackAudit,
  PackBuildResult,
} from "./types";

export type PackSeed = Omit<PackManifestV1, "builtAt" | "metricAlgorithmVersion" | "sources">;

export type CompilePackOptions = {
  outputRoot: string;
  seed: PackSeed;
  builtAt: string;
  topology: { adapter: TopologySourceAdapter<NormalizedTopology>; snapshot: SourceSnapshot };
  officialAccess: { adapter: OfficialAccessAdapter; snapshot: SourceSnapshot };
  additionalOfficialAccess?: Array<{ adapter: OfficialAccessAdapter; snapshot: SourceSnapshot }>;
  elevation: { sampler: ElevationSampler; snapshot: SourceSnapshot };
  beforePublish?: () => void | Promise<void>;
};

const EMPTY_ACCESS_COUNTS: Record<AccessState, number> = {
  public: 0,
  unknown: 0,
  private: 0,
  closed: 0,
  prohibited: 0,
};

async function collectTopology(
  adapter: TopologySourceAdapter<NormalizedTopology>,
  snapshot: SourceSnapshot,
): Promise<NormalizedTopology> {
  await adapter.validate(snapshot);
  const normalized: NormalizedTopology[] = [];
  for await (const result of adapter.normalize(snapshot)) normalized.push(result);
  if (normalized.length !== 1) throw new Error(`Topology adapter must produce exactly one graph, got ${normalized.length}`);
  return normalized[0];
}

function evidenceByExternalId(evidence: NormalizedAccessEvidence[]): Map<string, NormalizedAccessEvidence[]> {
  const result = new Map<string, NormalizedAccessEvidence[]>();
  for (const item of evidence) result.set(item.externalId, [...(result.get(item.externalId) ?? []), item]);
  return result;
}

async function compileGraph(
  topology: NormalizedTopology,
  evidence: NormalizedAccessEvidence[],
  sampler: ElevationSampler,
): Promise<{ nodes: NormalizedTopology["nodes"]; edges: CompiledEdge[]; accessPoints: NormalizedAccessPoint[]; conflicts: number }> {
  const byExternalId = evidenceByExternalId(evidence);
  const knownExternalIds = new Set([
    ...topology.ways.map(({ externalId }) => externalId),
    ...topology.accessPoints.map(({ externalId }) => externalId),
  ]);
  for (const externalId of byExternalId.keys()) {
    if (!knownExternalIds.has(externalId)) throw new Error(`Official access record targets unknown feature ${externalId}`);
  }

  const nodeElevations = await sampler.sample(topology.nodes.map(({ lon, lat }) => [lon, lat]));
  const nodes = topology.nodes.map((node, index) => ({ ...node, elevationM: nodeElevations[index] }));
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
  const segmentMetrics = await calculateEdgeMetricsBatch(segmentPlans.map(({ geometry }) => geometry), sampler);

  segmentPlans.forEach(({ way, segment, resolution, sourceRefs, geometry }, planIndex) => {
      const metrics = segmentMetrics[planIndex]!;
      const common = {
        lengthM: metrics.lengthM,
        maxElevationM: metrics.maxElevationM,
        maxSustainedGradePct: metrics.maxSustainedGradePct,
        accessState: resolution.state,
        sourceRefs,
        flags: [...way.flags, ...(way.name ? [`trail-name:${way.name}`] : [])],
      };
      edges.push({
        id: `${way.id}:${segment}:forward`,
        fromNode: way.nodeIds[segment],
        toNode: way.nodeIds[segment + 1],
        geometry,
        gainM: metrics.gainM,
        lossM: metrics.lossM,
        ...common,
      });
      if (way.bidirectional) {
        edges.push({
          id: `${way.id}:${segment}:reverse`,
          fromNode: way.nodeIds[segment + 1],
          toNode: way.nodeIds[segment],
          geometry: [...geometry].reverse(),
          gainM: metrics.lossM,
          lossM: metrics.gainM,
          ...common,
        });
      }
  });

  const accessPoints = topology.accessPoints.map((point) => {
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

  return { nodes, edges, accessPoints, conflicts };
}

function createAudit(
  seed: PackSeed,
  topology: NormalizedTopology,
  graph: Awaited<ReturnType<typeof compileGraph>>,
  sourceCount: number,
): PackAudit {
  const accessStateCounts = { ...EMPTY_ACCESS_COUNTS };
  for (const edge of graph.edges) accessStateCounts[edge.accessState] += 1;
  return {
    schemaVersion: "1",
    packId: seed.id,
    dataVersion: seed.dataVersion,
    nodeCount: graph.nodes.length,
    directedEdgeCount: graph.edges.length,
    accessPointCount: graph.accessPoints.length,
    sourceCount,
    rejectedWayCount: topology.rejectedWayCount,
    conflictCount: graph.conflicts,
    missingElevationNodeCount: graph.nodes.filter(({ elevationM }) => elevationM === null).length,
    missingElevationEdgeCount: graph.edges.filter(({ maxElevationM }) => maxElevationM === null).length,
    accessStateCounts,
  };
}

async function existingBuild(finalDirectory: string): Promise<PackBuildResult | null> {
  try {
    const manifestPath = path.join(finalDirectory, "manifest.json");
    const auditPath = path.join(finalDirectory, "audit.json");
    const databasePath = path.join(finalDirectory, "pack.sqlite");
    packManifestV1Schema.parse(JSON.parse(await readFile(manifestPath, "utf8")));
    const audit = JSON.parse(await readFile(auditPath, "utf8")) as PackAudit;
    await access(databasePath, constants.R_OK);
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
  const officialAccess = [options.officialAccess, ...(options.additionalOfficialAccess ?? [])];
  const sources = [options.topology.snapshot, ...officialAccess.map(({ snapshot }) => snapshot), options.elevation.snapshot];
  const manifest = packManifestV1Schema.parse({
    ...options.seed,
    builtAt: options.builtAt,
    metricAlgorithmVersion: options.elevation.sampler.algorithmVersion,
    sources: sources.map(manifestSource),
  });
  const packRoot = path.join(options.outputRoot, manifest.id);
  const finalDirectory = path.join(packRoot, manifest.dataVersion);
  await mkdir(packRoot, { recursive: true });
  const existing = await existingBuild(finalDirectory);
  if (existing) {
    await writeCurrentPointer(packRoot, manifest.dataVersion);
    return existing;
  }

  const stagingDirectory = path.join(packRoot, `.staging-${manifest.dataVersion}-${randomUUID()}`);
  await mkdir(stagingDirectory);
  try {
    const topology = await collectTopology(options.topology.adapter, options.topology.snapshot);
    const evidence = [] as NormalizedAccessEvidence[];
    for (const official of officialAccess) {
      await official.adapter.validate(official.snapshot);
      evidence.push(...await official.adapter.normalize(official.snapshot));
    }
    const graph = await compileGraph(topology, evidence, options.elevation.sampler);
    const audit = createAudit(options.seed, topology, graph, sources.length);
    const databasePath = path.join(stagingDirectory, "pack.sqlite");
    writePackDatabase(databasePath, {
      nodes: graph.nodes,
      edges: graph.edges,
      accessPoints: graph.accessPoints,
      sources,
      metadata: {
        schemaVersion: manifest.schemaVersion,
        packId: manifest.id,
        dataVersion: manifest.dataVersion,
        builtAt: manifest.builtAt,
        compilerVersion: manifest.compilerVersion,
        metricAlgorithmVersion: manifest.metricAlgorithmVersion,
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
