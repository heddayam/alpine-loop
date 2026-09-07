import type { AccessState } from "@/lib/graph/types";
import type { RegionalPackAudit, RegionalPackAuditInput } from "./types";

const ACCESS_COUNTS: Record<AccessState, number> = { public: 0, unknown: 0, private: 0, closed: 0, prohibited: 0 };
const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;

function topology(input: RegionalPackAuditInput): RegionalPackAudit["topology"] {
  const neighbours = new Map(input.nodes.map(({ id }) => [id, new Set<string>()]));
  for (const edge of input.edges) {
    neighbours.get(edge.fromNode)?.add(edge.toNode);
    neighbours.get(edge.toNode)?.add(edge.fromNode);
  }
  const visited = new Set<string>();
  const sizes: number[] = [];
  for (const node of input.nodes) {
    if (visited.has(node.id)) continue;
    let size = 0;
    const queue = [node.id];
    visited.add(node.id);
    while (queue.length) {
      const current = queue.pop()!;
      size += 1;
      for (const next of neighbours.get(current) ?? []) {
        if (!visited.has(next)) { visited.add(next); queue.push(next); }
      }
    }
    sizes.push(size);
  }
  const largest = sizes.reduce((maximum, size) => Math.max(maximum, size), 0);
  return {
    componentCount: sizes.length,
    isolatedNodeCount: [...neighbours.values()].filter((items) => items.size === 0).length,
    largestComponentNodeCount: largest,
    largestComponentFraction: input.nodes.length ? largest / input.nodes.length : 0,
  };
}
function metricIsImplausible(edge: RegionalPackAuditInput["edges"][number]): boolean {
  return !Number.isFinite(edge.lengthM) || edge.lengthM <= 0 || edge.lengthM > 100_000
    || (edge.gainM !== null && (!Number.isFinite(edge.gainM) || edge.gainM < 0 || edge.gainM > 10_000))
    || (edge.lossM !== null && (!Number.isFinite(edge.lossM) || edge.lossM < 0 || edge.lossM > 10_000))
    || (edge.maxElevationM !== null && (!Number.isFinite(edge.maxElevationM) || edge.maxElevationM < -500 || edge.maxElevationM > 5_000))
    || (edge.maxSustainedGradePct !== null && (!Number.isFinite(edge.maxSustainedGradePct) || edge.maxSustainedGradePct < 0 || edge.maxSustainedGradePct > 300));
}

export function auditRegionalPack(input: RegionalPackAuditInput): RegionalPackAudit {
  const sourceIds = new Set<string>();
  const errors: string[] = [];
  const warnings: string[] = [];
  for (const source of input.sources) {
    if (sourceIds.has(source.id)) errors.push(`Duplicate source ID ${source.id}`);
    sourceIds.add(source.id);
    if (!source.authority || !source.dataset || !source.version || !source.retrievedAt || !source.url) errors.push(`Source ${source.id} has incomplete provenance`);
    if (!source.license || !source.termsDecision) errors.push(`Source ${source.id} has no license/terms decision`);
    if (!HASH_PATTERN.test(source.contentHash)) errors.push(`Source ${source.id} has no valid content hash`);
  }

  const allRecords = [
    ...input.nodes.map((record) => ({ type: "node", ...record })),
    ...input.edges.map((record) => ({ type: "edge", ...record })),
    ...input.accessPoints.map((record) => ({ type: "access-point", ...record })),
  ];
  const unattributedRecordIds = allRecords.filter(({ sourceRefs }) => sourceRefs.length === 0).map(({ type, id }) => `${type}:${id}`);
  const unknownSourceReferenceRecordIds = allRecords
    .filter(({ sourceRefs }) => sourceRefs.some((id) => !sourceIds.has(id)))
    .map(({ type, id }) => `${type}:${id}`);
  if (unattributedRecordIds.length) errors.push(`${unattributedRecordIds.length} records have no source attribution`);
  if (unknownSourceReferenceRecordIds.length) errors.push(`${unknownSourceReferenceRecordIds.length} records reference unknown sources`);

  const accessStateCounts = { ...ACCESS_COUNTS };
  for (const edge of input.edges) accessStateCounts[edge.accessState] += 1;
  const topologyHealth = topology(input);
  if (topologyHealth.componentCount > 1) warnings.push(`Graph has ${topologyHealth.componentCount} disconnected components`);
  if (topologyHealth.isolatedNodeCount) errors.push(`Graph has ${topologyHealth.isolatedNodeCount} isolated nodes`);
  const implausibleMetricRecordIds = input.edges.filter(metricIsImplausible).map(({ id }) => id);
  if (implausibleMetricRecordIds.length) errors.push(`${implausibleMetricRecordIds.length} edges have implausible metrics`);
  const conflictRecordIds = [...new Set(input.conflictRecordIds ?? [])];
  if (conflictRecordIds.length) errors.push(`${conflictRecordIds.length} access conflicts require review`);
  const elevationEdges = input.edges.filter(({ edgeClass }) => edgeClass === "trail");
  const elevationNodeIds = new Set(elevationEdges.flatMap(({ fromNode, toNode }) => [fromNode, toNode]));
  const missingNodeCount = input.nodes.filter(({ id, elevationM }) => elevationNodeIds.has(id) && elevationM === null).length;
  const missingEdgeCount = elevationEdges.filter(({ maxElevationM }) => maxElevationM === null).length;
  if (missingNodeCount || missingEdgeCount) warnings.push(`Elevation is missing for ${missingNodeCount} nodes and ${missingEdgeCount} edges`);
  if (input.rejectedEdgeCount) warnings.push(`${input.rejectedEdgeCount} source edges were rejected`);

  return {
    schemaVersion: input.schemaVersion ?? "6",
    packId: input.packId,
    dataVersion: input.dataVersion,
    counts: {
      nodes: input.nodes.length,
      directedEdges: input.edges.length,
      accessPoints: input.accessPoints.length,
      sources: input.sources.length,
      rejectedEdges: input.rejectedEdgeCount,
      conflicts: conflictRecordIds.length,
    },
    accessStateCounts,
    topology: topologyHealth,
    elevation: { missingNodeCount, missingEdgeCount },
    implausibleMetricRecordIds,
    unattributedRecordIds,
    unknownSourceReferenceRecordIds,
    errors,
    warnings,
  };
}

export function assertPackAuditPassed(audit: RegionalPackAudit): void {
  if (audit.errors.length) throw new Error(`Pack audit failed:\n${audit.errors.join("\n")}`);
}
