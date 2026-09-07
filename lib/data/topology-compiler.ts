import { canonicalTopologyJson, topologySha256 } from "@/lib/graph/topology-hash";
import { CLOSED_ROUTE_TOPOLOGY_ALGORITHM_VERSION, CLOSED_ROUTE_TOPOLOGY_FORMAT_VERSION } from "@/lib/graph/closed-route-topology";
import type { TopologyProfile } from "@/lib/contracts";
import type { NormalizedAccessPoint, NormalizedNode, CompiledEdge, ClosedRouteTopologyBuild, TopologyProfileBuild } from "./types";

export { CLOSED_ROUTE_TOPOLOGY_FORMAT_VERSION } from "@/lib/graph/closed-route-topology";

type DenseEdge = CompiledEdge & { from: number; to: number; physicalEdgeKey: number };
type Physical = ClosedRouteTopologyBuild["physicalEdges"][number];

function geometryHash(edge: CompiledEdge): string {
  const forward = canonicalTopologyJson(edge.geometry);
  const reverse = canonicalTopologyJson([...edge.geometry].reverse());
  return topologySha256(forward < reverse ? forward : reverse);
}

function stronglyConnectedComponents(nodeCount: number, edges: readonly DenseEdge[]): number[] {
  const outgoing = Array.from({ length: nodeCount + 1 }, () => [] as number[]);
  const incoming = Array.from({ length: nodeCount + 1 }, () => [] as number[]);
  for (const edge of edges) { outgoing[edge.from]!.push(edge.to); incoming[edge.to]!.push(edge.from); }
  outgoing.forEach((items) => items.sort((a, b) => a - b));
  incoming.forEach((items) => items.sort((a, b) => a - b));
  const visited = new Uint8Array(nodeCount + 1);
  const order: number[] = [];
  for (let start = 1; start <= nodeCount; start += 1) {
    if (visited[start]) continue;
    visited[start] = 1;
    const stack = [{ node: start, index: 0 }];
    while (stack.length) {
      const frame = stack[stack.length - 1]!;
      const next = outgoing[frame.node]![frame.index++];
      if (next !== undefined) {
        if (!visited[next]) { visited[next] = 1; stack.push({ node: next, index: 0 }); }
      } else { order.push(frame.node); stack.pop(); }
    }
  }
  const component = Array(nodeCount + 1).fill(0) as number[];
  let id = 0;
  for (let index = order.length - 1; index >= 0; index -= 1) {
    const start = order[index]!;
    if (component[start]) continue;
    id += 1;
    component[start] = id;
    const stack = [start];
    while (stack.length) {
      const node = stack.pop()!;
      for (const next of incoming[node]!) if (!component[next]) { component[next] = id; stack.push(next); }
    }
  }
  return component;
}

// Only SCC-local physical edges can participate in a legal closed traversal.
// Iterative low-link traversal handles long stems, parallel edges and self-loops.
function cycleNodes(nodeCount: number, physical: readonly Physical[]): Set<number> {
  const adjacency = Array.from({ length: nodeCount + 1 }, () => [] as Physical[]);
  for (const edge of physical) {
    adjacency[edge.fromNodeKey]!.push(edge);
    if (edge.fromNodeKey !== edge.toNodeKey) adjacency[edge.toNodeKey]!.push(edge);
  }
  const discovery = new Int32Array(nodeCount + 1);
  const low = new Int32Array(nodeCount + 1);
  const bridges = new Set<number>();
  let time = 0;
  for (let root = 1; root <= nodeCount; root += 1) {
    if (discovery[root]) continue;
    discovery[root] = low[root] = ++time;
    const stack = [{ node: root, parent: 0, parentEdge: 0, index: 0 }];
    while (stack.length) {
      const frame = stack[stack.length - 1]!;
      const edge = adjacency[frame.node]![frame.index++];
      if (edge) {
        if (edge.physicalEdgeKey === frame.parentEdge) continue;
        const next = edge.fromNodeKey === frame.node ? edge.toNodeKey : edge.fromNodeKey;
        if (discovery[next]) low[frame.node] = Math.min(low[frame.node]!, discovery[next]!);
        else {
          discovery[next] = low[next] = ++time;
          stack.push({ node: next, parent: frame.node, parentEdge: edge.physicalEdgeKey, index: 0 });
        }
      } else {
        stack.pop();
        if (frame.parent) {
          if (low[frame.node]! > discovery[frame.parent]!) bridges.add(frame.parentEdge);
          low[frame.parent] = Math.min(low[frame.parent]!, low[frame.node]!);
        }
      }
    }
  }
  const result = new Set<number>();
  for (const edge of physical) if (!bridges.has(edge.physicalEdgeKey)) {
    result.add(edge.fromNodeKey); result.add(edge.toNodeKey);
  }
  return result;
}

