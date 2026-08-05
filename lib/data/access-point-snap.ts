import { distanceMeters } from "./metrics";
import type { NormalizedAccessPoint, NormalizedNode, NormalizedTopology } from "./types";

const DEFAULT_MAX_DISTANCE_M = 200;
const GRID_CELL_DEGREES = 0.002;

export type AccessPointSnapResult = {
  topology: NormalizedTopology;
  snappedCount: number;
  alreadyConnectedCount: number;
  deduplicatedCount: number;
  rejectedAccessPointIds: string[];
};

function cell(value: number): number {
  return Math.floor(value / GRID_CELL_DEGREES);
}

function key(lonCell: number, latCell: number): string {
  return `${lonCell}:${latCell}`;
}

/**
 * Connects independently mapped OSM trailheads and parking points to a nearby
 * retained hiking-network node. Points beyond the conservative tolerance are
 * rejected instead of manufacturing long connector edges.
 */
export function snapAccessPointsToTopology(
  input: NormalizedTopology,
  maxDistanceM = DEFAULT_MAX_DISTANCE_M,
): AccessPointSnapResult {
  if (!Number.isFinite(maxDistanceM) || maxDistanceM <= 0) {
    throw new Error("Access-point snap distance must be a positive finite number");
  }
  const networkNodeIds = new Set(input.ways.flatMap(({ nodeIds }) => nodeIds));
  const networkNodes = input.nodes.filter(({ id }) => networkNodeIds.has(id));
  const nodesById = new Map(input.nodes.map((node) => [node.id, node]));
  const grid = new Map<string, NormalizedNode[]>();
  for (const node of networkNodes) {
    const bucketKey = key(cell(node.lon), cell(node.lat));
    const bucket = grid.get(bucketKey) ?? [];
    bucket.push(node);
    grid.set(bucketKey, bucket);
  }
  for (const bucket of grid.values()) bucket.sort((first, second) => first.id.localeCompare(second.id));

  const searchRadius = Math.ceil(maxDistanceM / (GRID_CELL_DEGREES * 111_000 * 0.75));
  const accessPoints: NormalizedAccessPoint[] = [];
  const rejectedAccessPointIds: string[] = [];
  let snappedCount = 0;
  let alreadyConnectedCount = 0;
  for (const point of input.accessPoints) {
    if (networkNodeIds.has(point.nodeId)) {
      accessPoints.push(point);
      alreadyConnectedCount += 1;
      continue;
    }
    const sourceNode = nodesById.get(point.nodeId);
    if (!sourceNode) throw new Error(`Access point ${point.id} references missing node ${point.nodeId}`);
    let nearest: { node: NormalizedNode; distanceM: number } | null = null;
    const lonCell = cell(sourceNode.lon);
    const latCell = cell(sourceNode.lat);
    for (let lonOffset = -searchRadius; lonOffset <= searchRadius; lonOffset += 1) {
      for (let latOffset = -searchRadius; latOffset <= searchRadius; latOffset += 1) {
        for (const candidate of grid.get(key(lonCell + lonOffset, latCell + latOffset)) ?? []) {
          const distanceM = distanceMeters([sourceNode.lon, sourceNode.lat], [candidate.lon, candidate.lat]);
          if (distanceM > maxDistanceM) continue;
          if (!nearest || distanceM < nearest.distanceM
            || (distanceM === nearest.distanceM && candidate.id.localeCompare(nearest.node.id) < 0)) {
            nearest = { node: candidate, distanceM };
          }
        }
      }
    }
    if (!nearest) {
      rejectedAccessPointIds.push(point.id);
      continue;
    }
    accessPoints.push({ ...point, nodeId: nearest.node.id });
    snappedCount += 1;
  }

  const deduplicated: NormalizedAccessPoint[] = [];
  const genericByNodeAndKind = new Map<string, number>();
  const namedNodeAndKinds = new Set<string>();
  for (const point of accessPoints) {
    const key = `${point.nodeId}:${point.kind}`;
    const existingIndex = genericByNodeAndKind.get(key);
    const generic = point.name.startsWith("OSM ");
    if (generic) {
      if (namedNodeAndKinds.has(key) || existingIndex !== undefined) continue;
      deduplicated.push(point);
      genericByNodeAndKind.set(key, deduplicated.length - 1);
      continue;
    }
    namedNodeAndKinds.add(key);
    if (existingIndex !== undefined) {
      deduplicated[existingIndex] = point;
      genericByNodeAndKind.delete(key);
    } else {
      deduplicated.push(point);
    }
  }

  return {
    topology: { ...input, nodes: networkNodes, accessPoints: deduplicated },
    snappedCount,
    alreadyConnectedCount,
    deduplicatedCount: accessPoints.length - deduplicated.length,
    rejectedAccessPointIds: rejectedAccessPointIds.sort(),
  };
}
