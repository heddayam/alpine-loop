import type { GenerateRoutesRequestV1, RouteType } from "@/lib/contracts";
import {
  accessPointIsEligible,
  edgeIsInsideBbox,
  edgeIsTraversable,
  type EdgeTraversal,
  type GraphAccessPoint,
  type InducedGraph,
} from "@/lib/graph";
import { DEFAULT_SOLVER_BUDGET, type SolverBudget } from "./budget";
import { createCandidate, type RouteCandidate } from "./candidate";
import { undirectedEdgeKey } from "./canonical";
import { generateClosedTours } from "./closed-tours";
import { compressSearchGraph, expandCompressedPath } from "./compressed-graph";
import { SearchController, type SearchDiagnostics } from "./control";
import { rankEligibleStarts } from "./route-graph";
import { classifyRouteTopology } from "./topology";

const METERS_PER_MILE = 1_609.344;
const MAXIMUM_LOOP_STEM_SHARE = 0.1;
const MAXIMUM_LOLLIPOP_STEM_SHARE = 0.35;

type Adjacency = Map<string, EdgeTraversal[]>;

export type InitialGenerationResult = {
  candidates: RouteCandidate[];
  diagnostics: SearchDiagnostics;
};

export type InitialGenerationOptions = {
  budget?: SolverBudget;
  signal?: AbortSignal;
  now?: () => number;
};

function buildAdjacency(graph: InducedGraph, request: GenerateRoutesRequestV1): Adjacency {
  const adjacency = new Map<string, EdgeTraversal[]>();
  for (const edge of graph.edges) {
    const from = graph.nodes.get(edge.fromNodeId);
    const to = graph.nodes.get(edge.toNodeId);
    if (
      !from ||
      !to ||
      !edgeIsTraversable(edge, request.includeUncertainAccess) ||
      !edgeIsInsideBbox(edge, request.bbox)
    ) {
      continue;
    }
    const traversals = adjacency.get(from.id) ?? [];
    traversals.push({ edge, from, to });
    adjacency.set(from.id, traversals);
  }
  for (const traversals of adjacency.values()) {
    traversals.sort((left, right) => left.edge.id.localeCompare(right.edge.id));
  }
  return adjacency;
}

function routeDistance(path: readonly EdgeTraversal[]): number {
  return path.reduce((sum, traversal) => sum + traversal.edge.lengthMeters, 0);
}

function reverseFor(traversal: EdgeTraversal, adjacency: Adjacency): EdgeTraversal | undefined {
  const key = undirectedEdgeKey(traversal.edge);
  return adjacency
    .get(traversal.to.id)
    ?.find(
      (candidate) =>
        candidate.to.id === traversal.from.id && undirectedEdgeKey(candidate.edge) === key,
    );
}

function reversePath(path: readonly EdgeTraversal[], adjacency: Adjacency): EdgeTraversal[] | null {
  const reverse: EdgeTraversal[] = [];
  for (const traversal of [...path].reverse()) {
    const match = reverseFor(traversal, adjacency);
    if (!match) return null;
    reverse.push(match);
  }
  return reverse;
}

function recordCandidate(
  shape: RouteType,
  path: EdgeTraversal[],
  start: GraphAccessPoint,
  end: GraphAccessPoint,
  controller: SearchController,
  candidates: Map<string, RouteCandidate>,
): boolean {
  const candidate = createCandidate(shape, path, start, end);
  if (candidates.has(candidate.id)) return true;
  if (!controller.tryRecordCandidate()) return false;
  candidates.set(candidate.id, candidate);
  return true;
}

