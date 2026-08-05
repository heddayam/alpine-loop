import type {
  ClosedRouteTopologyV3,
  GeneratedClosedRouteV3,
} from "@/lib/contracts";
import {
  coordinateIsInsideArea,
  edgeIsTraversable,
  type AccessPointCandidate,
  type AreaGeometry,
  type ReconstructedDirectedEdge,
} from "@/lib/graph";

export type ClosedRouteValidationFailure =
  | "empty"
  | "discontinuous"
  | "wrong-start"
  | "not-closed"
  | "illegal-access"
  | "outside-coverage"
  | "zero-cycle";

export type ValidatedClosedRoute = {
  compressedEdgeIds: readonly number[];
  edges: readonly ReconstructedDirectedEdge[];
  physicalEdgeKeys: ReadonlySet<number>;
  route: GeneratedClosedRouteV3;
};

export type ClosedRouteValidationResult =
  | { valid: true; value: ValidatedClosedRoute }
  | { valid: false; reason: ClosedRouteValidationFailure };

export type ClosedRouteValidationOptions = {
  compressedEdgeIds: readonly number[];
  start: AccessPointCandidate;
  includeUncertainAccess: boolean;
  coverage: AreaGeometry;
  sourceFreshness: string;
  sourceConfidence: "high" | "medium" | "low";
  fallbackSourceIds: readonly string[];
  routeId: string;
};

type PhysicalEdge = {
  key: number;
  fromNodeId: string;
  toNodeId: string;
  lengthMeters: number;
  traversalCount: number;
  repeatedDistanceMeters: number;
};

type Adjacent = { edgeIndex: number; nodeId: string };

function physicalGraph(edges: readonly ReconstructedDirectedEdge[]): PhysicalEdge[] {
  const byKey = new Map<number, PhysicalEdge>();
  for (const edge of edges) {
    const current = byKey.get(edge.physicalEdgeKey);
    if (current) {
      current.traversalCount += 1;
      current.repeatedDistanceMeters += edge.lengthMeters;
    } else {
      byKey.set(edge.physicalEdgeKey, {
        key: edge.physicalEdgeKey,
        fromNodeId: edge.fromNodeId,
        toNodeId: edge.toNodeId,
        lengthMeters: edge.lengthMeters,
        traversalCount: 1,
        repeatedDistanceMeters: 0,
      });
    }
  }
  return [...byKey.values()].sort((left, right) => left.key - right.key);
}

function adjacencyFor(edges: readonly PhysicalEdge[]): Map<string, Adjacent[]> {
  const adjacency = new Map<string, Adjacent[]>();
  edges.forEach((edge, edgeIndex) => {
    adjacency.set(edge.fromNodeId, [...(adjacency.get(edge.fromNodeId) ?? []), { edgeIndex, nodeId: edge.toNodeId }]);
    adjacency.set(edge.toNodeId, [...(adjacency.get(edge.toNodeId) ?? []), { edgeIndex, nodeId: edge.fromNodeId }]);
  });
  for (const adjacent of adjacency.values()) {
    adjacent.sort((left, right) => left.edgeIndex - right.edgeIndex || left.nodeId.localeCompare(right.nodeId));
  }
  return adjacency;
}

function decomposePhysicalGraph(edges: readonly PhysicalEdge[]) {
  const adjacency = adjacencyFor(edges);
  const discovery = new Map<string, number>();
  const low = new Map<string, number>();
  const bridges = new Set<number>();
  const edgeStack: number[] = [];
  const blocks: Array<{ edges: Set<number>; nodes: Set<string>; cycleRank: number }> = [];
  let clock = 0;

  const emitBlockThrough = (lastEdgeIndex: number): void => {
    const blockEdges = new Set<number>();
    while (edgeStack.length > 0) {
      const edgeIndex = edgeStack.pop()!;
      blockEdges.add(edgeIndex);
      if (edgeIndex === lastEdgeIndex) break;
    }
    const nodes = new Set<string>();
    for (const edgeIndex of blockEdges) {
      nodes.add(edges[edgeIndex]!.fromNodeId);
      nodes.add(edges[edgeIndex]!.toNodeId);
    }
    blocks.push({ edges: blockEdges, nodes, cycleRank: Math.max(0, blockEdges.size - nodes.size + 1) });
  };

  const visit = (nodeId: string, parentEdgeIndex: number | null): void => {
    discovery.set(nodeId, ++clock);
    low.set(nodeId, clock);
    for (const adjacent of adjacency.get(nodeId) ?? []) {
      if (adjacent.edgeIndex === parentEdgeIndex) continue;
      const adjacentDiscovery = discovery.get(adjacent.nodeId);
      if (adjacentDiscovery === undefined) {
        edgeStack.push(adjacent.edgeIndex);
        visit(adjacent.nodeId, adjacent.edgeIndex);
        low.set(nodeId, Math.min(low.get(nodeId)!, low.get(adjacent.nodeId)!));
        if (low.get(adjacent.nodeId)! > discovery.get(nodeId)!) bridges.add(adjacent.edgeIndex);
        if (low.get(adjacent.nodeId)! >= discovery.get(nodeId)!) emitBlockThrough(adjacent.edgeIndex);
      } else if (adjacentDiscovery < discovery.get(nodeId)!) {
        edgeStack.push(adjacent.edgeIndex);
        low.set(nodeId, Math.min(low.get(nodeId)!, adjacentDiscovery));
      }
    }
  };

  for (const nodeId of [...adjacency.keys()].sort()) {
    if (!discovery.has(nodeId)) visit(nodeId, null);
    if (edgeStack.length > 0) emitBlockThrough(edgeStack[0]!);
  }
  const cyclicBlocks = blocks.filter(({ cycleRank }) => cycleRank > 0);
  return { adjacency, bridges, cyclicBlocks };
}

