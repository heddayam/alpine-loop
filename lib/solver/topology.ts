import type { EdgeTraversal } from "@/lib/graph";
import { undirectedEdgeKey } from "./canonical";

export type CycleStructure = "none" | "single-loop" | "figure-eight" | "chained-loops" | "complex";
export type TopologyClassification = "loop" | "lollipop" | "out-and-back" | "unclassified";

export type RouteTopology = {
  closed: boolean;
  contiguous: boolean;
  cycleCount: number;
  cycleStructure: CycleStructure;
  totalDistanceMeters: number;
  repeatedPhysicalDistanceMeters: number;
  repeatedPhysicalTrailFraction: number;
  repeatedPhysicalEdgeKeys: string[];
  repeatsFormStemsOrConnectors: boolean;
  mostlyRetraced: boolean;
  classification: TopologyClassification;
};

type PhysicalEdge = {
  key: string;
  fromNodeId: string;
  toNodeId: string;
  lengthMeters: number;
  traversalCount: number;
};

type AdjacentEdge = { edgeIndex: number; nodeId: string };

function physicalEdgesFor(walk: readonly EdgeTraversal[]): PhysicalEdge[] {
  const byKey = new Map<string, PhysicalEdge>();
  for (const traversal of walk) {
    const key = undirectedEdgeKey(traversal.edge);
    const existing = byKey.get(key);
    if (existing) {
      existing.traversalCount += 1;
      continue;
    }
    byKey.set(key, {
      key,
      fromNodeId: traversal.from.id,
      toNodeId: traversal.to.id,
      lengthMeters: traversal.edge.lengthMeters,
      traversalCount: 1,
    });
  }
  return [...byKey.values()].sort((left, right) => left.key.localeCompare(right.key));
}

function adjacencyFor(edges: readonly PhysicalEdge[]): Map<string, AdjacentEdge[]> {
  const adjacency = new Map<string, AdjacentEdge[]>();
  const add = (nodeId: string, adjacent: AdjacentEdge) => {
    const current = adjacency.get(nodeId) ?? [];
    current.push(adjacent);
    adjacency.set(nodeId, current);
  };
  edges.forEach((edge, edgeIndex) => {
    add(edge.fromNodeId, { edgeIndex, nodeId: edge.toNodeId });
    add(edge.toNodeId, { edgeIndex, nodeId: edge.fromNodeId });
  });
  for (const adjacent of adjacency.values()) {
    adjacent.sort((left, right) => left.edgeIndex - right.edgeIndex || left.nodeId.localeCompare(right.nodeId));
  }
  return adjacency;
}

function graphComponents(adjacency: ReadonlyMap<string, readonly AdjacentEdge[]>): number {
  const visited = new Set<string>();
  let components = 0;
  for (const start of [...adjacency.keys()].sort()) {
    if (visited.has(start)) continue;
    components += 1;
    const pending = [start];
    while (pending.length > 0) {
      const nodeId = pending.pop()!;
      if (visited.has(nodeId)) continue;
      visited.add(nodeId);
      for (const adjacent of adjacency.get(nodeId) ?? []) {
        if (!visited.has(adjacent.nodeId)) pending.push(adjacent.nodeId);
      }
    }
  }
  return components;
}

function bridgesAndArticulations(adjacency: ReadonlyMap<string, readonly AdjacentEdge[]>) {
  const discovery = new Map<string, number>();
  const low = new Map<string, number>();
  const bridges = new Set<number>();
  const articulations = new Set<string>();
  let time = 0;

  const visit = (nodeId: string, parentEdgeIndex: number | null) => {
    time += 1;
    discovery.set(nodeId, time);
    low.set(nodeId, time);
    let childCount = 0;
    for (const adjacent of adjacency.get(nodeId) ?? []) {
      if (adjacent.edgeIndex === parentEdgeIndex) continue;
      const adjacentDiscovery = discovery.get(adjacent.nodeId);
      if (adjacentDiscovery === undefined) {
        childCount += 1;
        visit(adjacent.nodeId, adjacent.edgeIndex);
        low.set(nodeId, Math.min(low.get(nodeId)!, low.get(adjacent.nodeId)!));
        if (low.get(adjacent.nodeId)! > discovery.get(nodeId)!) bridges.add(adjacent.edgeIndex);
        if (parentEdgeIndex !== null && low.get(adjacent.nodeId)! >= discovery.get(nodeId)!) articulations.add(nodeId);
      } else {
        low.set(nodeId, Math.min(low.get(nodeId)!, adjacentDiscovery));
      }
    }
    if (parentEdgeIndex === null && childCount > 1) articulations.add(nodeId);
  };

  for (const nodeId of [...adjacency.keys()].sort()) {
    if (!discovery.has(nodeId)) visit(nodeId, null);
  }
  return { bridges, articulations };
}