function generateOutAndBack(
  start: GraphAccessPoint,
  adjacency: Adjacency,
  distanceFloor: number,
  distanceCap: number,
  graph: InducedGraph,
  controller: SearchController,
  candidates: Map<string, RouteCandidate>,
): void {
  if (!graph.nodes.has(start.nodeId)) return;
  type WalkState = { nodeId: string; path: EdgeTraversal[]; visited: Set<string>; distance: number };
  const queue: WalkState[] = [{ nodeId: start.nodeId, path: [], visited: new Set([start.nodeId]), distance: 0 }];
  let cursor = 0;
  while (cursor < queue.length) {
    if (!controller.tryExpand()) return;
    const state = queue[cursor++]!;
    if (state.path.length > 0 && (state.path.length === 1 || state.distance * 2 >= distanceFloor)) {
      const reverse = reversePath(state.path, adjacency);
      if (reverse
        && !recordCandidate("out-and-back", [...state.path, ...reverse], start, start, controller, candidates)) return;
    }
    for (const traversal of adjacency.get(state.nodeId) ?? []) {
      if (state.visited.has(traversal.to.id)) continue;
      const nextDistance = state.distance + traversal.edge.lengthMeters;
      if (nextDistance * 2 > distanceCap) continue;
      queue.push({
        nodeId: traversal.to.id,
        path: [...state.path, traversal],
        visited: new Set([...state.visited, traversal.to.id]),
        distance: nextDistance,
      });
    }
  }
}

function generatePointToPoint(
  start: GraphAccessPoint,
  accessByNode: Map<string, GraphAccessPoint[]>,
  adjacency: Adjacency,
  distanceCap: number,
  graph: InducedGraph,
  controller: SearchController,
  candidates: Map<string, RouteCandidate>,
): void {
  const walk = (nodeId: string, path: EdgeTraversal[], visited: Set<string>): void => {
    if (!controller.tryExpand()) return;
    if (path.length > 0) {
      for (const end of accessByNode.get(nodeId) ?? []) {
        if (end.id !== start.id && !recordCandidate("point-to-point", path, start, end, controller, candidates)) return;
      }
    }
    for (const traversal of adjacency.get(nodeId) ?? []) {
      if (visited.has(traversal.to.id) || routeDistance(path) + traversal.edge.lengthMeters > distanceCap) continue;
      visited.add(traversal.to.id);
      walk(traversal.to.id, [...path, traversal], visited);
      visited.delete(traversal.to.id);
    }
  };
  if (graph.nodes.has(start.nodeId)) walk(start.nodeId, [], new Set([start.nodeId]));
}

type FrontierItem = { nodeId: string; distance: number };

function popNearest(frontier: FrontierItem[]): FrontierItem | undefined {
  let nearest = 0;
  for (let index = 1; index < frontier.length; index += 1) {
    const candidate = frontier[index]!;
    const best = frontier[nearest]!;
    if (candidate.distance < best.distance
      || (candidate.distance === best.distance && candidate.nodeId.localeCompare(best.nodeId) < 0)) {
      nearest = index;
    }
  }
  const [item] = frontier.splice(nearest, 1);
  return item;
}