function blocksMeetWithoutConnector(blocks: readonly { nodes: ReadonlySet<string> }[]): boolean {
  if (blocks.length < 2) return true;
  const reached = new Set([0]);
  const pending = [0];
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (let index = 0; index < blocks.length; index += 1) {
      if (reached.has(index)) continue;
      if ([...blocks[current]!.nodes].some((nodeId) => blocks[index]!.nodes.has(nodeId))) {
        reached.add(index);
        pending.push(index);
      }
    }
  }
  return reached.size === blocks.length;
}

function sharedStemDistance(
  startNodeId: string,
  physicalEdges: readonly PhysicalEdge[],
  adjacency: ReadonlyMap<string, readonly Adjacent[]>,
  bridges: ReadonlySet<number>,
): number {
  const cycleNodes = new Set<string>();
  physicalEdges.forEach((edge, index) => {
    if (!bridges.has(index)) {
      cycleNodes.add(edge.fromNodeId);
      cycleNodes.add(edge.toNodeId);
    }
  });
  if (cycleNodes.has(startNodeId)) return 0;
  const frontier: Array<{ nodeId: string; distance: number }> = [{ nodeId: startNodeId, distance: 0 }];
  const best = new Map<string, number>();
  while (frontier.length > 0) {
    frontier.sort((left, right) => left.distance - right.distance || left.nodeId.localeCompare(right.nodeId));
    const current = frontier.shift()!;
    if (current.distance >= (best.get(current.nodeId) ?? Number.POSITIVE_INFINITY)) continue;
    best.set(current.nodeId, current.distance);
    if (cycleNodes.has(current.nodeId)) return current.distance;
    for (const adjacent of adjacency.get(current.nodeId) ?? []) {
      if (!bridges.has(adjacent.edgeIndex)) continue;
      const edge = physicalEdges[adjacent.edgeIndex]!;
      if (edge.traversalCount < 2) continue;
      frontier.push({ nodeId: adjacent.nodeId, distance: current.distance + edge.lengthMeters });
    }
  }
  return 0;
}

function topologyFor(edges: readonly ReconstructedDirectedEdge[], startNodeId: string): ClosedRouteTopologyV3 | null {
  const physicalEdges = physicalGraph(edges);
  const nodeIds = new Set(physicalEdges.flatMap((edge) => [edge.fromNodeId, edge.toNodeId]));
  const cycleCount = Math.max(0, physicalEdges.length - nodeIds.size + 1);
  if (cycleCount === 0) return null;
  const totalDistanceMeters = edges.reduce((sum, edge) => sum + edge.lengthMeters, 0);
  const repeatedTrailDistanceMeters = physicalEdges.reduce(
    (sum, edge) => sum + edge.repeatedDistanceMeters,
    0,
  );
  const { adjacency, bridges, cyclicBlocks } = decomposePhysicalGraph(physicalEdges);
  const repeatedIndexes = new Set(
    physicalEdges.map((edge, index) => edge.traversalCount > 1 ? index : -1).filter((index) => index >= 0),
  );
  const everyRepeatIsConnector = [...repeatedIndexes].every((edgeIndex) => bridges.has(edgeIndex));
  const cycleBlockCount = Math.max(1, cyclicBlocks.length);
  let kind: ClosedRouteTopologyV3["kind"];
  if (cycleCount === 1 && repeatedTrailDistanceMeters === 0) kind = "simple-loop";
  else if (cycleCount === 1 && repeatedTrailDistanceMeters > 0 && everyRepeatIsConnector) kind = "lollipop";
  else if (cycleCount > 1 && cycleBlockCount > 1 && blocksMeetWithoutConnector(cyclicBlocks)) kind = "figure-eight";
  else if (cycleCount > 1 && cycleBlockCount > 1 && bridges.size > 0) kind = "chained-loops";
  else kind = "complex-closed";
  const repeatedBridgeIndexes = [...repeatedIndexes].filter((edgeIndex) => bridges.has(edgeIndex));
  const connectorNodes = new Set<string>();
  for (const edgeIndex of repeatedBridgeIndexes) {
    connectorNodes.add(physicalEdges[edgeIndex]!.fromNodeId);
    connectorNodes.add(physicalEdges[edgeIndex]!.toNodeId);
  }
  let connectorCount = 0;
  const visited = new Set<string>();
  for (const nodeId of [...connectorNodes].sort()) {
    if (visited.has(nodeId)) continue;
    connectorCount += 1;
    const pending = [nodeId];
    while (pending.length > 0) {
      const current = pending.pop()!;
      if (visited.has(current)) continue;
      visited.add(current);
      for (const adjacent of adjacency.get(current) ?? []) {
        if (repeatedIndexes.has(adjacent.edgeIndex) && bridges.has(adjacent.edgeIndex)) pending.push(adjacent.nodeId);
      }
    }
  }
  return {
    kind,
    cycleCount,
    cycleBlockCount,
    repeatedTrailDistanceMeters,
    repeatedTrailFraction: totalDistanceMeters > 0 ? repeatedTrailDistanceMeters / totalDistanceMeters : 0,
    sharedStemDistanceMeters: sharedStemDistance(startNodeId, physicalEdges, adjacency, bridges),
    connectorCount,
  };
}

