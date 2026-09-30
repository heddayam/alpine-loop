import { RouteSearchCancelledError } from "./control";

export type CycleBlockGraph = {
  nodeCount: number;
  from: Int32Array;
  to: Int32Array;
  physical: readonly string[];
};

export type CycleBlock = {
  /** Original directed-edge indexes, including both directions when present. */
  edges: number[];
  nodes: number[];
  /** An undirected physical cycle exists; legal direction is not implied. */
  cyclic: boolean;
};

type PhysicalEdge = { from: number; to: number; directed: number[] };
type Frame = { node: number; parentEdge: number; next: number };

/**
 * Iterative low-link decomposition of the underlying physical multigraph.
 * Every simple cycle lies in one block; bridges remain singleton edge blocks,
 * and isolated nodes have no block. Self-loops are separate cyclic blocks.
 *
 * The iterative DFS follows the standard edge-stack biconnected algorithm:
 * https://networkx.org/documentation/stable/reference/algorithms/generated/networkx.algorithms.components.biconnected_components.html
 * Cycle localization is the structural reduction used by Ferreira et al.:
 * https://arxiv.org/abs/1205.2766
 * Unlike a simple-graph neighbor traversal, the parent is identified by its
 * physical edge so parallel trails remain a two-edge cycle. Reverse directed
 * records collapse to one physical edge and never create a cycle themselves.
 *
 * This O(nodes + directed edges) decomposition proves no access, direction,
 * metric, or reversible-stem feasibility. Callers retain those checks.
 */
export function decomposeCycleBlocks(graph: CycleBlockGraph, signal?: AbortSignal): {
  edgeBlock: Int32Array;
  blocks: CycleBlock[];
} {
  const checkCancellation = (): void => {
    if (signal?.aborted) throw new RouteSearchCancelledError(signal.reason);
  };
  checkCancellation();
  if (!Number.isSafeInteger(graph.nodeCount) || graph.nodeCount < 0 || graph.nodeCount > 0x7fff_ffff) {
    throw new RangeError("Cycle block graph requires a nonnegative node count");
  }
  if (graph.from.length !== graph.to.length || graph.from.length !== graph.physical.length) {
    throw new Error("Cycle block graph requires matching directed-edge arrays");
  }
  let work = 0;
  const tick = (): void => { if ((work++ & 1023) === 0) checkCancellation(); };
  const physicalEdges: PhysicalEdge[] = [];
  const physicalIndex = new Map<string, number>();
  for (let directed = 0; directed < graph.from.length; directed += 1) {
    tick();
    const from = graph.from[directed]!;
    const to = graph.to[directed]!;
    if (from < 0 || from >= graph.nodeCount || to < 0 || to >= graph.nodeCount) {
      throw new RangeError("Cycle block edge refers to a missing node");
    }
    const key = graph.physical[directed]!;
    const existing = physicalIndex.get(key);
    if (existing === undefined) {
      physicalIndex.set(key, physicalEdges.length);
      physicalEdges.push({ from, to, directed: [directed] });
    } else {
      const edge = physicalEdges[existing]!;
      if (!(edge.from === from && edge.to === to) && !(edge.from === to && edge.to === from)) {
        throw new Error("A physical cycle-block edge has inconsistent endpoints");
      }
      edge.directed.push(directed);
    }
  }

  const edgeBlock = new Int32Array(graph.from.length).fill(-1);
  const blocks: CycleBlock[] = [];
  const emit = (physical: readonly number[]): void => {
    const edges: number[] = [];
    const nodes = new Set<number>();
    const index = blocks.length;
    for (const key of physical) {
      tick();
      const edge = physicalEdges[key]!;
      nodes.add(edge.from);
      nodes.add(edge.to);
      for (const directed of edge.directed) {
        tick();
        edges.push(directed);
        edgeBlock[directed] = index;
      }
    }
    blocks.push({ edges, nodes: [...nodes], cyclic: physical.length >= nodes.size });
  };
  const adjacency: number[][] = Array.from({ length: graph.nodeCount }, () => { tick(); return []; });
  for (const [index, edge] of physicalEdges.entries()) {
    tick();
    if (edge.from === edge.to) emit([index]);
    else {
      adjacency[edge.from]!.push(index);
      adjacency[edge.to]!.push(index);
    }
  }

  const discovered = new Int32Array(graph.nodeCount).fill(-1);
  const low = new Int32Array(graph.nodeCount);
  const edgeStack: number[] = [];
  let clock = 0;
  for (let root = 0; root < graph.nodeCount; root += 1) {
    tick();
    if (discovered[root] !== -1) continue;
    discovered[root] = low[root] = clock++;
    const frames: Frame[] = [{ node: root, parentEdge: -1, next: 0 }];
    while (frames.length > 0) {
      tick();
      const frame = frames.at(-1)!;
      const adjacent = adjacency[frame.node]!;
      if (frame.next < adjacent.length) {
        const index = adjacent[frame.next++]!;
        if (index === frame.parentEdge) continue;
        const edge = physicalEdges[index]!;
        const next = edge.from === frame.node ? edge.to : edge.from;
        if (discovered[next] === -1) {
          edgeStack.push(index);
          discovered[next] = low[next] = clock++;
          frames.push({ node: next, parentEdge: index, next: 0 });
        } else if (discovered[next]! < discovered[frame.node]!) {
          edgeStack.push(index);
          low[frame.node] = Math.min(low[frame.node]!, discovered[next]!);
        }
        continue;
      }
      frames.pop();
      if (frame.parentEdge === -1) continue;
      const parent = frames.at(-1)!.node;
      low[parent] = Math.min(low[parent]!, low[frame.node]!);
      if (low[frame.node]! < discovered[parent]!) continue;
      const component: number[] = [];
      let edge: number;
      do {
        tick();
        edge = edgeStack.pop()!;
        component.push(edge);
      } while (edge !== frame.parentEdge);
      emit(component);
    }
  }
  checkCancellation();
  return { edgeBlock, blocks };
}