function generateRootPartitionLoops(
  start: GraphAccessPoint,
  adjacency: Adjacency,
  distanceCap: number,
  controller: SearchController,
  candidates: Map<string, RouteCandidate>,
): void {
  const distances = new Map<string, number>();
  const labels = new Map<string, string>();
  const parent = new Map<string, EdgeTraversal>();
  const settled = new Set<string>();
  const frontier: FrontierItem[] = [];
  for (const root of adjacency.get(start.nodeId) ?? []) {
    const label = undirectedEdgeKey(root.edge);
    const previousDistance = distances.get(root.to.id);
    const previousLabel = labels.get(root.to.id);
    if (previousDistance === undefined || root.edge.lengthMeters < previousDistance
      || (root.edge.lengthMeters === previousDistance && label.localeCompare(previousLabel ?? "") < 0)) {
      distances.set(root.to.id, root.edge.lengthMeters);
      labels.set(root.to.id, label);
      parent.set(root.to.id, root);
      frontier.push({ nodeId: root.to.id, distance: root.edge.lengthMeters });
    }
  }

  while (frontier.length > 0) {
    const item = popNearest(frontier)!;
    if (settled.has(item.nodeId) || item.distance !== distances.get(item.nodeId)) continue;
    if (!controller.tryExpand()) return;
    settled.add(item.nodeId);
    const label = labels.get(item.nodeId)!;
    for (const traversal of adjacency.get(item.nodeId) ?? []) {
      if (traversal.to.id === start.nodeId) continue;
      const nextDistance = item.distance + traversal.edge.lengthMeters;
      if (nextDistance > distanceCap) continue;
      const previous = distances.get(traversal.to.id);
      const previousLabel = labels.get(traversal.to.id);
      if (previous === undefined || nextDistance < previous
        || (nextDistance === previous && label.localeCompare(previousLabel ?? "") < 0)) {
        distances.set(traversal.to.id, nextDistance);
        labels.set(traversal.to.id, label);
        parent.set(traversal.to.id, traversal);
        frontier.push({ nodeId: traversal.to.id, distance: nextDistance });
      }
    }
  }

  const pathCache = new Map<string, EdgeTraversal[]>();
  const pathTo = (nodeId: string): EdgeTraversal[] | null => {
    const cached = pathCache.get(nodeId);
    if (cached) return cached;
    const reversed: EdgeTraversal[] = [];
    const seen = new Set<string>();
    let current = nodeId;
    while (current !== start.nodeId) {
      if (seen.has(current)) return null;
      seen.add(current);
      const traversal = parent.get(current);
      if (!traversal) return null;
      reversed.push(traversal);
      current = traversal.from.id;
    }
    const path = reversed.reverse();
    pathCache.set(nodeId, path);
    return path;
  };

  for (const [fromNodeId, traversals] of adjacency) {
    const fromLabel = labels.get(fromNodeId);
    const fromPath = fromLabel ? pathTo(fromNodeId) : null;
    if (!fromLabel || !fromPath) continue;
    for (const bridge of traversals) {
      const toLabel = labels.get(bridge.to.id);
      const toPath = toLabel ? pathTo(bridge.to.id) : null;
      if (!toLabel || toLabel === fromLabel || !toPath) continue;
      const reverseToPath = reversePath(toPath, adjacency);
      if (!reverseToPath) continue;
      const path = [...fromPath, bridge, ...reverseToPath];
      if (path.length < 3 || routeDistance(path) > distanceCap) continue;
      const keys = path.map(({ edge }) => undirectedEdgeKey(edge));
      if (new Set(keys).size !== keys.length) continue;
      if (!recordCandidate("loop", path, start, start, controller, candidates)) return;
    }
  }
}

function traversalOrder(traversals: readonly EdgeTraversal[], variant: number): EdgeTraversal[] {
  if (variant === 0) return [...traversals];
  if (variant === 1) return [...traversals].reverse();
  const middle = Math.floor(traversals.length / 2);
  return [...traversals.slice(middle), ...traversals.slice(0, middle)];
}

function generateLoopDfsVariants(
  start: GraphAccessPoint,
  adjacency: Adjacency,
  distanceCap: number,
  graph: InducedGraph,
  controller: SearchController,
  candidates: Map<string, RouteCandidate>,
  budget: SolverBudget,
): void {
  if (!graph.nodes.has(start.nodeId)) return;
  const variants = 3;
  const maximumStartExpansions = Math.max(1, Math.floor(budget.maximumExpandedStates / 16));
  const maximumVariantExpansions = Math.max(1, Math.floor(maximumStartExpansions / variants));
  for (let variant = 0; variant < variants; variant += 1) {
    let variantExpansions = 0;
    const walk = (
      nodeId: string,
      path: EdgeTraversal[],
      visitedNodes: Set<string>,
      usedEdges: Set<string>,
    ): void => {
      if (variantExpansions >= maximumVariantExpansions || !controller.tryExpand()) return;
      variantExpansions += 1;
      for (const traversal of traversalOrder(adjacency.get(nodeId) ?? [], variant)) {
        const edgeKey = undirectedEdgeKey(traversal.edge);
        const nextDistance = routeDistance(path) + traversal.edge.lengthMeters;
        if (usedEdges.has(edgeKey) || nextDistance > distanceCap) continue;
        if (traversal.to.id === start.nodeId) {
          if (path.length >= 2) recordCandidate("loop", [...path, traversal], start, start, controller, candidates);
          continue;
        }
        if (visitedNodes.has(traversal.to.id)) continue;
        visitedNodes.add(traversal.to.id);
        usedEdges.add(edgeKey);
        walk(traversal.to.id, [...path, traversal], visitedNodes, usedEdges);
        usedEdges.delete(edgeKey);
        visitedNodes.delete(traversal.to.id);
      }
    };
    walk(start.nodeId, [], new Set([start.nodeId]), new Set());
  }
}