function routeCoordinates(edges: readonly ReconstructedDirectedEdge[]): Array<[number, number]> {
  const coordinates: Array<[number, number]> = [];
  for (const [index, edge] of edges.entries()) {
    coordinates.push(...edge.coordinates.slice(index === 0 ? 0 : 1).map(([lon, lat]) => [lon, lat] as [number, number]));
  }
  return coordinates;
}

export function validateReconstructedClosedRoute(
  edges: readonly ReconstructedDirectedEdge[],
  options: ClosedRouteValidationOptions,
): ClosedRouteValidationResult {
  if (edges.length === 0) return { valid: false, reason: "empty" };
  if (edges[0]!.fromNodeId !== options.start.nodeId) return { valid: false, reason: "wrong-start" };
  for (let index = 1; index < edges.length; index += 1) {
    if (edges[index - 1]!.toNodeId !== edges[index]!.fromNodeId) return { valid: false, reason: "discontinuous" };
  }
  if (edges.at(-1)!.toNodeId !== options.start.nodeId) return { valid: false, reason: "not-closed" };
  if (edges.some((edge) => !edgeIsTraversable(edge, options.includeUncertainAccess))) {
    return { valid: false, reason: "illegal-access" };
  }
  if (edges.some((edge) => edge.coordinates.some((coordinate) => !coordinateIsInsideArea(coordinate, options.coverage)))) {
    return { valid: false, reason: "outside-coverage" };
  }
  const topology = topologyFor(edges, options.start.nodeId);
  if (!topology) return { valid: false, reason: "zero-cycle" };
  const distanceMeters = edges.reduce((sum, edge) => sum + edge.lengthMeters, 0);
  const knownElevations = edges.map(({ maximumElevationMeters }) => maximumElevationMeters).filter(
    (value): value is number => value !== null,
  );
  const maximumElevationMeters = knownElevations.length > 0 ? Math.max(...knownElevations) : 0;
  const warnings: string[] = [];
  if (options.start.accessState === "unknown") warnings.push("Access is uncertain");
  if (edges.some(({ accessState }) => accessState === "unknown")) warnings.push("Route uses trail access marked uncertain");
  if (knownElevations.length !== edges.length) warnings.push("Elevation data is incomplete");
  const sourceIds = [...new Set([
    ...edges.flatMap(({ sourceIds }) => sourceIds),
    ...options.start.sourceIds,
    ...options.fallbackSourceIds,
  ])].sort();
  const trailNames = [...new Set(edges.map(({ trailName }) => trailName).filter((name): name is string => Boolean(name)))].sort();
  return {
    valid: true,
    value: {
      compressedEdgeIds: options.compressedEdgeIds,
      edges,
      physicalEdgeKeys: new Set(edges.map(({ physicalEdgeKey }) => physicalEdgeKey)),
      route: {
        id: options.routeId,
        geometry: { type: "LineString", coordinates: routeCoordinates(edges) },
        startAccessPoint: {
          id: options.start.id,
          name: options.start.name,
          lon: options.start.lon,
          lat: options.start.lat,
          accessState: options.start.accessState,
          confidence: options.start.confidence,
        },
        distanceMeters,
        elevationGainMeters: edges.reduce((sum, edge) => sum + edge.gainMeters, 0),
        elevationLossMeters: edges.reduce((sum, edge) => sum + edge.lossMeters, 0),
        minimumElevationMeters: knownElevations.length > 0 ? Math.min(...knownElevations) : 0,
        maximumElevationMeters,
        steepestSustainedGradePct: Math.max(0, ...edges.map(({ maximumSustainedGradePct }) => maximumSustainedGradePct ?? 0)),
        trailNames,
        warnings,
        source: {
          freshness: options.sourceFreshness,
          confidence: options.sourceConfidence,
          sourceIds: sourceIds.length > 0 ? sourceIds : ["unknown-source"],
        },
        topology,
      },
    },
  };
}