function cyclicComponentCount(
  adjacency: ReadonlyMap<string, readonly AdjacentEdge[]>,
  bridges: ReadonlySet<number>,
): number {
  const visited = new Set<string>();
  let cyclicComponents = 0;
  for (const start of [...adjacency.keys()].sort()) {
    if (visited.has(start)) continue;
    const pending = [start];
    const componentNodes = new Set<string>();
    const componentEdges = new Set<number>();
    while (pending.length > 0) {
      const nodeId = pending.pop()!;
      if (visited.has(nodeId)) continue;
      visited.add(nodeId);
      componentNodes.add(nodeId);
      for (const adjacent of adjacency.get(nodeId) ?? []) {
        if (bridges.has(adjacent.edgeIndex)) continue;
        componentEdges.add(adjacent.edgeIndex);
        if (!visited.has(adjacent.nodeId)) pending.push(adjacent.nodeId);
      }
    }
    if (componentEdges.size - componentNodes.size + 1 > 0) cyclicComponents += 1;
  }
  return cyclicComponents;
}

function walkIsContiguous(walk: readonly EdgeTraversal[]): boolean {
  return walk.every((traversal, index) => {
    const next = walk[index + 1];
    return !next || traversal.to.id === next.from.id;
  });
}

export function analyzeRouteTopology(walk: readonly EdgeTraversal[]): RouteTopology {
  const contiguous = walkIsContiguous(walk);
  const closed = walk.length > 0 && contiguous && walk[0]!.from.id === walk.at(-1)!.to.id;
  const physicalEdges = physicalEdgesFor(walk);
  const adjacency = adjacencyFor(physicalEdges);
  const components = graphComponents(adjacency);
  const cycleCount = physicalEdges.length === 0 ? 0 : Math.max(0, physicalEdges.length - adjacency.size + components);
  const { bridges, articulations } = bridgesAndArticulations(adjacency);
  const cyclicComponents = cyclicComponentCount(adjacency, bridges);

  const totalDistanceMeters = walk.reduce((sum, traversal) => sum + traversal.edge.lengthMeters, 0);
  const repeatedEdges = physicalEdges.filter((edge) => edge.traversalCount > 1);
  const repeatedPhysicalDistanceMeters = repeatedEdges.reduce(
    (sum, edge) => sum + (edge.traversalCount - 1) * edge.lengthMeters,
    0,
  );
  const repeatedPhysicalTrailFraction = totalDistanceMeters > 0
    ? repeatedPhysicalDistanceMeters / totalDistanceMeters
    : 0;
  const repeatedIndexes = new Set(repeatedEdges.map((edge) => physicalEdges.indexOf(edge)));
  const repeatsFormStemsOrConnectors = repeatedIndexes.size > 0
    && [...repeatedIndexes].every((edgeIndex) => bridges.has(edgeIndex));

  const maximumDegree = Math.max(0, ...[...adjacency.values()].map((edges) => edges.length));
  const mostlyRetraced = cycleCount === 0
    && repeatedPhysicalTrailFraction >= 0.45
    && physicalEdges.length > 0
    && physicalEdges.every((edge) => edge.traversalCount >= 2)
    && maximumDegree <= 2;

  let cycleStructure: CycleStructure = "none";
  if (cycleCount === 1) cycleStructure = "single-loop";
  else if (cycleCount === 2 && bridges.size === 0 && articulations.size === 1 && cyclicComponents === 1) {
    cycleStructure = "figure-eight";
  } else if (cycleCount > 1 && (articulations.size > 0 || cyclicComponents > 1)) {
    cycleStructure = "chained-loops";
  } else if (cycleCount > 1) cycleStructure = "complex";

  let classification: TopologyClassification = "unclassified";
  if (closed && mostlyRetraced) classification = "out-and-back";
  else if (closed && cycleCount > 0 && repeatedPhysicalTrailFraction <= 0.1) classification = "loop";
  else if (
    closed
    && cycleCount > 0
    && repeatedPhysicalTrailFraction > 0.1
    && repeatedPhysicalTrailFraction <= 0.35
    && repeatsFormStemsOrConnectors
  ) classification = "lollipop";

  return {
    closed,
    contiguous,
    cycleCount,
    cycleStructure,
    totalDistanceMeters,
    repeatedPhysicalDistanceMeters,
    repeatedPhysicalTrailFraction,
    repeatedPhysicalEdgeKeys: repeatedEdges.map((edge) => edge.key),
    repeatsFormStemsOrConnectors,
    mostlyRetraced,
    classification,
  };
}

export function classifyRouteTopology(walk: readonly EdgeTraversal[]): TopologyClassification {
  return analyzeRouteTopology(walk).classification;
}
