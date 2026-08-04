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
import { SearchController, type SearchDiagnostics } from "./control";

const METERS_PER_MILE = 1_609.344;

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

function rankedStarts(graph: InducedGraph, request: GenerateRoutesRequestV1): GraphAccessPoint[] {
  const eligible = graph.accessPoints.filter((accessPoint) =>
    accessPointIsEligible(accessPoint, request.includeUncertainAccess),
  );
  if (request.startAccessPointId) {
    const requested = eligible.find((accessPoint) => accessPoint.id === request.startAccessPointId);
    if (!requested) throw new Error(`Start access point ${request.startAccessPointId} is not eligible in the search area`);
    return [requested];
  }
  const confidenceRank = { high: 0, medium: 1, low: 2 };
  return eligible.sort(
    (left, right) =>
      confidenceRank[left.confidence] - confidenceRank[right.confidence] ||
      Number(Boolean(right.parkingEvidence)) - Number(Boolean(left.parkingEvidence)) ||
      left.id.localeCompare(right.id),
  );
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
  distanceCap: number,
  graph: InducedGraph,
  controller: SearchController,
  candidates: Map<string, RouteCandidate>,
): void {
  const walk = (nodeId: string, path: EdgeTraversal[], visited: Set<string>): void => {
    if (!controller.tryExpand()) return;
    if (path.length > 0) {
      const reverse = reversePath(path, adjacency);
      if (reverse && !recordCandidate("out-and-back", [...path, ...reverse], start, start, controller, candidates)) return;
    }
    for (const traversal of adjacency.get(nodeId) ?? []) {
      if (visited.has(traversal.to.id)) continue;
      if ((routeDistance(path) + traversal.edge.lengthMeters) * 2 > distanceCap) continue;
      visited.add(traversal.to.id);
      walk(traversal.to.id, [...path, traversal], visited);
      visited.delete(traversal.to.id);
    }
  };
  if (graph.nodes.has(start.nodeId)) walk(start.nodeId, [], new Set([start.nodeId]));
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

function generateLoops(
  start: GraphAccessPoint,
  adjacency: Adjacency,
  distanceCap: number,
  graph: InducedGraph,
  controller: SearchController,
  candidates: Map<string, RouteCandidate>,
): void {
  const walk = (
    nodeId: string,
    path: EdgeTraversal[],
    visitedNodes: Set<string>,
    usedEdges: Set<string>,
  ): void => {
    if (!controller.tryExpand()) return;
    for (const traversal of adjacency.get(nodeId) ?? []) {
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
  if (graph.nodes.has(start.nodeId)) {
    walk(start.nodeId, [], new Set([start.nodeId]), new Set());
  }
}

function generateLollipops(
  start: GraphAccessPoint,
  adjacency: Adjacency,
  distanceCap: number,
  graph: InducedGraph,
  controller: SearchController,
  candidates: Map<string, RouteCandidate>,
): void {
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
      if (!controller.tryExpand()) return;
      for (const traversal of adjacency.get(nodeId) ?? []) {
        const key = undirectedEdgeKey(traversal.edge);
        if (stemKeys.has(key) || usedEdges.has(key)) continue;
        const routeLength = routeDistance(stem) * 2 + routeDistance(cycle) + traversal.edge.lengthMeters;
        if (routeLength > distanceCap) continue;
        if (traversal.to.id === junctionId) {
          if (cycle.length >= 2) {
            const path = [...stem, ...cycle, traversal, ...reverseStem];
            const repeatedStemShare = (routeDistance(stem) * 2) / routeDistance(path);
            if (repeatedStemShare <= 0.35) {
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
    if (!controller.tryExpand()) return;
    if (stem.length > 0) {
      const reverseStem = reversePath(stem, adjacency);
      if (reverseStem) searchCycle(nodeId, stem, reverseStem, stemKeys);
    }
    for (const traversal of adjacency.get(nodeId) ?? []) {
      const key = undirectedEdgeKey(traversal.edge);
      if (
        visitedNodes.has(traversal.to.id) ||
        stemKeys.has(key) ||
        routeDistance(stem) + traversal.edge.lengthMeters > distanceCap * 0.175
      ) {
        continue;
      }
      visitedNodes.add(traversal.to.id);
      stemKeys.add(key);
      walkStem(traversal.to.id, [...stem, traversal], visitedNodes, stemKeys);
      stemKeys.delete(key);
      visitedNodes.delete(traversal.to.id);
    }
  };

  if (graph.nodes.has(start.nodeId)) {
    walkStem(start.nodeId, [], new Set([start.nodeId]), new Set());
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
  const starts = rankedStarts(graph, request);
  const accessByNode = new Map<string, GraphAccessPoint[]>();
  for (const accessPoint of starts.length === 1 && request.startAccessPointId ? graph.accessPoints : starts) {
    if (!accessPointIsEligible(accessPoint, request.includeUncertainAccess)) continue;
    const points = accessByNode.get(accessPoint.nodeId) ?? [];
    points.push(accessPoint);
    accessByNode.set(accessPoint.nodeId, points);
  }
  for (const points of accessByNode.values()) points.sort((left, right) => left.id.localeCompare(right.id));

  const candidates = new Map<string, RouteCandidate>();
  const distanceCap = Math.max(1, request.distanceMiles.max * METERS_PER_MILE * 1.25);
  for (const start of starts) {
    controller.checkCancellation();
    for (const shape of request.routeTypes) {
      if (shape === "out-and-back") {
        generateOutAndBack(start, adjacency, distanceCap, graph, controller, candidates);
      } else if (shape === "point-to-point") {
        generatePointToPoint(start, accessByNode, adjacency, distanceCap, graph, controller, candidates);
      } else if (shape === "loop") {
        generateLoops(start, adjacency, distanceCap, graph, controller, candidates);
      } else {
        generateLollipops(start, adjacency, distanceCap, graph, controller, candidates);
      }
    }
  }
  return {
    candidates: [...candidates.values()].sort((left, right) => left.id.localeCompare(right.id)),
    diagnostics: controller.diagnostics(),
  };
}
