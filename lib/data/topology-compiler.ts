import { createHash, type Hash } from "node:crypto";
import type { TopologyProfile } from "@/lib/contracts";
import type { NormalizedAccessPoint, NormalizedNode, CompiledEdge, Schema3TopologyBuild, TopologyProfileBuild } from "./types";

export const CLOSED_ROUTE_TOPOLOGY_FORMAT_VERSION = 1;

type DenseEdge = CompiledEdge & { edgeKey: number; from: number; to: number; physicalEdgeKey: number };
type Physical = Schema3TopologyBuild["physicalEdges"][number] & { lengthM: number; stableEdgeIds: string[] };
type BlockWork = { edgeKeys: number[]; nodeKeys: number[]; cycleRank: number; blockId: number };

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonicalValue(item)]));
  }
  return value;
}

/** Stable UTF-8 JSON used for every schema-3 topology content hash. */
export function canonicalTopologyJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function updateCanonicalHash(hash: Hash, value: unknown): void {
  if (Array.isArray(value)) {
    hash.update("[");
    value.forEach((item, index) => {
      if (index) hash.update(",");
      updateCanonicalHash(hash, item === undefined ? null : item);
    });
    hash.update("]");
    return;
  }
  if (value !== null && typeof value === "object") {
    hash.update("{");
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b));
    entries.forEach(([key, item], index) => {
      if (index) hash.update(",");
      hash.update(JSON.stringify(key)); hash.update(":"); updateCanonicalHash(hash, item);
    });
    hash.update("}");
    return;
  }
  hash.update(JSON.stringify(value));
}

export function topologySha256(value: unknown): string {
  const hash = createHash("sha256");
  updateCanonicalHash(hash, value);
  return `sha256:${hash.digest("hex")}`;
}

function geometryHash(edge: CompiledEdge): string {
  const forward = canonicalTopologyJson(edge.geometry);
  const reverse = canonicalTopologyJson([...edge.geometry].reverse());
  return topologySha256(forward < reverse ? forward : reverse);
}

