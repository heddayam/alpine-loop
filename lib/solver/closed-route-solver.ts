import type {
  ConstraintViolationV3,
  GenerateClosedRoutesRequestV3,
  GenerateClosedRoutesResponseV3,
} from "@/lib/contracts";
import {
  accessPointIsEligible,
  areaBounds,
  coordinateIsInsideArea,
  type AccessPointCandidate,
  type AccessTopology,
  type DecisionNetwork,
  type TopologyDecisionEdge,
} from "@/lib/graph";

import { CLOSED_ROUTE_EFFORT_BUDGETS, type SolverBudget } from "./budget";
import type { ClosedRoutePrimitive } from "./closed-route-types";
import {
  validateReconstructedClosedRoute,
  type ValidatedClosedRoute,
} from "./closed-route-validation";
import { RouteSearchCancelledError, SearchController } from "./control";
import { AccessFilterResolutionError } from "./multi-start-solver";
import type { ClosedRouteGenerationV3Context, ClosedRouteSolverV3 } from "./types";

const METERS_PER_MILE = 1_609.344;
const METERS_PER_FOOT = 0.3048;
const FIRST_PASS_ROUTES_PER_START = 2;
const MAXIMUM_ALLOWED_OVERLAP = 0.8;

type Attachment = {
  start: AccessPointCandidate;
  topology: AccessTopology;
};

type AttachmentGroup = {
  key: string;
  networkId: number;
  portalDecisionNodeId: number;
  attachments: Attachment[];
};

type Assembly = {
  start: AccessPointCandidate;
  compressedEdgeIds: readonly number[];
  primitiveIds: readonly number[];
  repaired: boolean;
};

type RankedClosedRoute = ValidatedClosedRoute & {
  exact: boolean;
  violations: ConstraintViolationV3[];
  score: number;
};

export type ClosedRouteSolverOptions = {
  pack: GenerateClosedRoutesResponseV3["pack"];
  requestIdFactory?: (request: GenerateClosedRoutesRequestV3) => string;
  sourceFreshness?: string;
  sourceConfidence?: "high" | "medium" | "low";
  fallbackSourceIds?: readonly string[];
};

function stableHash(value: string): string {
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(36).padStart(13, "0");
}

function effectiveBudget(request: GenerateClosedRoutesRequestV3, supplied: SolverBudget): SolverBudget {
  const effort = CLOSED_ROUTE_EFFORT_BUDGETS[request.searchEffort];
  // The context may intentionally lower a budget for tests or server load
  // shedding, but it cannot expand beyond the server-owned effort table.
  return {
    maximumDirectedEdges: Math.min(supplied.maximumDirectedEdges, effort.maximumDirectedEdges),
    maximumExpandedStates: Math.min(supplied.maximumExpandedStates, effort.maximumExpandedStates),
    deadlineMs: Math.min(supplied.deadlineMs, effort.deadlineMs),
    maximumRawCandidates: Math.min(supplied.maximumRawCandidates, effort.maximumRawCandidates),
  };
}

function matchesFilter(candidate: Pick<AccessPointCandidate, "lon" | "lat">, context: ClosedRouteGenerationV3Context): boolean {
  return context.accessFilter.predicates.every((geometry) => coordinateIsInsideArea([candidate.lon, candidate.lat], geometry));
}

function candidateRank(left: AccessPointCandidate, right: AccessPointCandidate, includeUnknown: boolean): number {
  const confidence = { high: 0, medium: 1, low: 2 };
  return right.knownConnectivity - left.knownConnectivity
    || right.knownOutDegree - left.knownOutDegree
    || (includeUnknown ? right.inclusiveConnectivity - left.inclusiveConnectivity : 0)
    || (includeUnknown ? right.inclusiveOutDegree - left.inclusiveOutDegree : 0)
    || Number(left.name.startsWith("OSM ")) - Number(right.name.startsWith("OSM "))
    || confidence[left.confidence] - confidence[right.confidence]
    || Number(Boolean(right.parkingEvidence)) - Number(Boolean(left.parkingEvidence))
    || left.id.localeCompare(right.id);
}