function generateLollipopDfsFallback(
  start: GraphAccessPoint,
  adjacency: Adjacency,
  distanceCap: number,
  graph: InducedGraph,
  controller: SearchController,
  candidates: Map<string, RouteCandidate>,
  budget: SolverBudget,
): void {
  const maximumFallbackExpansions = Math.max(1, Math.floor(budget.maximumExpandedStates / 16));
  let fallbackExpansions = 0;
  const tryExpandFallback = (): boolean => {
    if (fallbackExpansions >= maximumFallbackExpansions || !controller.tryExpand()) return false;
    fallbackExpansions += 1;
    return true;
  };
  const searchCycle = (
    junctionId: string,
    stem: EdgeTraversal[],
    reverseStem: EdgeTraversal[],
    stemKeys: Set<string>,
  ): void => {
    const walkCycle = (
      nodeId: string,
      cycle: EdgeTraversal[],
      visitedNodes: Set<string>,
      usedEdges: Set<string>,
    ): void => {
      if (!tryExpandFallback()) return;
      for (const traversal of adjacency.get(nodeId) ?? []) {
        const key = undirectedEdgeKey(traversal.edge);
        if (stemKeys.has(key) || usedEdges.has(key)) continue;
        const repeatedStemDistance = routeDistance(stem);
        const traversedStemDistance = repeatedStemDistance + routeDistance(reverseStem);
        const routeLength = traversedStemDistance + routeDistance(cycle) + traversal.edge.lengthMeters;
        if (routeLength > distanceCap) continue;
        if (traversal.to.id === junctionId) {
          if (cycle.length >= 2) {
            const path = [...stem, ...cycle, traversal, ...reverseStem];
            const stemShare = repeatedStemDistance / routeDistance(path);
            const traversedStemShare = traversedStemDistance / routeDistance(path);
            if (stemShare > MAXIMUM_LOOP_STEM_SHARE && traversedStemShare <= MAXIMUM_LOLLIPOP_STEM_SHARE) {
              recordCandidate("lollipop", path, start, start, controller, candidates);
            }
          }
          continue;
        }
        if (visitedNodes.has(traversal.to.id)) continue;
        visitedNodes.add(traversal.to.id);
        usedEdges.add(key);
        walkCycle(traversal.to.id, [...cycle, traversal], visitedNodes, usedEdges);
        usedEdges.delete(key);
        visitedNodes.delete(traversal.to.id);
      }
    };
    walkCycle(junctionId, [], new Set([junctionId]), new Set());
  };

  const walkStem = (
    nodeId: string,
    stem: EdgeTraversal[],
    visitedNodes: Set<string>,
    stemKeys: Set<string>,
  ): void => {
    if (!tryExpandFallback()) return;
    if (stem.length > 0) {
      const reverseStem = reversePath(stem, adjacency);
      if (reverseStem) searchCycle(nodeId, stem, reverseStem, stemKeys);
    }
    for (const traversal of adjacency.get(nodeId) ?? []) {
      const key = undirectedEdgeKey(traversal.edge);
      if (visitedNodes.has(traversal.to.id) || stemKeys.has(key)
        || routeDistance(stem) + traversal.edge.lengthMeters > distanceCap * 0.175) continue;
      visitedNodes.add(traversal.to.id);
      stemKeys.add(key);
      walkStem(traversal.to.id, [...stem, traversal], visitedNodes, stemKeys);
      stemKeys.delete(key);
      visitedNodes.delete(traversal.to.id);
    }
  };
  if (graph.nodes.has(start.nodeId)) walkStem(start.nodeId, [], new Set([start.nodeId]), new Set());
}

/**
 * Build a deterministic shortest-path tree once, then turn non-tree edges into
 * bounded fundamental cycles. This avoids depth-first starvation on dense real
 * trail networks while preserving the hard state, distance, and candidate caps.
 */
