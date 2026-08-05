import {
  edgeIsTraversable,
  type EdgeTraversal,
  type GraphAccessPoint,
  type InducedGraph,
} from "@/lib/graph";

import { DEFAULT_SOLVER_BUDGET, type SolverBudget } from "./budget";
import { undirectedEdgeKey } from "./canonical";
import { SearchController, type SearchDiagnostics } from "./control";

export type ClosedTourTargetRange = {
  min: number;
  max: number;
  target?: number;
};

export type ClosedTourRequest = {
  distanceMeters: ClosedTourTargetRange;
  elevationGainMeters?: ClosedTourTargetRange;
  includeUncertainAccess: boolean;
  maximumWalks?: number;
};

export type ClosedTourCandidate = {
  traversals: EdgeTraversal[];
  distanceMeters: number;
  elevationGainMeters: number;
  repeatedEdgeFraction: number;
  exactDistance: boolean;
  exactElevationGain: boolean;
};

export type ClosedTourGenerationOptions = {
  budget?: SolverBudget;
  signal?: AbortSignal;
  now?: () => number;
  labelsPerNode?: number;
  maximumCompositionDepth?: number;
};

export type ClosedTourGenerationResult = {
  candidates: ClosedTourCandidate[];
  diagnostics: SearchDiagnostics;
};

type Direction = "outbound" | "return";

type PathLabel = {
  nodeId: string;
  traversals: EdgeTraversal[];
  visitedNodeIds: Set<string>;
  distanceMeters: number;
  elevationGainMeters: number;
  signature: string;
  priority: number;
};

type RankedWalk = ClosedTourCandidate & {
  signature: string;
  score: number;
};

const DEFAULT_LABELS_PER_NODE = 6;
const DEFAULT_MAXIMUM_COMPOSITION_DEPTH = 3;
const MINIMUM_PHYSICAL_EDGES = 3;
const MAXIMUM_TRAVERSALS_PER_PHYSICAL_EDGE = 2;

class MinHeap<T> {
  readonly #items: T[] = [];
  readonly #compare: (left: T, right: T) => number;

  constructor(compare: (left: T, right: T) => number) {
    this.#compare = compare;
  }

  get size(): number {
    return this.#items.length;
  }