function groupAttachments(attachments: readonly Attachment[]): AttachmentGroup[] {
  const groups = new Map<string, AttachmentGroup>();
  for (const attachment of attachments) {
    const topology = attachment.topology;
    const connector = topology.connectorKey ?? topology.connectorDecisionEdgeIds.join(",");
    const key = `${topology.profile}|${topology.cycleNetworkId}|${topology.portalDecisionNodeId}|${connector}`;
    const existing = groups.get(key);
    if (existing) existing.attachments.push(attachment);
    else groups.set(key, {
      key,
      networkId: topology.cycleNetworkId!,
      portalDecisionNodeId: topology.portalDecisionNodeId!,
      attachments: [attachment],
    });
  }
  return [...groups.values()]
    .map((group) => ({ ...group, attachments: group.attachments.sort((left, right) => left.start.id.localeCompare(right.start.id)) }))
    .sort((left, right) => left.networkId - right.networkId || left.key.localeCompare(right.key));
}

type PathLabel = { nodeId: number; distance: number; edgeIds: readonly number[]; signature: string };

function shortestDecisionPath(
  network: DecisionNetwork,
  fromNodeId: number,
  toNodeId: number,
  bannedEdgeIds: ReadonlySet<number> = new Set(),
): readonly number[] | null {
  if (fromNodeId === toNodeId) return [];
  const adjacency = new Map<number, TopologyDecisionEdge[]>();
  for (const edge of network.edges) {
    if (bannedEdgeIds.has(edge.id)) continue;
    adjacency.set(edge.fromDecisionNodeId, [...(adjacency.get(edge.fromDecisionNodeId) ?? []), edge]);
  }
  for (const edges of adjacency.values()) edges.sort((left, right) => left.id - right.id);
  const frontier: PathLabel[] = [{ nodeId: fromNodeId, distance: 0, edgeIds: [], signature: "" }];
  const best = new Map<number, PathLabel>();
  while (frontier.length > 0) {
    frontier.sort((left, right) => left.distance - right.distance || left.signature.localeCompare(right.signature));
    const current = frontier.shift()!;
    const previous = best.get(current.nodeId);
    if (previous && (previous.distance < current.distance
      || (previous.distance === current.distance && previous.signature <= current.signature))) continue;
    best.set(current.nodeId, current);
    if (current.nodeId === toNodeId) return current.edgeIds;
    for (const edge of adjacency.get(current.nodeId) ?? []) {
      if (current.edgeIds.includes(edge.id)) continue;
      const edgeIds = [...current.edgeIds, edge.id];
      frontier.push({
        nodeId: edge.toDecisionNodeId,
        distance: current.distance + edge.lengthMeters,
        edgeIds,
        signature: edgeIds.join(","),
      });
    }
  }
  return null;
}

function connectorPaths(
  network: DecisionNetwork,
  fromNodeId: number,
  toNodeId: number,
  thorough: boolean,
): readonly (readonly number[])[] {
  const first = shortestDecisionPath(network, fromNodeId, toNodeId);
  if (!first) return [];
  const paths = new Map([[first.join(","), first]]);
  if (thorough) {
    for (const edgeId of first.slice(0, 4)) {
      const alternative = shortestDecisionPath(network, fromNodeId, toNodeId, new Set([edgeId]));
      if (alternative) paths.set(alternative.join(","), alternative);
      if (paths.size >= 3) break;
    }
  }
  return [...paths.values()];
}

function accessReturnPath(attachment: Attachment, network: DecisionNetwork): readonly number[] | null {
  return shortestDecisionPath(
    network,
    attachment.topology.portalDecisionNodeId!,
    attachment.topology.attachmentDecisionNodeId,
  );
}

