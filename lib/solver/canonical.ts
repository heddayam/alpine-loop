import type { RouteType } from "@/lib/contracts";
import type { GraphEdge } from "@/lib/graph";

function stableHash(value: string): string {
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(36).padStart(13, "0");
}

function normalizedCoordinates(edge: GraphEdge): string {
  const forward = edge.coordinates.map(([lon, lat]) => `${lon.toFixed(7)},${lat.toFixed(7)}`).join(";");
  const reverse = [...edge.coordinates]
    .reverse()
    .map(([lon, lat]) => `${lon.toFixed(7)},${lat.toFixed(7)}`)
    .join(";");
  return forward < reverse ? forward : reverse;
}

export function undirectedEdgeKey(edge: GraphEdge): string {
  const endpoints = [edge.fromNodeId, edge.toNodeId].sort().join("~");
  return `${endpoints}|${normalizedCoordinates(edge)}`;
}

export function canonicalEdgeSequence(edges: readonly GraphEdge[]): string {
  const forward = edges.map(undirectedEdgeKey).join(">");
  const reverse = [...edges].reverse().map(undirectedEdgeKey).join(">");
  return forward < reverse ? forward : reverse;
}

export function canonicalRouteId(shape: RouteType, edges: readonly GraphEdge[]): string {
  return `${shape}_${stableHash(`${shape}|${canonicalEdgeSequence(edges)}`)}`;
}