function buildProfile(
  profile: TopologyProfile,
  nodeKeys: Map<string, number>,
  denseEdges: readonly DenseEdge[],
  physicalEdges: readonly Physical[],
  accessPoints: readonly NormalizedAccessPoint[],
  builtAt: string,
): TopologyProfileBuild {
  const edges = denseEdges.filter((edge) => (edge.edgeClass === undefined || edge.edgeClass === "trail")
    && (edge.accessState === "public" || (profile === "inclusive" && edge.accessState === "unknown")));
  const includedPhysicalKeys = new Set(edges.map(({ physicalEdgeKey }) => physicalEdgeKey));
  const physical = physicalEdges.filter(({ physicalEdgeKey }) => includedPhysicalKeys.has(physicalEdgeKey));
  const scc = stronglyConnectedComponents(nodeKeys.size, edges);
  const network = new Map<number, number>();
  for (let node = 1; node <= nodeKeys.size; node += 1) if (!network.has(scc[node]!)) network.set(scc[node]!, node);
  const seeds = cycleNodes(nodeKeys.size, physical.filter((edge) => scc[edge.fromNodeKey] === scc[edge.toNodeKey]));
  const incoming = Array.from({ length: nodeKeys.size + 1 }, () => [] as DenseEdge[]);
  for (const edge of edges) if (scc[edge.from] === scc[edge.to]) incoming[edge.to]!.push(edge);
  const distance = Array(nodeKeys.size + 1).fill(Number.POSITIVE_INFINITY) as number[];
  const portal = Array(nodeKeys.size + 1).fill(0) as number[];
  const nextEdge = new Map<number, DenseEdge>();
  const settled = new Uint8Array(nodeKeys.size + 1);
  const heap: Array<{ distance: number; node: number; portal: number }> = [];
  const less = (a: typeof heap[number], b: typeof heap[number]) => a.distance < b.distance
    || (a.distance === b.distance && (a.portal < b.portal || (a.portal === b.portal && a.node < b.node)));
  const push = (item: typeof heap[number]) => {
    heap.push(item);
    let index = heap.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (!less(heap[index]!, heap[parent]!)) break;
      [heap[index], heap[parent]] = [heap[parent]!, heap[index]!]; index = parent;
    }
  };
  const pop = (): typeof heap[number] => {
    const first = heap[0]!; const last = heap.pop()!;
    if (heap.length) {
      heap[0] = last; let index = 0;
      for (;;) {
        const left = index * 2 + 1, right = left + 1;
        let smallest = index;
        if (left < heap.length && less(heap[left]!, heap[smallest]!)) smallest = left;
        if (right < heap.length && less(heap[right]!, heap[smallest]!)) smallest = right;
        if (smallest === index) break;
        [heap[index], heap[smallest]] = [heap[smallest]!, heap[index]!]; index = smallest;
      }
    }
    return first;
  };
  for (const node of seeds) { distance[node] = 0; portal[node] = node; push({ distance: 0, node, portal: node }); }
  while (heap.length) {
    const current = pop();
    if (settled[current.node] || current.distance !== distance[current.node] || current.portal !== portal[current.node]) continue;
    settled[current.node] = 1;
    for (const edge of incoming[current.node]!) {
      // Point only toward settled nodes, so even zero-length ties cannot form connector cycles.
      if (settled[edge.from]) continue;
      const candidate = current.distance + edge.lengthM;
      if (candidate < distance[edge.from]! || (candidate === distance[edge.from] && current.portal < portal[edge.from]!)) {
        distance[edge.from] = candidate; portal[edge.from] = current.portal; nextEdge.set(edge.from, edge);
        push({ distance: candidate, node: edge.from, portal: current.portal });
      }
    }
  }
  const accessTopology: TopologyProfileBuild["accessTopology"] = [...accessPoints].sort((a, b) => a.id.localeCompare(b.id)).map((point) => {
    const node = nodeKeys.get(point.nodeId)!;
    const canReachCycle = Number.isFinite(distance[node]);
    const directedEdgeIds: string[] = [];
    if (canReachCycle) {
      let current = node;
      while (current !== portal[node]) {
        const edge = nextEdge.get(current);
        if (!edge || directedEdgeIds.length >= nodeKeys.size) throw new Error(`Invalid ${profile} cycle connector for ${point.id}`);
        directedEdgeIds.push(edge.id); current = edge.to;
      }
    }
    return {
      accessPointId: point.id, attachmentDecisionNodeId: node,
      cycleNetworkId: canReachCycle ? network.get(scc[node]!)! : null,
      connectorKey: canReachCycle ? topologySha256({ algorithmVersion: CLOSED_ROUTE_TOPOLOGY_ALGORITHM_VERSION, directedEdgeIds }) : null,
      connectorDecisionEdgeIds: [], portalDecisionNodeId: canReachCycle ? portal[node]! : null,
      minimumStemDistanceM: canReachCycle ? distance[node]! : null, canReachCycle,
    };
  });
  const content = {
    profile, formatVersion: CLOSED_ROUTE_TOPOLOGY_FORMAT_VERSION,
    nodeCount: 0, physicalEdgeCount: physical.length, decisionNodeCount: 0, decisionEdgeCount: 0,
    nodes: [], decisionEdges: [], blocks: [], blockLinks: [], networks: [], accessTopology,
  } satisfies Omit<TopologyProfileBuild, "contentHash" | "builtAt">;
  return { ...content, builtAt, contentHash: topologySha256(content) };
}