function connectedComponents(nodeCount: number, adjacency: readonly number[][], physicalByKey: Map<number, Physical>): number[] {
  const result = Array(nodeCount + 1).fill(0) as number[];
  let component = 0;
  for (let start = 1; start <= nodeCount; start += 1) {
    if (result[start] || adjacency[start]!.length === 0) continue;
    component += 1;
    const pending = [start];
    result[start] = component;
    while (pending.length) {
      const node = pending.pop()!;
      for (const edgeKey of adjacency[node]!) {
        const edge = physicalByKey.get(edgeKey)!;
        const next = edge.fromNodeKey === node ? edge.toNodeKey : edge.fromNodeKey;
        if (!result[next]) { result[next] = component; pending.push(next); }
      }
    }
  }
  // Isolated nodes remain inspectable and receive deterministic components.
  for (let node = 1; node <= nodeCount; node += 1) if (!result[node]) result[node] = ++component;
  return result;
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

function undirectedDecomposition(
  nodeCount: number,
  adjacency: readonly number[][],
  physicalByKey: Map<number, Physical>,
): { bridges: Set<number>; articulations: Set<number>; blocks: BlockWork[]; twoEdge: number[] } {
  const discovery = new Int32Array(nodeCount + 1);
  const low = new Int32Array(nodeCount + 1);
  const parentNode = new Int32Array(nodeCount + 1);
  const parentEdge = new Int32Array(nodeCount + 1);
  const childCount = new Int32Array(nodeCount + 1);
  const bridges = new Set<number>();
  const articulations = new Set<number>();
  const rawBlocks: number[][] = [];
  const edgeStack: number[] = [];
  let time = 0;
  for (let root = 1; root <= nodeCount; root += 1) {
    if (discovery[root] || adjacency[root]!.length === 0) continue;
    discovery[root] = low[root] = ++time;
    const frames = [{ node: root, index: 0 }];
    while (frames.length) {
      const frame = frames[frames.length - 1]!;
      const edgeKey = adjacency[frame.node]![frame.index++];
      if (edgeKey !== undefined) {
        const edge = physicalByKey.get(edgeKey)!;
        const next = edge.fromNodeKey === frame.node ? edge.toNodeKey : edge.fromNodeKey;
        if (next === frame.node) {
          if (!rawBlocks.some((block) => block.length === 1 && block[0] === edgeKey)) rawBlocks.push([edgeKey]);
        } else if (!discovery[next]) {
          parentNode[next] = frame.node;
          parentEdge[next] = edgeKey;
          childCount[frame.node] += 1;
          edgeStack.push(edgeKey);
          discovery[next] = low[next] = ++time;
          frames.push({ node: next, index: 0 });
        } else if (edgeKey !== parentEdge[frame.node] && discovery[next] < discovery[frame.node]) {
          low[frame.node] = Math.min(low[frame.node]!, discovery[next]!);
          edgeStack.push(edgeKey);
        }
      } else {
        frames.pop();
        const parent = parentNode[frame.node]!;
        if (parent) {
          low[parent] = Math.min(low[parent]!, low[frame.node]!);
          if (low[frame.node]! > discovery[parent]!) bridges.add(parentEdge[frame.node]!);
          if (low[frame.node]! >= discovery[parent]!) {
            if (parentNode[parent] || childCount[parent]! > 1) articulations.add(parent);
            const block: number[] = [];
            while (edgeStack.length) {
              const popped = edgeStack.pop()!;
              block.push(popped);
              if (popped === parentEdge[frame.node]) break;
            }
            if (block.length) rawBlocks.push(block);
          }
        } else if (childCount[frame.node]! > 1) articulations.add(frame.node);
      }
    }
  }
  const blocks = rawBlocks.map((edgeKeys) => {
    const sortedEdges = [...new Set(edgeKeys)].sort((a, b) => a - b);
    const nodes = [...new Set(sortedEdges.flatMap((key) => {
      const edge = physicalByKey.get(key)!; return [edge.fromNodeKey, edge.toNodeKey];
    }))].sort((a, b) => a - b);
    return { edgeKeys: sortedEdges, nodeKeys: nodes, cycleRank: sortedEdges.length - nodes.length + 1, blockId: 0 };
  }).sort((a, b) => (a.edgeKeys[0] ?? 0) - (b.edgeKeys[0] ?? 0));
  blocks.forEach((block, index) => { block.blockId = index + 1; });

  const twoEdge = Array(nodeCount + 1).fill(0) as number[];
  let component = 0;
  for (let start = 1; start <= nodeCount; start += 1) {
    if (twoEdge[start]) continue;
    component += 1;
    twoEdge[start] = component;
    const pending = [start];
    while (pending.length) {
      const node = pending.pop()!;
      for (const edgeKey of adjacency[node]!) {
        if (bridges.has(edgeKey)) continue;
        const edge = physicalByKey.get(edgeKey)!;
        const next = edge.fromNodeKey === node ? edge.toNodeKey : edge.fromNodeKey;
        if (!twoEdge[next]) { twoEdge[next] = component; pending.push(next); }
      }
    }
  }
  return { bridges, articulations, blocks, twoEdge };
}

function metadataSignature(edge: DenseEdge): string {
  return canonicalTopologyJson({ accessState: edge.accessState, flags: edge.flags, sourceRefs: edge.sourceRefs });
}

function profileHashInput(profile: Omit<TopologyProfileBuild, "contentHash">): unknown {
  return {
    profile: profile.profile,
    formatVersion: profile.formatVersion,
    nodeCount: profile.nodeCount,
    physicalEdgeCount: profile.physicalEdgeCount,
    decisionNodeCount: profile.decisionNodeCount,
    decisionEdgeCount: profile.decisionEdgeCount,
    nodes: profile.nodes,
    decisionEdges: profile.decisionEdges,
    blocks: profile.blocks,
    blockLinks: profile.blockLinks,
    networks: profile.networks.map(({ contentHash: _hash, ...network }) => network),
    accessTopology: profile.accessTopology,
  };
}

function buildProfile(
  profile: TopologyProfile,
  nodes: readonly NormalizedNode[],
  denseEdges: readonly DenseEdge[],
  physicalEdges: readonly Physical[],
  accessPoints: readonly NormalizedAccessPoint[],
  builtAt: string,
  globalDecisionEdgeOffset: number,
): TopologyProfileBuild {
  const accepted = profile === "known" ? new Set(["public"]) : new Set(["public", "unknown"]);
  const edges = denseEdges.filter((edge) => accepted.has(edge.accessState));
  const includedPhysicalKeys = new Set(edges.map(({ physicalEdgeKey }) => physicalEdgeKey));
  const physical = physicalEdges.filter(({ physicalEdgeKey }) => includedPhysicalKeys.has(physicalEdgeKey));
  const physicalByKey = new Map(physical.map((edge) => [edge.physicalEdgeKey, edge]));
  const edgeByKey = new Map(edges.map((edge) => [edge.edgeKey, edge]));
  const directionsByPhysical = new Map<number, DenseEdge[]>();
  for (const edge of edges) directionsByPhysical.set(edge.physicalEdgeKey, [...(directionsByPhysical.get(edge.physicalEdgeKey) ?? []), edge]);
  for (const values of directionsByPhysical.values()) values.sort((a, b) => a.edgeKey - b.edgeKey);
  const adjacency = Array.from({ length: nodes.length + 1 }, () => [] as number[]);
  for (const edge of physical) {
    adjacency[edge.fromNodeKey]!.push(edge.physicalEdgeKey);
    if (edge.toNodeKey !== edge.fromNodeKey) adjacency[edge.toNodeKey]!.push(edge.physicalEdgeKey);
  }
  adjacency.forEach((items) => items.sort((a, b) => a - b));
  const connected = connectedComponents(nodes.length, adjacency, physicalByKey);
  const scc = stronglyConnectedComponents(nodes.length, edges);
  const decomposition = undirectedDecomposition(nodes.length, adjacency, physicalByKey);
  const blockByPhysical = new Map<number, BlockWork>();
  decomposition.blocks.forEach((block) => block.edgeKeys.forEach((key) => blockByPhysical.set(key, block)));

  // An SCC is route-feasible only when its physical projection has positive cycle rank.
  const sccPhysical = new Map<number, Set<number>>();
  for (const edge of physical) {
    if (scc[edge.fromNodeKey] === scc[edge.toNodeKey]) {
      (sccPhysical.get(scc[edge.fromNodeKey]!) ?? sccPhysical.set(scc[edge.fromNodeKey]!, new Set()).get(scc[edge.fromNodeKey]!)!).add(edge.physicalEdgeKey);
    }
  }
  const cyclicScc = new Set<number>();
  for (const [id, edgeKeys] of sccPhysical) {
    const incident = new Set<number>();
    edgeKeys.forEach((key) => { const edge = physicalByKey.get(key)!; incident.add(edge.fromNodeKey); incident.add(edge.toNodeKey); });
    if (edgeKeys.size - incident.size + 1 > 0) cyclicScc.add(id);
  }

  const nodeKeyById = new Map(nodes.map((node, index) => [node.id, index + 1]));
  const accessNodes = new Set(accessPoints.map(({ nodeId }) => nodeKeyById.get(nodeId) ?? 0).filter((key) => key > 0));
  const retain = new Set<number>();
  const physicalMetadata = new Map<number, string>();
  for (const edge of physical) physicalMetadata.set(edge.physicalEdgeKey, metadataSignature(directionsByPhysical.get(edge.physicalEdgeKey)![0]!));
  for (let node = 1; node <= nodes.length; node += 1) {
    const incident = adjacency[node]!;
    const discontinuity = new Set(incident.map((key) => physicalMetadata.get(key))).size > 1;
    const directionalPairs = incident.map((key) => directionsByPhysical.get(key)!.map((edge) => `${edge.from === node ? "out" : "in"}:${edge.physicalEdgeKey}`).sort().join("|"));
    const directionDiscontinuity = incident.length === 2 && directionalPairs.some((value) => value.length === 0);
    if (incident.length !== 2 || accessNodes.has(node) || decomposition.articulations.has(node)
      || incident.some((key) => decomposition.bridges.has(key)) || discontinuity || directionDiscontinuity) retain.add(node);
  }
  // Every cycle block gets a stable portal, which is also the required pure-cycle anchor.
  for (const block of decomposition.blocks.filter(({ cycleRank }) => cycleRank > 0)) {
    if (!block.nodeKeys.some((key) => retain.has(key))) retain.add(block.nodeKeys[0]!);
  }
  // Direction patterns that cannot be represented by a complete chain force a decision node.
  for (let node = 1; node <= nodes.length; node += 1) {
    if (retain.has(node) || adjacency[node]!.length !== 2) continue;
    const [a, b] = adjacency[node]!;
    const aEdges = directionsByPhysical.get(a!)!;
    const bEdges = directionsByPhysical.get(b!)!;
    const inA = aEdges.some((edge) => edge.to === node), outA = aEdges.some((edge) => edge.from === node);
    const inB = bEdges.some((edge) => edge.to === node), outB = bEdges.some((edge) => edge.from === node);
    if (inA !== outB || inB !== outA) retain.add(node);
  }
  const retainedKeys = [...retain].sort((a, b) => a - b);
  const decisionIdByNode = new Map(retainedKeys.map((nodeKey, index) => [nodeKey, index + 1]));

  type Chain = { from: number; to: number; physicalKeys: number[]; orientedNodes: number[] };
  const chains: Chain[] = [];
  const visitedPhysical = new Set<number>();
  for (const start of retainedKeys) {
    for (const initialEdge of adjacency[start]!) {
      if (visitedPhysical.has(initialEdge)) continue;
      const physicalKeys: number[] = [];
      const orientedNodes = [start];
      let current = start;
      let edgeKey = initialEdge;
      for (;;) {
        visitedPhysical.add(edgeKey);
        physicalKeys.push(edgeKey);
        const physicalEdge = physicalByKey.get(edgeKey)!;
        const next = physicalEdge.fromNodeKey === current ? physicalEdge.toNodeKey : physicalEdge.fromNodeKey;
        orientedNodes.push(next);
        if (retain.has(next)) { chains.push({ from: start, to: next, physicalKeys, orientedNodes }); break; }
        const nextEdge = adjacency[next]!.find((candidate) => candidate !== edgeKey && !visitedPhysical.has(candidate));
        if (nextEdge === undefined) { retain.add(next); break; }
        current = next; edgeKey = nextEdge;
      }
    }
  }

  const decisionEdges: TopologyProfileBuild["decisionEdges"] = [];
  const originalToDecision = new Map<number, number>();
  const oriented = (chain: Chain, reverse: boolean): DenseEdge[] | null => {
    const nodeSequence = reverse ? [...chain.orientedNodes].reverse() : chain.orientedNodes;
    const keys = reverse ? [...chain.physicalKeys].reverse() : chain.physicalKeys;
    const result: DenseEdge[] = [];
    for (let index = 0; index < keys.length; index += 1) {
      const edge = directionsByPhysical.get(keys[index]!)!.find((candidate) => candidate.from === nodeSequence[index] && candidate.to === nodeSequence[index + 1]);
      if (!edge) return null;
      result.push(edge);
    }
    return result;
  };
  const candidates = chains.flatMap((chain) => [oriented(chain, false), oriented(chain, true)]
    .filter((members): members is DenseEdge[] => members !== null)
    .map((members) => ({ chain, members })));
  candidates.sort((a, b) => {
    const af = decisionIdByNode.get(a.members[0]!.from)!, bf = decisionIdByNode.get(b.members[0]!.from)!;
    return af - bf || decisionIdByNode.get(a.members.at(-1)!.to)! - decisionIdByNode.get(b.members.at(-1)!.to)!
      || a.members.map(({ edgeKey }) => edgeKey).join(",").localeCompare(b.members.map(({ edgeKey }) => edgeKey).join(","));
  });
  candidates.forEach(({ members }, index) => {
    const decisionEdgeKey = globalDecisionEdgeOffset + index + 1;
    const physicalKeys = members.map(({ physicalEdgeKey }) => physicalEdgeKey);
    const block = blockByPhysical.get(physicalKeys[0]!);
    const maximumElevations = members.map(({ maxElevationM }) => maxElevationM).filter((value): value is number => value !== null);
    const grades = members.map(({ maxSustainedGradePct }) => maxSustainedGradePct).filter((value): value is number => value !== null);
    const flags = [...new Set(members.flatMap(({ flags }) => flags))].sort();
    const trailNames = [...new Set(flags.filter((flag) => flag.startsWith("trail-name:")).map((flag) => flag.slice(11)))].sort();
    const sourceIds = [...new Set(members.flatMap(({ sourceRefs }) => sourceRefs))].sort();
    const accessStates = [...new Set(members.map(({ accessState }) => accessState))];
    const from = decisionIdByNode.get(members[0]!.from)!;
    const to = decisionIdByNode.get(members.at(-1)!.to)!;
    decisionEdges.push({
      decisionEdgeKey,
      networkId: connected[members[0]!.from]!,
      fromDecisionNodeId: from,
      toDecisionNodeId: to,
      lengthM: members.reduce((sum, edge) => sum + edge.lengthM, 0),
      gainM: members.reduce((sum, edge) => sum + (edge.gainM ?? 0), 0),
      lossM: members.reduce((sum, edge) => sum + (edge.lossM ?? 0), 0),
      isBridge: physicalKeys.every((key) => decomposition.bridges.has(key)),
      twoEdgeComponentId: decomposition.twoEdge[members[0]!.from]!,
      vertexBlockId: block?.blockId ?? null,
      metricsAndFlags: canonicalTopologyJson({
        maximumElevationMeters: maximumElevations.length ? Math.max(...maximumElevations) : null,
        maximumSustainedGradePct: grades.length ? Math.max(...grades) : null,
        accessState: accessStates.includes("unknown") ? "unknown" : "public",
        trailNames, sourceIds, flags,
      }),
      members: members.map((edge, sequenceIndex) => ({ sequenceIndex, edgeKey: edge.edgeKey, physicalEdgeKey: edge.physicalEdgeKey })),
    });
    members.forEach(({ edgeKey }) => originalToDecision.set(edgeKey, decisionEdgeKey));
  });
  if (originalToDecision.size !== edges.length) throw new Error(`${profile} decision graph mapped ${originalToDecision.size} of ${edges.length} legal directed edges`);

  const decisionNodeIdsForBlock = (block: BlockWork): number[] => block.nodeKeys
    .map((key) => decisionIdByNode.get(key)).filter((id): id is number => id !== undefined).sort((a, b) => a - b);
  const blocks: TopologyProfileBuild["blocks"] = decomposition.blocks.map((block) => {
    const blockPhysical = block.edgeKeys.map((key) => physicalByKey.get(key)!);
    const decisionEdgeKeys = decisionEdges.filter(({ vertexBlockId }) => vertexBlockId === block.blockId)
      .map(({ decisionEdgeKey }) => decisionEdgeKey).sort((a, b) => a - b);
    const blockPhysicalKeys = new Set(block.edgeKeys);
    const blockDenseEdges = edges.filter(({ physicalEdgeKey }) => blockPhysicalKeys.has(physicalEdgeKey));
    const elevations = blockDenseEdges.map(({ maxElevationM }) => maxElevationM).filter((value): value is number => value !== null);
    const trailNames = [...new Set(blockDenseEdges.flatMap(({ flags }) => flags.filter((flag) => flag.startsWith("trail-name:")).map((flag) => flag.slice(11))))].sort();
    const total = blockPhysical.reduce((sum, edge) => sum + edge.lengthM, 0);
    return {
      blockId: block.blockId,
      networkId: connected[block.nodeKeys[0]!]!,
      blockKind: block.cycleRank > 0 ? "vertex-cycle" as const : "bridge" as const,
      nodeCount: block.nodeKeys.length,
      edgeCount: block.edgeKeys.length,
      cycleRank: block.cycleRank,
      totalPhysicalLengthM: total,
      minimumCycleLengthM: block.cycleRank === 1 ? total : null,
      elevationSummary: canonicalTopologyJson({ minimumElevationMeters: elevations.length ? Math.min(...elevations) : null, maximumElevationMeters: elevations.length ? Math.max(...elevations) : null }),
      trailSummary: canonicalTopologyJson(trailNames),
      decisionNodeIds: decisionNodeIdsForBlock(block), decisionEdgeKeys,
    };
  });
  const blockLinks: TopologyProfileBuild["blockLinks"] = [];
  const blocksByNode = new Map<number, typeof blocks>();
  for (const block of decomposition.blocks) {
    const persisted = blocks[block.blockId - 1]!;
    for (const nodeKey of block.nodeKeys) blocksByNode.set(nodeKey, [...(blocksByNode.get(nodeKey) ?? []), persisted]);
  }
  for (const nodeKey of [...decomposition.articulations].sort((a, b) => a - b)) {
    const touching = blocksByNode.get(nodeKey) ?? [];
    for (let left = 0; left < touching.length; left += 1) for (let right = left + 1; right < touching.length; right += 1) {
      blockLinks.push({
        networkId: connected[nodeKey]!, fromBlockId: touching[left]!.blockId, toBlockId: touching[right]!.blockId,
        articulationDecisionNodeId: decisionIdByNode.get(nodeKey)!, connectorDistanceM: 0,
      });
    }
  }

  const cyclePortalNodeKeys = new Set<number>();
  for (const block of decomposition.blocks.filter(({ cycleRank }) => cycleRank > 0)) {
    for (const nodeKey of block.nodeKeys) if (decisionIdByNode.has(nodeKey) && cyclicScc.has(scc[nodeKey]!)) cyclePortalNodeKeys.add(nodeKey);
  }
  // Reverse multi-source Dijkstra computes exact directed distance/path to a valid cycle portal.
  const incoming = Array.from({ length: nodes.length + 1 }, () => [] as DenseEdge[]);
  edges.forEach((edge) => incoming[edge.to]!.push(edge));
  incoming.forEach((items) => items.sort((a, b) => a.edgeKey - b.edgeKey));
  const distance = Array(nodes.length + 1).fill(Number.POSITIVE_INFINITY) as number[];
  const nextEdge = Array(nodes.length + 1).fill(0) as number[];
  const portal = Array(nodes.length + 1).fill(0) as number[];
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
  for (const nodeKey of [...cyclePortalNodeKeys].sort((a, b) => a - b)) { distance[nodeKey] = 0; portal[nodeKey] = nodeKey; push({ distance: 0, node: nodeKey, portal: nodeKey }); }
  while (heap.length) {
    const current = pop();
    if (current.distance !== distance[current.node] || current.portal !== portal[current.node]) continue;
    for (const edge of incoming[current.node]!) {
      if (scc[edge.from] !== scc[current.node]) continue;
      const candidate = current.distance + edge.lengthM;
      if (candidate < distance[edge.from] || (candidate === distance[edge.from] && current.portal < portal[edge.from])) {
        distance[edge.from] = candidate; portal[edge.from] = current.portal; nextEdge[edge.from] = edge.edgeKey;
        push({ distance: candidate, node: edge.from, portal: current.portal });
      }
    }
  }
  const accessTopology = [...accessPoints].sort((a, b) => a.id.localeCompare(b.id)).map((point) => {
    const nodeKey = nodeKeyById.get(point.nodeId) ?? 0;
    const canReachCycle = nodeKey > 0 && cyclicScc.has(scc[nodeKey]!) && Number.isFinite(distance[nodeKey]!);
    const connectorEdgeKeys: number[] = [];
    if (canReachCycle) {
      let current = nodeKey;
      const seen = new Set<number>();
      while (current !== portal[nodeKey]) {
        const edgeKey = nextEdge[current]!;
        if (!edgeKey || seen.has(edgeKey)) throw new Error(`Invalid ${profile} cycle connector for ${point.id}`);
        seen.add(edgeKey); connectorEdgeKeys.push(edgeKey); current = edgeByKey.get(edgeKey)!.to;
      }
    }
    const compressed = connectorEdgeKeys.map((key) => originalToDecision.get(key)!).filter((key, index, values) => index === 0 || values[index - 1] !== key);
    return {
      accessPointId: point.id,
      attachmentDecisionNodeId: decisionIdByNode.get(nodeKey)!,
      cycleNetworkId: canReachCycle ? connected[nodeKey]! : null,
      connectorKey: canReachCycle ? topologySha256(compressed) : null,
      connectorDecisionEdgeIds: compressed,
      portalDecisionNodeId: canReachCycle ? decisionIdByNode.get(portal[nodeKey]!)! : null,
      minimumStemDistanceM: canReachCycle ? distance[nodeKey]! : null,
      canReachCycle,
    };
  });
  const topologyNodes = nodes.map((node, index) => {
    const key = index + 1;
    const feasible = cyclicScc.has(scc[key]!) && Number.isFinite(distance[key]!);
    return {
      denseId: key, sourceNodeId: node.id, decisionNodeId: decisionIdByNode.get(key) ?? null,
      connectedComponentId: connected[key]!, directedSccId: scc[key]!, twoEdgeComponentId: decomposition.twoEdge[key]!,
      isArticulation: decomposition.articulations.has(key), nearestCycleNetworkId: feasible ? connected[key]! : null,
      cyclePortalDecisionNodeId: feasible ? decisionIdByNode.get(portal[key]!)! : null,
      minimumStemDistanceM: feasible ? distance[key]! : null,
    };
  });
  const cyclicNetworks = [...new Set(accessTopology.filter(({ canReachCycle }) => canReachCycle).map(({ cycleNetworkId }) => cycleNetworkId!))].sort((a, b) => a - b);
  const decisionEdgesByNetwork = new Map<number, typeof decisionEdges>();
  decisionEdges.forEach((edge) => decisionEdgesByNetwork.set(edge.networkId, [...(decisionEdgesByNetwork.get(edge.networkId) ?? []), edge]));
  const blocksByNetwork = new Map<number, typeof blocks>();
  blocks.forEach((block) => blocksByNetwork.set(block.networkId, [...(blocksByNetwork.get(block.networkId) ?? []), block]));
  const linksByNetwork = new Map<number, typeof blockLinks>();
  blockLinks.forEach((link) => linksByNetwork.set(link.networkId, [...(linksByNetwork.get(link.networkId) ?? []), link]));
  const networks: TopologyProfileBuild["networks"] = cyclicNetworks.map((networkId) => {
    const networkEdges = decisionEdgesByNetwork.get(networkId) ?? [];
    const networkBlocks = blocksByNetwork.get(networkId) ?? [];
    const decisionIds = new Set(networkEdges.flatMap((edge) => [edge.fromDecisionNodeId, edge.toDecisionNodeId]));
    const cycles = networkBlocks.filter(({ cycleRank }) => cycleRank > 0);
    const cycleLengths = cycles.map(({ minimumCycleLengthM }) => minimumCycleLengthM).filter((value): value is number => value !== null);
    const elevations = networkEdges.flatMap(({ metricsAndFlags }) => {
      const value = JSON.parse(metricsAndFlags) as { maximumElevationMeters: number | null }; return value.maximumElevationMeters === null ? [] : [value.maximumElevationMeters];
    });
    const content = {
      networkId, decisionNodeIds: [...decisionIds].sort((a, b) => a - b), decisionEdges: networkEdges,
      blocks: networkBlocks, blockLinks: linksByNetwork.get(networkId) ?? [],
    };
    return {
      networkId, decisionNodeCount: decisionIds.size, decisionEdgeCount: networkEdges.length, cycleBlockCount: cycles.length,
      minimumCycleLengthM: cycleLengths.length ? Math.min(...cycleLengths) : null,
      maximumCycleLengthM: cycleLengths.length ? Math.max(...cycleLengths) : null,
      minimumElevationM: elevations.length ? Math.min(...elevations) : null,
      maximumElevationM: elevations.length ? Math.max(...elevations) : null,
      contentHash: topologySha256(content),
    };
  });
  const withoutHash: Omit<TopologyProfileBuild, "contentHash"> = {
    profile, formatVersion: CLOSED_ROUTE_TOPOLOGY_FORMAT_VERSION, nodeCount: nodes.length,
    physicalEdgeCount: physical.length, decisionNodeCount: retainedKeys.length, decisionEdgeCount: decisionEdges.length,
    builtAt, nodes: topologyNodes, decisionEdges, blocks, blockLinks, networks, accessTopology,
  };
  return { ...withoutHash, contentHash: topologySha256(profileHashInput(withoutHash)) };
}

export function buildClosedRouteTopology(
  nodesInput: readonly NormalizedNode[],
  edgesInput: readonly CompiledEdge[],
  accessPoints: readonly NormalizedAccessPoint[],
  options: { builtAt: string; algorithmVersion: string; policyVersion: string },
): Schema3TopologyBuild {
  const nodes = [...nodesInput].sort((a, b) => a.id.localeCompare(b.id));
  const nodeKeys = new Map(nodes.map((node, index) => [node.id, index + 1]));
  if (nodeKeys.size !== nodes.length) throw new Error("Schema 3 topology requires unique stable node IDs");
  const sortedEdges = [...edgesInput].sort((a, b) => a.id.localeCompare(b.id));
  const edgeKeys = new Map(sortedEdges.map((edge, index) => [edge.id, index + 1]));
  if (edgeKeys.size !== sortedEdges.length) throw new Error("Schema 3 topology requires unique stable directed edge IDs");
  const byPhysicalId = new Map<string, CompiledEdge[]>();
  for (const edge of sortedEdges) {
    if (!nodeKeys.has(edge.fromNode) || !nodeKeys.has(edge.toNode)) throw new Error(`Edge ${edge.id} references an unknown node`);
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
      lengthM: members[0]!.lengthM, stableEdgeIds: members.map(({ id }) => id).sort(),
    };
  });
  const denseEdges: DenseEdge[] = sortedEdges.map((edge, index) => ({
    ...edge, edgeKey: index + 1, from: nodeKeys.get(edge.fromNode)!, to: nodeKeys.get(edge.toNode)!,
    physicalEdgeKey: physicalEdgeKeysByStableId.get(edge.stablePhysicalId)!,
  }));
  const known = buildProfile("known", nodes, denseEdges, physicalEdges, accessPoints, options.builtAt, 0);
  const inclusive = buildProfile("inclusive", nodes, denseEdges, physicalEdges, accessPoints, options.builtAt, known.decisionEdgeCount);
  const profiles = [known, inclusive];
  const contentHash = topologySha256({
    algorithmVersion: options.algorithmVersion, policyVersion: options.policyVersion,
    profiles: profiles.map(({ profile, contentHash }) => ({ profile, contentHash })),
  });
  return {
    algorithmVersion: options.algorithmVersion, policyVersion: options.policyVersion, contentHash,
    nodeKeys, edgeKeys, physicalEdges: physicalEdges.map(({ lengthM: _length, stableEdgeIds: _ids, ...edge }) => edge),
    physicalEdgeKeysByStableId, profiles,
  };
}