function primitiveAtNode(
  primitive: ClosedRoutePrimitive,
  network: DecisionNetwork,
  nodeId: number,
): { edgeIds: readonly number[]; entryNodeId: number; exitNodeId: number } {
  const edgeById = new Map(network.edges.map((edge) => [edge.id, edge]));
  const index = primitive.compressedEdgeIds.findIndex((id) => edgeById.get(id)?.fromDecisionNodeId === nodeId);
  if (index < 0 || primitive.entryDecisionNodeId !== primitive.exitDecisionNodeId) {
    return {
      edgeIds: primitive.compressedEdgeIds,
      entryNodeId: primitive.entryDecisionNodeId,
      exitNodeId: primitive.exitDecisionNodeId,
    };
  }
  return {
    edgeIds: [...primitive.compressedEdgeIds.slice(index), ...primitive.compressedEdgeIds.slice(0, index)],
    entryNodeId: nodeId,
    exitNodeId: nodeId,
  };
}

function assembleSingle(
  attachment: Attachment,
  primitive: ClosedRoutePrimitive,
  network: DecisionNetwork,
  thorough: boolean,
): Assembly[] {
  const placed = primitiveAtNode(primitive, network, attachment.topology.portalDecisionNodeId!);
  const toCycle = connectorPaths(
    network,
    attachment.topology.portalDecisionNodeId!,
    placed.entryNodeId,
    thorough,
  );
  const fromCycle = connectorPaths(
    network,
    placed.exitNodeId,
    attachment.topology.portalDecisionNodeId!,
    thorough,
  );
  const accessReturn = accessReturnPath(attachment, network);
  if (toCycle.length === 0 || fromCycle.length === 0 || accessReturn === null) return [];
  const assemblies: Assembly[] = [];
  for (const outward of toCycle) {
    for (const returning of fromCycle) {
      assemblies.push({
        start: attachment.start,
        compressedEdgeIds: [
          ...attachment.topology.connectorDecisionEdgeIds,
          ...outward,
          ...placed.edgeIds,
          ...returning,
          ...accessReturn,
        ],
        primitiveIds: [primitive.id],
        repaired: outward !== toCycle[0] || returning !== fromCycle[0],
      });
    }
  }
  return assemblies;
}

function assembleMultiple(
  attachment: Attachment,
  primitives: readonly ClosedRoutePrimitive[],
  network: DecisionNetwork,
): Assembly | null {
  if (primitives.length < 2) return null;
  const accessReturn = accessReturnPath(attachment, network);
  if (accessReturn === null) return null;
  const edgeIds: number[] = [...attachment.topology.connectorDecisionEdgeIds];
  let current = attachment.topology.portalDecisionNodeId!;
  for (const primitive of primitives) {
    const placed = primitiveAtNode(primitive, network, current);
    const connector = shortestDecisionPath(network, current, placed.entryNodeId);
    if (!connector) return null;
    edgeIds.push(...connector, ...placed.edgeIds);
    current = placed.exitNodeId;
  }
  const returnToPortal = shortestDecisionPath(network, current, attachment.topology.portalDecisionNodeId!);
  if (!returnToPortal) return null;
  edgeIds.push(...returnToPortal, ...accessReturn);
  return {
    start: attachment.start,
    compressedEdgeIds: edgeIds,
    primitiveIds: primitives.map(({ id }) => id),
    repaired: true,
  };
}

function violation(
  constraint: ConstraintViolationV3["constraint"],
  value: number,
  min: number,
  max: number,
): ConstraintViolationV3 | null {
  if (value >= min && value <= max) return null;
  const delta = value < min ? min - value : value - max;
  const scale = Math.max(Math.abs(max - min), Math.abs(min), Math.abs(max), 1);
  return { constraint, value, min, max, delta, normalizedDelta: delta / scale };
}

function centerDistance(value: number, min: number, max: number): number {
  return Math.abs(value - (min + max) / 2) / Math.max(Math.abs(max - min), Math.abs(min), Math.abs(max), 1);
}