function generateTreeCycles(
  shape: "loop" | "lollipop",
  start: GraphAccessPoint,
  adjacency: Adjacency,
  distanceCap: number,
  graph: InducedGraph,
  controller: SearchController,
  candidates: Map<string, RouteCandidate>,
  budget: SolverBudget,
): void {
  if (!graph.nodes.has(start.nodeId)) return;
  if (shape === "loop") {
    generateRootPartitionLoops(start, adjacency, distanceCap, controller, candidates);
  }
  const distances = new Map<string, number>([[start.nodeId, 0]]);
  const parent = new Map<string, EdgeTraversal>();
  const settled = new Set<string>();
  const frontier: FrontierItem[] = [{ nodeId: start.nodeId, distance: 0 }];

  while (frontier.length > 0) {
    const item = popNearest(frontier)!;
    if (settled.has(item.nodeId) || item.distance !== distances.get(item.nodeId)) continue;
    if (!controller.tryExpand()) return;
    settled.add(item.nodeId);
    for (const traversal of adjacency.get(item.nodeId) ?? []) {
      const nextDistance = item.distance + traversal.edge.lengthMeters;
      if (nextDistance > distanceCap || settled.has(traversal.to.id)) continue;
      const previous = distances.get(traversal.to.id);
      const previousParent = parent.get(traversal.to.id);
      if (previous === undefined || nextDistance < previous
        || (nextDistance === previous && traversal.edge.id.localeCompare(previousParent?.edge.id ?? "") < 0)) {
        distances.set(traversal.to.id, nextDistance);
        parent.set(traversal.to.id, traversal);
        frontier.push({ nodeId: traversal.to.id, distance: nextDistance });
      }
    }
  }

  const pathCache = new Map<string, EdgeTraversal[]>([[start.nodeId, []]]);
  const pathTo = (nodeId: string): EdgeTraversal[] | null => {
    const cached = pathCache.get(nodeId);
    if (cached) return cached;
    const reversed: EdgeTraversal[] = [];
    const seen = new Set<string>();
    let current = nodeId;
    while (current !== start.nodeId) {
      if (seen.has(current)) return null;
      seen.add(current);
      const traversal = parent.get(current);
      if (!traversal) return null;
      reversed.push(traversal);
      current = traversal.from.id;
    }
    const path = reversed.reverse();
    pathCache.set(nodeId, path);
    return path;
  };

  for (const [fromNodeId, traversals] of adjacency) {
    const fromPath = pathTo(fromNodeId);
    if (!fromPath) continue;
    for (const bridge of traversals) {
      const toPath = pathTo(bridge.to.id);
      if (!toPath) continue;
      const bridgeKey = undirectedEdgeKey(bridge.edge);
      const fromKeys = fromPath.map(({ edge }) => undirectedEdgeKey(edge));
      const toKeys = toPath.map(({ edge }) => undirectedEdgeKey(edge));
      if (fromKeys.includes(bridgeKey) || toKeys.includes(bridgeKey)) continue;
      let commonPrefix = 0;
      while (commonPrefix < fromKeys.length && commonPrefix < toKeys.length
        && fromKeys[commonPrefix] === toKeys[commonPrefix]) commonPrefix += 1;
      const fromTail = fromPath.slice(commonPrefix);
      const toTail = toPath.slice(commonPrefix);
      if (fromTail.length === 0 || toTail.length === 0) continue;
      const reverseToTail = reversePath(toTail, adjacency);
      if (!reverseToTail) continue;
      const stem = fromPath.slice(0, commonPrefix);
      const reverseStem = reversePath(stem, adjacency);
      if (!reverseStem) continue;
      const cycle = [...fromTail, bridge, ...reverseToTail];
      const cycleKeys = cycle.map(({ edge }) => undirectedEdgeKey(edge));
      if (new Set(cycleKeys).size !== cycleKeys.length) continue;
      const path = [...stem, ...cycle, ...reverseStem];
      if (routeDistance(path) > distanceCap) continue;
      const repeatedStemDistance = routeDistance(stem);
      const stemShare = repeatedStemDistance / routeDistance(path);
      const traversedStemShare = (repeatedStemDistance + routeDistance(reverseStem)) / routeDistance(path);
      if (shape === "loop" && stemShare > MAXIMUM_LOOP_STEM_SHARE) continue;
      if (shape === "lollipop"
        && (stemShare <= MAXIMUM_LOOP_STEM_SHARE || traversedStemShare > MAXIMUM_LOLLIPOP_STEM_SHARE)) continue;
      if (!recordCandidate(shape, path, start, start, controller, candidates)) return;
    }
  }
  if (shape === "loop") {
    generateLoopDfsVariants(start, adjacency, distanceCap, graph, controller, candidates, budget);
  } else {
    generateLollipopDfsFallback(start, adjacency, distanceCap, graph, controller, candidates, budget);
  }
}