export function buildClosedRouteTopology(
  nodesInput: readonly NormalizedNode[],
  edgesInput: readonly CompiledEdge[],
  accessPoints: readonly NormalizedAccessPoint[],
  options: {
    builtAt: string;
    algorithmVersion: string;
    policyVersion: string;
  },
): ClosedRouteTopologyBuild {
  const nodes = [...nodesInput].sort((a, b) => a.id.localeCompare(b.id));
  const nodeKeys = new Map(nodes.map((node, index) => [node.id, index + 1]));
  if (nodeKeys.size !== nodes.length) throw new Error("Closed-route topology requires unique stable node IDs");
  for (const point of accessPoints) {
    if (!nodeKeys.has(point.nodeId)) throw new Error(`Access point ${point.id} references an unknown node`);
  }
  const sortedEdges = [...edgesInput].sort((a, b) => a.id.localeCompare(b.id));
  const edgeKeys = new Map(sortedEdges.map((edge, index) => [edge.id, index + 1]));
  if (edgeKeys.size !== sortedEdges.length) throw new Error("Closed-route topology requires unique stable directed edge IDs");
  const byPhysicalId = new Map<string, CompiledEdge[]>();
  for (const edge of sortedEdges) {
    if (!nodeKeys.has(edge.fromNode) || !nodeKeys.has(edge.toNode)) throw new Error(`Edge ${edge.id} references an unknown node`);
    if (!Number.isFinite(edge.lengthM) || edge.lengthM < 0) throw new Error(`Edge ${edge.id} requires a finite nonnegative length`);
    byPhysicalId.set(edge.stablePhysicalId, [...(byPhysicalId.get(edge.stablePhysicalId) ?? []), edge]);
  }
  const stablePhysicalIds = [...byPhysicalId.keys()].sort();
  const physicalEdgeKeysByStableId = new Map(stablePhysicalIds.map((id, index) => [id, index + 1]));
  const physicalEdges: Physical[] = stablePhysicalIds.map((stablePhysicalId, index) => {
    const members = byPhysicalId.get(stablePhysicalId)!;
    const endpoints = [...new Set(members.flatMap(({ fromNode, toNode }) => [fromNode, toNode]))];
    if (endpoints.length > 2) throw new Error(`Physical edge ${stablePhysicalId} has inconsistent endpoints`);
    const keys = endpoints.map((id) => nodeKeys.get(id)!).sort((a, b) => a - b);
    const firstHash = geometryHash(members[0]!);
    const firstForward = canonicalTopologyJson(members[0]!.geometry);
    const firstReverse = canonicalTopologyJson([...members[0]!.geometry].reverse());
    if (members.some((member) => {
      const value = canonicalTopologyJson(member.geometry); return value !== firstForward && value !== firstReverse;
    })) throw new Error(`Physical edge ${stablePhysicalId} has inconsistent geometry`);
    return {
      physicalEdgeKey: index + 1, stablePhysicalId, fromNodeKey: keys[0]!, toNodeKey: keys.at(-1)!, geometryHash: firstHash,
    };
  });
  const denseEdges: DenseEdge[] = sortedEdges.map((edge) => ({
    ...edge, from: nodeKeys.get(edge.fromNode)!, to: nodeKeys.get(edge.toNode)!,
    physicalEdgeKey: physicalEdgeKeysByStableId.get(edge.stablePhysicalId)!,
  }));
  const profiles = (["known", "inclusive"] as const).map((profile) =>
    buildProfile(profile, nodeKeys, denseEdges, physicalEdges, accessPoints, options.builtAt));
  const runtimeMode = "reachable-graph-fallback";
  const contentHash = topologySha256({
    runtimeMode, algorithmVersion: options.algorithmVersion, policyVersion: options.policyVersion,
    profiles: profiles.map(({ profile, contentHash }) => ({ profile, contentHash })),
  });
  return {
    runtimeMode, algorithmVersion: options.algorithmVersion, policyVersion: options.policyVersion, contentHash,
    nodeKeys,
    edgeKeys,
    physicalEdges,
    physicalEdgeKeysByStableId, profiles,
  };
}