function rankRoute(value: ValidatedClosedRoute, request: GenerateClosedRoutesRequestV3): RankedClosedRoute {
  const route = value.route;
  const ranges: Array<{ constraint: ConstraintViolationV3["constraint"]; value: number; min: number; max: number }> = [{
    constraint: "distance",
    value: route.distanceMeters,
    min: request.distanceMiles.min * METERS_PER_MILE,
    max: request.distanceMiles.max * METERS_PER_MILE,
  }];
  if (request.elevationGainFeet) ranges.push({
    constraint: "elevation-gain",
    value: route.elevationGainMeters,
    min: request.elevationGainFeet.min * METERS_PER_FOOT,
    max: request.elevationGainFeet.max * METERS_PER_FOOT,
  });
  if (request.maximumElevationFeet) ranges.push({
    constraint: "maximum-elevation",
    value: route.maximumElevationMeters,
    min: request.maximumElevationFeet.min * METERS_PER_FOOT,
    max: request.maximumElevationFeet.max * METERS_PER_FOOT,
  });
  if (request.steepestSustainedGradePct) ranges.push({
    constraint: "steepest-sustained-grade",
    value: route.steepestSustainedGradePct,
    min: request.steepestSustainedGradePct.min,
    max: request.steepestSustainedGradePct.max,
  });
  ranges.push({
    constraint: "repeated-trail",
    value: route.topology.repeatedTrailFraction * 100,
    min: 0,
    max: request.closedRoute.maximumRepeatedTrailPct,
  });
  if (request.closedRoute.maximumSharedStemMiles !== undefined) ranges.push({
    constraint: "shared-stem",
    value: route.topology.sharedStemDistanceMeters,
    min: 0,
    max: request.closedRoute.maximumSharedStemMiles * METERS_PER_MILE,
  });
  const violations = ranges.map(({ constraint, value: metric, min, max }) =>
    violation(constraint, metric, min, max)).filter((item): item is ConstraintViolationV3 => item !== null);
  const centerScore = ranges
    .filter(({ constraint }) => constraint !== "repeated-trail" && constraint !== "shared-stem")
    .reduce((sum, range) => sum + centerDistance(range.value, range.min, range.max), 0);
  const confidencePenalty = { high: 0, medium: 0.1, low: 0.2 }[route.startAccessPoint.confidence];
  const continuityPenalty = route.trailNames.length > 0 ? Math.max(0, route.trailNames.length - 1) * 0.03 : 0.1;
  return {
    ...value,
    exact: violations.length === 0,
    violations,
    score: centerScore + route.topology.repeatedTrailFraction
      + route.topology.sharedStemDistanceMeters / Math.max(route.distanceMeters, 1)
      + continuityPenalty + confidencePenalty,
  };
}

function compareRanked(left: RankedClosedRoute, right: RankedClosedRoute): number {
  return Number(left.exact !== right.exact) * (left.exact ? -1 : 1)
    || left.violations.length - right.violations.length
    || left.violations.reduce((sum, item) => sum + item.normalizedDelta, 0)
      - right.violations.reduce((sum, item) => sum + item.normalizedDelta, 0)
    || left.score - right.score
    || left.route.id.localeCompare(right.route.id);
}

function physicalOverlap(candidate: RankedClosedRoute, selected: RankedClosedRoute): number {
  const candidateDistances = new Map<number, number>();
  for (const edge of candidate.edges) {
    candidateDistances.set(edge.physicalEdgeKey, Math.max(candidateDistances.get(edge.physicalEdgeKey) ?? 0, edge.lengthMeters));
  }
  const selectedKeys = selected.physicalEdgeKeys;
  const total = [...candidateDistances.values()].reduce((sum, distance) => sum + distance, 0);
  const overlap = [...candidateDistances].reduce(
    (sum, [key, distance]) => sum + (selectedKeys.has(key) ? distance : 0),
    0,
  );
  return total > 0 ? overlap / total : 0;
}

function selectDiverse(
  ranked: readonly RankedClosedRoute[],
  limit: number,
  alreadySelected: readonly RankedClosedRoute[] = [],
): RankedClosedRoute[] {
  const selected: RankedClosedRoute[] = [];
  const counts = new Map<string, number>();
  for (const route of alreadySelected) {
    counts.set(route.route.startAccessPoint.id, (counts.get(route.route.startAccessPoint.id) ?? 0) + 1);
  }
  const overlaps = (candidate: RankedClosedRoute): boolean => [...alreadySelected, ...selected]
    .some((other) => physicalOverlap(candidate, other) > MAXIMUM_ALLOWED_OVERLAP);
  for (const candidate of ranked) {
    if (selected.length >= limit) break;
    const startId = candidate.route.startAccessPoint.id;
    if ((counts.get(startId) ?? 0) >= FIRST_PASS_ROUTES_PER_START || overlaps(candidate)) continue;
    selected.push(candidate);
    counts.set(startId, (counts.get(startId) ?? 0) + 1);
  }
  for (const candidate of ranked) {
    if (selected.length >= limit) break;
    if (selected.some(({ route }) => route.id === candidate.route.id) || overlaps(candidate)) continue;
    selected.push(candidate);
  }
  return selected;
}