export function generateInitialCandidates(
  graph: InducedGraph,
  request: GenerateRoutesRequestV1,
  options: InitialGenerationOptions = {},
): InitialGenerationResult {
  const controller = new SearchController(options.budget ?? DEFAULT_SOLVER_BUDGET, options);
  if (!controller.checkGraphSize(graph.edges.length)) {
    return { candidates: [], diagnostics: controller.diagnostics() };
  }
  const adjacency = buildAdjacency(graph, request);
  const starts = rankEligibleStarts(graph, request);
  if (request.startAccessPointId && starts.length === 0) {
    throw new Error(`Start access point ${request.startAccessPointId} is not eligible in the search area`);
  }
  const accessByNode = new Map<string, GraphAccessPoint[]>();
  for (const accessPoint of starts.length === 1 && request.startAccessPointId ? graph.accessPoints : starts) {
    if (!accessPointIsEligible(accessPoint, request.includeUncertainAccess)) continue;
    const points = accessByNode.get(accessPoint.nodeId) ?? [];
    points.push(accessPoint);
    accessByNode.set(accessPoint.nodeId, points);
  }
  for (const points of accessByNode.values()) points.sort((left, right) => left.id.localeCompare(right.id));

  const candidates = new Map<string, RouteCandidate>();
  const distanceFloor = Math.max(0, request.distanceMiles.min * METERS_PER_MILE);
  const requestedDistanceCap = Math.max(1, request.distanceMiles.max * METERS_PER_MILE);
  const distanceCap = requestedDistanceCap * 1.25;
  for (const start of starts) {
    controller.checkCancellation();
    const requestedClosedShapes = new Set(
      request.routeTypes.filter((shape): shape is "loop" | "lollipop" =>
        shape === "loop" || shape === "lollipop"),
    );
    if (requestedClosedShapes.size > 0) {
      const compressed = compressSearchGraph(graph);
      const compressedById = new Map(compressed.traversals.map((traversal) => [traversal.edge.id, traversal]));
      const closed = generateClosedTours({
        nodes: compressed.nodes,
        edges: compressed.traversals.map(({ edge }) => edge),
        accessPoints: compressed.accessPoints,
      }, start, {
        distanceMeters: {
          min: distanceFloor,
          max: requestedDistanceCap,
          target: (distanceFloor + requestedDistanceCap) / 2,
        },
        ...(request.elevationGainFeet ? {
          elevationGainMeters: {
            min: request.elevationGainFeet.min * 0.3048,
            max: request.elevationGainFeet.max * 0.3048,
            target: (request.elevationGainFeet.min + request.elevationGainFeet.max) * 0.1524,
          },
        } : {}),
        includeUncertainAccess: request.includeUncertainAccess,
        maximumWalks: options.budget?.maximumRawCandidates ?? DEFAULT_SOLVER_BUDGET.maximumRawCandidates,
      }, options);
      controller.absorbWork(closed.diagnostics);
      for (const closedCandidate of closed.candidates) {
        const compressedPath = closedCandidate.traversals.map((traversal) => {
          const match = compressedById.get(traversal.edge.id);
          if (!match) throw new Error(`Closed tour references unknown compressed edge ${traversal.edge.id}`);
          return match;
        });
        const path = expandCompressedPath(compressedPath);
        const classification = classifyRouteTopology(path);
        if ((classification === "loop" || classification === "lollipop")
          && requestedClosedShapes.has(classification)
          && !recordCandidate(classification, path, start, start, controller, candidates)) break;
      }
    }
    for (const shape of request.routeTypes) {
      if (shape === "out-and-back") {
        generateOutAndBack(start, adjacency, distanceFloor, distanceCap, graph, controller, candidates);
      } else if (shape === "point-to-point") {
        generatePointToPoint(start, accessByNode, adjacency, distanceCap, graph, controller, candidates);
      } else if (![...candidates.values()].some((candidate) => candidate.shape === shape)) {
        generateTreeCycles(shape, start, adjacency, distanceCap, graph, controller, candidates, options.budget ?? DEFAULT_SOLVER_BUDGET);
      }
    }
  }
  return {
    candidates: [...candidates.values()].sort((left, right) => left.id.localeCompare(right.id)),
    diagnostics: controller.diagnostics(),
  };
}