  push(value: T): void {
    this.#items.push(value);
    let index = this.#items.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.#compare(this.#items[parent]!, value) <= 0) break;
      this.#items[index] = this.#items[parent]!;
      index = parent;
    }
    this.#items[index] = value;
  }

  pop(): T | undefined {
    const first = this.#items[0];
    const last = this.#items.pop();
    if (first === undefined || last === undefined || this.#items.length === 0) return first;
    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      if (left >= this.#items.length) break;
      const child = right < this.#items.length
        && this.#compare(this.#items[right]!, this.#items[left]!) < 0
        ? right
        : left;
      if (this.#compare(last, this.#items[child]!) <= 0) break;
      this.#items[index] = this.#items[child]!;
      index = child;
    }
    this.#items[index] = last;
    return first;
  }
}

function center(range: ClosedTourTargetRange): number {
  return range.target ?? (range.min + range.max) / 2;
}

function normalizedCenterDistance(value: number, range: ClosedTourTargetRange): number {
  return Math.abs(value - center(range)) / Math.max(range.max - range.min, center(range), 1);
}

function normalizedRangeViolation(value: number, range: ClosedTourTargetRange): number {
  if (value < range.min) return (range.min - value) / Math.max(range.min, 1);
  if (value > range.max) return (value - range.max) / Math.max(range.max, 1);
  return 0;
}

function labelPriority(
  distanceMeters: number,
  elevationGainMeters: number,
  request: ClosedTourRequest,
): number {
  // An outbound and a return label each contribute roughly half a tour. Biasing
  // the frontier toward those half-targets reaches useful depth before spending
  // states on the many short twigs common in raw OSM graphs.
  const halfDistance = center(request.distanceMeters) / 2;
  let priority = Math.abs(distanceMeters - halfDistance) / Math.max(halfDistance, 1);
  if (request.elevationGainMeters) {
    const halfGain = center(request.elevationGainMeters) / 2;
    priority += Math.abs(elevationGainMeters - halfGain) / Math.max(halfGain, 30);
  }
  return priority;
}

function compareLabels(left: PathLabel, right: PathLabel): number {
  return left.priority - right.priority
    || right.distanceMeters - left.distanceMeters
    || left.elevationGainMeters - right.elevationGainMeters
    || left.signature.localeCompare(right.signature);
}

function buildAdjacency(graph: InducedGraph, includeUncertainAccess: boolean): {
  outbound: Map<string, EdgeTraversal[]>;
  incoming: Map<string, EdgeTraversal[]>;
} {
  const outbound = new Map<string, EdgeTraversal[]>();
  const incoming = new Map<string, EdgeTraversal[]>();
  for (const edge of graph.edges) {
    const from = graph.nodes.get(edge.fromNodeId);
    const to = graph.nodes.get(edge.toNodeId);
    if (!from || !to || !edgeIsTraversable(edge, includeUncertainAccess)) continue;
    const traversal = { edge, from, to };
    outbound.set(from.id, [...(outbound.get(from.id) ?? []), traversal]);
    incoming.set(to.id, [...(incoming.get(to.id) ?? []), traversal]);
  }
  const stableTraversalOrder = (left: EdgeTraversal, right: EdgeTraversal): number =>
    left.edge.id.localeCompare(right.edge.id)
    || left.to.id.localeCompare(right.to.id)
    || left.from.id.localeCompare(right.from.id);
  for (const traversals of outbound.values()) traversals.sort(stableTraversalOrder);
  for (const traversals of incoming.values()) traversals.sort(stableTraversalOrder);
  return { outbound, incoming };
}

function insertBoundedLabel(
  labels: Map<string, PathLabel[]>,
  candidate: PathLabel,
  labelsPerNode: number,
): boolean {
  const current = labels.get(candidate.nodeId) ?? [];
  if (current.some((label) => label.signature === candidate.signature)) return false;
  const ranked = [...current, candidate].sort(compareLabels);
  if (ranked.length > labelsPerNode) ranked.length = labelsPerNode;
  labels.set(candidate.nodeId, ranked);
  return ranked.includes(candidate);
}

function buildPathLabels(
  direction: Direction,
  startNodeId: string,
  adjacency: ReturnType<typeof buildAdjacency>,
  request: ClosedTourRequest,
  labelsPerNode: number,
  expansionLimit: number,
  controller: SearchController,
): Map<string, PathLabel[]> {
  const labels = new Map<string, PathLabel[]>();
  const frontier = new MinHeap<PathLabel>(compareLabels);
  frontier.push({
    nodeId: startNodeId,
    traversals: [],
    visitedNodeIds: new Set([startNodeId]),
    distanceMeters: 0,
    elevationGainMeters: 0,
    signature: "",
    priority: labelPriority(0, 0, request),
  });
  let expansions = 0;

  while (frontier.size > 0 && expansions < expansionLimit) {
    const state = frontier.pop()!;
    if (state.traversals.length > 0 && !(labels.get(state.nodeId) ?? []).includes(state)) continue;
    if (!controller.tryExpand()) break;
    expansions += 1;

    const traversals = direction === "outbound"
      ? adjacency.outbound.get(state.nodeId) ?? []
      : adjacency.incoming.get(state.nodeId) ?? [];
    for (const traversal of traversals) {
      const nextNodeId = direction === "outbound" ? traversal.to.id : traversal.from.id;
      if (state.visitedNodeIds.has(nextNodeId)) continue;
      const distanceMeters = state.distanceMeters + traversal.edge.lengthMeters;
      if (distanceMeters > request.distanceMeters.max) continue;
      const elevationGainMeters = state.elevationGainMeters + traversal.edge.gainMeters;
      // A path is only half a closed tour. It can never become feasible when it
      // already exceeds the whole-tour maxima.
      if (request.elevationGainMeters && elevationGainMeters > request.elevationGainMeters.max) continue;
      const path = direction === "outbound"
        ? [...state.traversals, traversal]
        : [traversal, ...state.traversals];
      const signature = path.map(({ edge }) => edge.id).join(">");
      const next: PathLabel = {
        nodeId: nextNodeId,
        traversals: path,
        visitedNodeIds: new Set([...state.visitedNodeIds, nextNodeId]),
        distanceMeters,
        elevationGainMeters,
        signature,
        priority: labelPriority(distanceMeters, elevationGainMeters, request),
      };
      if (insertBoundedLabel(labels, next, labelsPerNode)) frontier.push(next);
    }
  }
  return labels;
}

function isContinuousClosedWalk(traversals: readonly EdgeTraversal[], startNodeId: string): boolean {
  if (traversals.length === 0 || traversals[0]!.from.id !== startNodeId) return false;
  for (let index = 1; index < traversals.length; index += 1) {
    if (traversals[index - 1]!.to.id !== traversals[index]!.from.id) return false;
  }
  return traversals.at(-1)!.to.id === startNodeId;
}

function physicalEdgeCounts(traversals: readonly EdgeTraversal[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const { edge } of traversals) {
    const key = undirectedEdgeKey(edge);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function closedWalkSignature(traversals: readonly EdgeTraversal[], startNodeId: string): string {
  const keys = traversals.map(({ edge }) => undirectedEdgeKey(edge));
  const rotations: string[] = [];
  for (let index = 0; index < traversals.length; index += 1) {
    if (traversals[index]!.from.id !== startNodeId) continue;
    const rotation = [...keys.slice(index), ...keys.slice(0, index)];
    rotations.push(rotation.join(">"), [...rotation].reverse().join(">"));
  }
  return rotations.sort()[0] ?? keys.join(">");
}

function toRankedWalk(
  traversals: EdgeTraversal[],
  startNodeId: string,
  request: ClosedTourRequest,
): RankedWalk | null {
  if (!isContinuousClosedWalk(traversals, startNodeId)) return null;
  const counts = physicalEdgeCounts(traversals);
  if (counts.size < MINIMUM_PHYSICAL_EDGES) return null;
  if ([...counts.values()].some((count) => count > MAXIMUM_TRAVERSALS_PER_PHYSICAL_EDGE)) return null;
  const distanceMeters = traversals.reduce((sum, { edge }) => sum + edge.lengthMeters, 0);
  if (distanceMeters > request.distanceMeters.max) return null;
  const elevationGainMeters = traversals.reduce((sum, { edge }) => sum + edge.gainMeters, 0);
  if (request.elevationGainMeters && elevationGainMeters > request.elevationGainMeters.max) return null;
  const repeatedDistance = [...counts].reduce((sum, [key, count]) => {
    if (count < 2) return sum;
    const traversal = traversals.find(({ edge }) => undirectedEdgeKey(edge) === key)!;
    return sum + (count - 1) * traversal.edge.lengthMeters;
  }, 0);
  const exactDistance = distanceMeters >= request.distanceMeters.min;
  const exactElevationGain = !request.elevationGainMeters
    || elevationGainMeters >= request.elevationGainMeters.min;
  const score = normalizedRangeViolation(distanceMeters, request.distanceMeters) * 4
    + normalizedCenterDistance(distanceMeters, request.distanceMeters)
    + (request.elevationGainMeters
      ? normalizedRangeViolation(elevationGainMeters, request.elevationGainMeters) * 4
        + normalizedCenterDistance(elevationGainMeters, request.elevationGainMeters)
      : 0)
    + repeatedDistance / Math.max(distanceMeters, 1) * 0.2;
  return {
    traversals,
    distanceMeters,
    elevationGainMeters,
    repeatedEdgeFraction: repeatedDistance / Math.max(distanceMeters, 1),
    exactDistance,
    exactElevationGain,
    signature: closedWalkSignature(traversals, startNodeId),
    score,
  };
}

function compareRankedWalks(left: RankedWalk, right: RankedWalk): number {
  return Number(right.exactDistance && right.exactElevationGain)
    - Number(left.exactDistance && left.exactElevationGain)
    || left.score - right.score
    || left.signature.localeCompare(right.signature);
}

function retainBestWalk(
  walks: Map<string, RankedWalk>,
  candidate: RankedWalk | null,
  poolLimit: number,
): void {
  if (!candidate) return;
  const previous = walks.get(candidate.signature);
  if (!previous || compareRankedWalks(candidate, previous) < 0) walks.set(candidate.signature, candidate);
  if (walks.size <= poolLimit) return;
  const worst = [...walks.values()].sort(compareRankedWalks).at(-1)!;
  walks.delete(worst.signature);
}

function commonPrefixLength(left: readonly EdgeTraversal[], right: readonly EdgeTraversal[]): number {
  let length = 0;
  while (length < left.length && length < right.length
    && left[length]!.edge.id === right[length]!.edge.id) length += 1;
  return length;
}

function commonSuffixLength(
  left: readonly EdgeTraversal[],
  right: readonly EdgeTraversal[],
  maximum: number,
): number {
  let length = 0;
  while (length < maximum
    && left[left.length - 1 - length]!.edge.id === right[right.length - 1 - length]!.edge.id) length += 1;
  return length;
}

/**
 * Merge two start-rooted tours while traversing a shared stem only once in each
 * direction. With no shared stem this is the ordinary figure-eight A + B.
 */
function mergeClosedWalks(
  left: readonly EdgeTraversal[],
  right: readonly EdgeTraversal[],
): EdgeTraversal[] {
  const prefixLength = commonPrefixLength(left, right);
  const suffixLength = commonSuffixLength(
    left,
    right,
    Math.min(left.length - prefixLength, right.length - prefixLength),
  );
  return [
    ...left.slice(0, prefixLength),
    ...left.slice(prefixLength, left.length - suffixLength),
    ...right.slice(prefixLength, right.length - suffixLength),
    ...left.slice(left.length - suffixLength),
  ];
}

function resolveStartNodeId(start: GraphAccessPoint | string): string {
  return typeof start === "string" ? start : start.nodeId;
}

function validateRequest(request: ClosedTourRequest): void {
  for (const [name, range] of [
    ["distanceMeters", request.distanceMeters],
    ["elevationGainMeters", request.elevationGainMeters],
  ] as const) {
    if (!range) continue;
    if (!Number.isFinite(range.min) || !Number.isFinite(range.max) || range.min < 0 || range.max < range.min) {
      throw new Error(`${name} must be a finite, non-negative ordered range`);
    }
    if (range.target !== undefined
      && (!Number.isFinite(range.target) || range.target < range.min || range.target > range.max)) {
      throw new Error(`${name}.target must be within its range`);
    }
  }
}

/**
 * Generate bounded, target-directed closed walks from original graph edges.
 *
 * Multi-label searches grow diverse outbound and legal return paths toward
 * half of the requested distance/gain. Pairing happens only after both searches
 * finish, so lexicographically early short branches cannot consume the raw
 * candidate budget. A bounded composition pass joins compatible cycles into
 * figure-eights and chained-loop tours, retaining shared connectors exactly
 * once outbound and once inbound.
 */
export function generateClosedTours(
  graph: InducedGraph,
  start: GraphAccessPoint | string,
  request: ClosedTourRequest,
  options: ClosedTourGenerationOptions = {},
): ClosedTourGenerationResult {
  validateRequest(request);
  const budget = options.budget ?? DEFAULT_SOLVER_BUDGET;
  const controller = new SearchController(budget, options);
  if (!controller.checkGraphSize(graph.edges.length)) {
    return { candidates: [], diagnostics: controller.diagnostics() };
  }
  const startNodeId = resolveStartNodeId(start);
  if (!graph.nodes.has(startNodeId)) throw new Error(`Start node ${startNodeId} is not in the induced graph`);

  const labelsPerNode = Math.max(2, Math.floor(options.labelsPerNode ?? DEFAULT_LABELS_PER_NODE));
  const expansionLimit = Math.max(1, Math.floor(budget.maximumExpandedStates / 2));
  const adjacency = buildAdjacency(graph, request.includeUncertainAccess);
  const outbound = buildPathLabels(
    "outbound",
    startNodeId,
    adjacency,
    request,
    labelsPerNode,
    expansionLimit,
    controller,
  );
  const returns = buildPathLabels(
    "return",
    startNodeId,
    adjacency,
    request,
    labelsPerNode,
    expansionLimit,
    controller,
  );

  const requestedWalks = Math.max(1, Math.floor(request.maximumWalks ?? 32));
  const poolLimit = Math.max(32, Math.min(256, budget.maximumRawCandidates * 4));
  const primitives = new Map<string, RankedWalk>();
  for (const nodeId of [...outbound.keys()].sort()) {
    const outboundLabels = outbound.get(nodeId) ?? [];
    const returnLabels = returns.get(nodeId) ?? [];
    for (const outboundLabel of outboundLabels) {
      for (const returnLabel of returnLabels) {
        retainBestWalk(
          primitives,
          toRankedWalk(
            [...outboundLabel.traversals, ...returnLabel.traversals],
            startNodeId,
            request,
          ),
          poolLimit,
        );
      }
    }
  }

  const allWalks = new Map(primitives);
  const primitivePool = [...primitives.values()].sort(compareRankedWalks).slice(0, 64);
  let frontier = primitivePool;
  const maximumCompositionDepth = Math.max(
    1,
    Math.min(4, Math.floor(options.maximumCompositionDepth ?? DEFAULT_MAXIMUM_COMPOSITION_DEPTH)),
  );
  for (let depth = 2; depth <= maximumCompositionDepth && frontier.length > 0; depth += 1) {
    const next = new Map<string, RankedWalk>();
    for (const base of frontier.slice(0, 48)) {
      for (const addition of primitivePool) {
        retainBestWalk(
          next,
          toRankedWalk(
            mergeClosedWalks(base.traversals, addition.traversals),
            startNodeId,
            request,
          ),
          poolLimit,
        );
      }
    }
    for (const candidate of next.values()) retainBestWalk(allWalks, candidate, poolLimit);
    frontier = [...next.values()].sort(compareRankedWalks).slice(0, 48);
  }

  const selected: ClosedTourCandidate[] = [];
  for (const ranked of [...allWalks.values()].sort(compareRankedWalks)) {
    if (selected.length >= requestedWalks || !controller.tryRecordCandidate()) break;
    selected.push({
      traversals: ranked.traversals,
      distanceMeters: ranked.distanceMeters,
      elevationGainMeters: ranked.elevationGainMeters,
      repeatedEdgeFraction: ranked.repeatedEdgeFraction,
      exactDistance: ranked.exactDistance,
      exactElevationGain: ranked.exactElevationGain,
    });
  }
  return { candidates: selected, diagnostics: controller.diagnostics() };
}