function safelyFeasible(
  topology: AccessTopology,
  maximumDistanceMeters: number,
  maximumRepeatedFraction: number,
  maximumSharedStemMeters?: number,
): boolean {
  if (!topology.canReachCycle || topology.cycleNetworkId === null || topology.portalDecisionNodeId === null) return false;
  const stem = topology.minimumStemDistanceMeters ?? 0;
  if (stem * 2 > maximumDistanceMeters) return false;
  if (stem > maximumDistanceMeters * maximumRepeatedFraction) return false;
  if (maximumSharedStemMeters !== undefined && stem > maximumSharedStemMeters) return false;
  return true;
}

export class TopologyFirstClosedRouteSolver implements ClosedRouteSolverV3 {
  constructor(private readonly options: ClosedRouteSolverOptions) {}

  async generate(
    request: GenerateClosedRoutesRequestV3,
    context: ClosedRouteGenerationV3Context,
  ): Promise<GenerateClosedRoutesResponseV3> {
    if (request.packId !== this.options.pack.id
      || context.repository.packId !== request.packId
      || context.topologyRepository.packId !== request.packId) {
      throw new Error(`Closed-route solver pack mismatch for ${request.packId}`);
    }
    if (context.topologyRepository.dataVersion !== this.options.pack.dataVersion) {
      throw new Error(`Closed-route topology data version mismatch for ${request.packId}`);
    }
    if (context.signal?.aborted) throw new RouteSearchCancelledError(context.signal.reason);
    const now = context.now ?? Date.now;
    const startedAt = now();
    const budget = effectiveBudget(request, context.budget);
    const controller = new SearchController(budget, { signal: context.signal, now });
    const profile = request.includeUncertainAccess ? "inclusive" : "known";
    const coverageBbox = areaBounds(context.accessFilter.coverage);
    const allCandidates = await context.repository.getAccessPointCandidates({
      bbox: coverageBbox,
      includeUncertainAccess: true,
      signal: context.signal,
    });
    const filtered = allCandidates.filter((candidate) => matchesFilter(candidate, context));
    const eligible = filtered.filter((candidate) => accessPointIsEligible(candidate, request.includeUncertainAccess));
    let starts: AccessPointCandidate[];
    if (request.startAccessPointId) {
      const known = allCandidates.find(({ id }) => id === request.startAccessPointId);
      if (!known) throw new AccessFilterResolutionError("START_NOT_FOUND", "The selected access point was not found");
      if (!matchesFilter(known, context)) {
        throw new AccessFilterResolutionError("START_OUTSIDE_FILTER", "The selected access point is outside the trailhead filter");
      }
      if (!accessPointIsEligible(known, request.includeUncertainAccess)) {
        throw new AccessFilterResolutionError("START_INELIGIBLE", "The selected access point is excluded by the access policy");
      }
      starts = [known];
    } else {
      // Deliberately no fixed start cap: every eligible access point reaches
      // topology feasibility and fair attachment-group scheduling.
      starts = [...eligible].sort((left, right) => candidateRank(left, right, request.includeUncertainAccess));
    }

    const accessTopologies = await context.topologyRepository.getAccessTopology(profile, starts.map(({ id }) => id));
    const topologyByStart = new Map(accessTopologies.map((topology) => [topology.accessPointId, topology]));
    const noCycleAccessPointCount = starts.filter(({ id }) => !topologyByStart.get(id)?.canReachCycle).length;
    const maximumDistanceMeters = request.distanceMiles.max * METERS_PER_MILE;
    const maximumRepeatedFraction = request.closedRoute.maximumRepeatedTrailPct / 100;
    const maximumSharedStemMeters = request.closedRoute.maximumSharedStemMiles === undefined
      ? undefined
      : request.closedRoute.maximumSharedStemMiles * METERS_PER_MILE;
    const feasibleAttachments: Attachment[] = [];
    for (const start of starts) {
      const topology = topologyByStart.get(start.id);
      if (!topology || !safelyFeasible(topology, maximumDistanceMeters, maximumRepeatedFraction, maximumSharedStemMeters)) continue;
      // The persisted minimum cycle length is a conservative exact lower bound.
      const summary = await context.topologyRepository.getNetworkSummary(profile, topology.cycleNetworkId!);
      const minimumCycle = summary.minimumCycleLengthMeters ?? 0;
      if (2 * (topology.minimumStemDistanceMeters ?? 0) + minimumCycle > maximumDistanceMeters) continue;
      feasibleAttachments.push({ start, topology });
    }
    const groups = groupAttachments(feasibleAttachments);
    const hardTruncationReasons = new Set<string>();
    const nonBudgetShortfallReasons = new Set<string>();
    const networkCache = new Map<number, DecisionNetwork>();
    const primitivesByNetwork = new Map<number, ClosedRoutePrimitive[]>();
    let loadedDecisionEdges = 0;
    let cycleBlockCount = 0;
    let cyclePrimitiveCount = 0;
    let probedAttachmentGroupCount = 0;
    let deeplySearchedAttachmentGroupCount = 0;
    let composedCandidateCount = 0;
    let repairedCandidateCount = 0;
    let directedValidationRejectionCount = 0;
    let timeToFirstExactMs: number | undefined;
    const candidates = new Map<string, RankedClosedRoute>();

    const loadNetwork = async (networkId: number): Promise<DecisionNetwork | null> => {
      const cached = networkCache.get(networkId);
      if (cached) return cached;
      controller.checkCancellation();
      const network = await context.topologyRepository.loadDecisionNetwork(profile, networkId);
      if (loadedDecisionEdges + network.edges.length > budget.maximumDirectedEdges) {
        hardTruncationReasons.add("maximum-directed-edges");
        return null;
      }
      loadedDecisionEdges += network.edges.length;
      networkCache.set(networkId, network);
      const primitives: ClosedRoutePrimitive[] = [];
      for (const block of [...network.blocks].sort((left, right) => left.id - right.id)) {
        if (block.kind !== "vertex-cycle" || block.cycleRank < 1) continue;
        cycleBlockCount += 1;
        primitives.push(...await context.primitiveCatalog.getPrimitives(network, block, context.signal));
      }
      primitives.sort((left, right) => left.distanceMeters - right.distanceMeters
        || left.elevationGainMeters - right.elevationGainMeters || left.id - right.id);
      cyclePrimitiveCount += primitives.length;
      primitivesByNetwork.set(networkId, primitives);
      return network;
    };

    const evaluate = async (assembly: Assembly): Promise<void> => {
      if (!controller.tryExpand()) {
        for (const reason of controller.diagnostics().truncationReasons) hardTruncationReasons.add(reason);
        return;
      }
      if (!controller.tryRecordCandidate()) {
        for (const reason of controller.diagnostics().truncationReasons) hardTruncationReasons.add(reason);
        return;
      }
      composedCandidateCount += 1;
      if (assembly.repaired) repairedCandidateCount += 1;
      let reconstructed;
      try {
        reconstructed = await context.topologyRepository.reconstructDirectedEdges(assembly.compressedEdgeIds);
      } catch {
        directedValidationRejectionCount += 1;
        return;
      }
      const routeId = `closed_${stableHash(`${assembly.start.id}|${reconstructed.map(({ physicalEdgeKey }) => physicalEdgeKey).join(">")}`)}`;
      const validated = validateReconstructedClosedRoute(reconstructed, {
        compressedEdgeIds: assembly.compressedEdgeIds,
        start: assembly.start,
        includeUncertainAccess: request.includeUncertainAccess,
        coverage: context.accessFilter.coverage,
        sourceFreshness: this.options.sourceFreshness ?? this.options.pack.builtAt,
        sourceConfidence: this.options.sourceConfidence ?? "high",
        fallbackSourceIds: this.options.fallbackSourceIds ?? [`${this.options.pack.id}:manifest`],
        routeId,
      });
      if (!validated.valid) {
        directedValidationRejectionCount += 1;
        return;
      }
      if (!request.closedRoute.allowMultiCycle && validated.value.route.topology.cycleCount > 1) return;
      const ranked = rankRoute(validated.value, request);
      const previous = candidates.get(routeId);
      if (!previous || compareRanked(ranked, previous) < 0) candidates.set(routeId, ranked);
      if (ranked.exact && timeToFirstExactMs === undefined) timeToFirstExactMs = Math.max(0, now() - startedAt);
    };

    // Fair shallow pass: exactly one stable seed per start in every feasible
    // attachment group before any group is deepened.
    for (const group of groups) {
      const network = await loadNetwork(group.networkId);
      if (!network) break;
      const primitives = primitivesByNetwork.get(group.networkId) ?? [];
      probedAttachmentGroupCount += 1;
      const seed = primitives[0];
      if (!seed) continue;
      for (const attachment of group.attachments) {
        const assembly = assembleSingle(attachment, seed, network, false)[0];
        if (assembly) await evaluate(assembly);
      }
    }

    // Thorough widens every group in the same stable order. Quick performs the
    // universal probe, then deepens only while its smaller global budget lasts.
    for (const group of groups) {
      if (hardTruncationReasons.size > 0) break;
      const network = networkCache.get(group.networkId);
      const primitives = primitivesByNetwork.get(group.networkId) ?? [];
      if (!network || primitives.length === 0) continue;
      deeplySearchedAttachmentGroupCount += 1;
      for (const attachment of group.attachments) {
        const orderedSeeds = [...primitives].sort((left, right) => {
          const targetDistance = (request.distanceMiles.min + request.distanceMiles.max) * METERS_PER_MILE / 2;
          const leftDistance = Math.abs(left.distanceMeters + 2 * (attachment.topology.minimumStemDistanceMeters ?? 0) - targetDistance);
          const rightDistance = Math.abs(right.distanceMeters + 2 * (attachment.topology.minimumStemDistanceMeters ?? 0) - targetDistance);
          return leftDistance - rightDistance
            || left.repeatedDistanceMeters - right.repeatedDistanceMeters
            || Math.abs(left.elevationGainMeters - ((request.elevationGainFeet?.min ?? 0) + (request.elevationGainFeet?.max ?? 0)) * METERS_PER_FOOT / 2)
              - Math.abs(right.elevationGainMeters - ((request.elevationGainFeet?.min ?? 0) + (request.elevationGainFeet?.max ?? 0)) * METERS_PER_FOOT / 2)
            || left.id - right.id;
        });
        for (const primitive of orderedSeeds) {
          for (const assembly of assembleSingle(attachment, primitive, network, request.searchEffort === "thorough")) {
            await evaluate(assembly);
            if (hardTruncationReasons.size > 0) break;
          }
          if (hardTruncationReasons.size > 0) break;
        }
        if (request.closedRoute.allowMultiCycle && hardTruncationReasons.size === 0) {
          // Insert/swap/remove neighborhood: pairs are insertion repairs, and
          // each constituent single-cycle seed supplies the corresponding
          // removal neighbor. Stable adjacent and structurally distinct pairs
          // avoid a quadratic all-elementary-cycle explosion.
          const pairLimit = request.searchEffort === "thorough" ? 32 : 4;
          const pairs: Array<readonly [ClosedRoutePrimitive, ClosedRoutePrimitive]> = [];
          // Prefer insertions from a different cycle block, then consider
          // same-block replacement neighbors. This is deterministic and gives
          // chained/figure-eight repairs a chance before local variants consume
          // the bounded neighborhood.
          for (let left = 0; left < orderedSeeds.length && pairs.length < pairLimit; left += 1) {
            for (let right = left + 1; right < orderedSeeds.length && pairs.length < pairLimit; right += 1) {
              if (orderedSeeds[left]!.blockId !== orderedSeeds[right]!.blockId) {
                pairs.push([orderedSeeds[left]!, orderedSeeds[right]!]);
              }
            }
          }
          for (let index = 0; index + 1 < orderedSeeds.length && pairs.length < pairLimit; index += 1) {
            const pair = [orderedSeeds[index]!, orderedSeeds[index + 1]!] as const;
            if (!pairs.some(([left, right]) => left.id === pair[0].id && right.id === pair[1].id)) pairs.push(pair);
          }
          for (const pair of pairs) {
            const assembly = assembleMultiple(attachment, pair, network);
            if (assembly) await evaluate(assembly);
            if (hardTruncationReasons.size > 0) break;
          }
        }
        if (hardTruncationReasons.size > 0) break;
      }
    }

    for (const reason of controller.diagnostics().truncationReasons) hardTruncationReasons.add(reason);
    if (eligible.length === 0) nonBudgetShortfallReasons.add("no-eligible-start-access-points");
    if (starts.length > 0 && noCycleAccessPointCount === starts.length) nonBudgetShortfallReasons.add("no-cycle-access-points");
    if (groups.some((group) => !(primitivesByNetwork.get(group.networkId)?.length))) {
      nonBudgetShortfallReasons.add("no-cycle-primitives");
    }
    if (request.searchEffort === "quick" && deeplySearchedAttachmentGroupCount < groups.length) {
      nonBudgetShortfallReasons.add("quick-groups-not-deeply-searched");
    }
    const ranked = [...candidates.values()].sort(compareRanked);
    const exact = selectDiverse(ranked.filter(({ exact: isExact }) => isExact), request.limit);
    const nearMisses = selectDiverse(ranked.filter(({ exact: isExact }) => !isExact), 3, exact);
    if (exact.length < request.limit) nonBudgetShortfallReasons.add("fewer-exact-routes-than-requested");
    const controllerDiagnostics = controller.diagnostics();
    const truncationReasons = [...hardTruncationReasons].sort();
    const shortfallReasons = [...nonBudgetShortfallReasons].sort();
    return {
      version: 3,
      requestId: this.options.requestIdFactory?.(request) ?? `closed-route-request-${stableHash(JSON.stringify(request))}`,
      pack: this.options.pack,
      requested: request.limit,
      resolvedAccessFilter: context.accessFilter.summary,
      exact: exact.map(({ route }) => route),
      nearMisses: nearMisses.map(({ route, violations }) => ({ ...route, violations })),
      diagnostics: {
        elapsedMs: Math.max(0, now() - startedAt),
        expandedStates: controllerDiagnostics.expandedStates,
        candidateCount: candidates.size,
        eligibleAccessPointCount: eligible.length,
        searchedAccessPointCount: feasibleAttachments.length,
        graphQueryCount: networkCache.size,
        maximumLoadedDirectedEdges: Math.max(0, ...[...networkCache.values()].map(({ edges }) => edges.length)),
        exhausted: truncationReasons.length > 0,
        truncationReasons,
        shortfallReasons,
        noCycleAccessPointCount,
        feasibleAccessPointCount: feasibleAttachments.length,
        attachmentGroupCount: groups.length,
        probedAttachmentGroupCount,
        deeplySearchedAttachmentGroupCount,
        loadedTopologyNetworkCount: networkCache.size,
        cycleBlockCount,
        cyclePrimitiveCount,
        composedCandidateCount,
        repairedCandidateCount,
        directedValidationRejectionCount,
        expandedAssemblyStates: controllerDiagnostics.expandedStates,
        ...(timeToFirstExactMs === undefined ? {} : { timeToFirstExactMs }),
        hardTruncationReasons: truncationReasons,
        nonBudgetShortfallReasons: shortfallReasons,
      },
    };
  }
}

export function createClosedRouteSolver(options: ClosedRouteSolverOptions): ClosedRouteSolverV3 {
  return new TopologyFirstClosedRouteSolver(options);
}
