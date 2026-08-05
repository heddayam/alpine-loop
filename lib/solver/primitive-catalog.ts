import type { DecisionNetwork, TopologyBlock, TopologyDecisionEdge } from "@/lib/graph";

import { RouteSearchCancelledError } from "./control";
import {
  DEFAULT_CLOSED_ROUTE_PRIMITIVE_POLICY,
  type ClosedRoutePrimitive,
  type ClosedRoutePrimitiveCatalog,
  type ClosedRoutePrimitivePolicy,
  type PrimitiveCatalogDiagnostics,
} from "./closed-route-types";

const DEFAULT_MAXIMUM_RESIDENT_BYTES = 32 * 1024 * 1024;

export type ClosedRoutePrimitiveCatalogOptions = {
  dataVersion: string;
  maximumResidentBytes?: number;
  policy?: ClosedRoutePrimitivePolicy;
};

type CacheEntry = {
  primitives: readonly ClosedRoutePrimitive[];
  bytes: number;
};

type PathState = {
  nodeId: number;
  edgeIds: readonly number[];
  cost: number;
  signature: string;
};

function stableHashInt(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function checkCancellation(signal?: AbortSignal): void {
  if (signal?.aborted) throw new RouteSearchCancelledError(signal.reason);
}

function rotatedMinimum(values: readonly number[]): string {
  if (values.length === 0) return "";
  let best = values.join(",");
  for (let offset = 1; offset < values.length; offset += 1) {
    const rotated = [...values.slice(offset), ...values.slice(0, offset)].join(",");
    if (rotated < best) best = rotated;
  }
  return best;
}

function physicalCycleKey(edgeIds: readonly number[], edges: ReadonlyMap<number, TopologyDecisionEdge>): string {
  const physical = edgeIds.flatMap((id) => edges.get(id)?.members.map(({ physicalEdgeKey }) => physicalEdgeKey) ?? []);
  const forward = rotatedMinimum(physical);
  const reverse = rotatedMinimum([...physical].reverse());
  return forward < reverse ? forward : reverse;
}

function popNearest(frontier: PathState[]): PathState | undefined {
  if (frontier.length === 0) return undefined;
  let bestIndex = 0;
  for (let index = 1; index < frontier.length; index += 1) {
    const candidate = frontier[index]!;
    const best = frontier[bestIndex]!;
    if (candidate.cost < best.cost || (candidate.cost === best.cost && candidate.signature < best.signature)) {
      bestIndex = index;
    }
  }
  return frontier.splice(bestIndex, 1)[0];
}

function shortestPath(
  fromNodeId: number,
  toNodeId: number,
  excludedEdgeId: number,
  excludedPhysicalEdgeKeys: ReadonlySet<number>,
  adjacency: ReadonlyMap<number, readonly TopologyDecisionEdge[]>,
  order: number,
  signal?: AbortSignal,
): readonly number[] | null {
  const frontier: PathState[] = [{ nodeId: fromNodeId, edgeIds: [], cost: 0, signature: "" }];
  const best = new Map<number, { cost: number; signature: string }>();
  let checks = 0;
  while (frontier.length > 0) {
    if ((checks++ & 63) === 0) checkCancellation(signal);
    const current = popNearest(frontier)!;
    const settled = best.get(current.nodeId);
    if (settled && (settled.cost < current.cost || (settled.cost === current.cost && settled.signature <= current.signature))) {
      continue;
    }
    best.set(current.nodeId, { cost: current.cost, signature: current.signature });
    if (current.nodeId === toNodeId) return current.edgeIds;
    const outgoing = adjacency.get(current.nodeId) ?? [];
    for (const edge of outgoing) {
      if (edge.id === excludedEdgeId
        || edge.members.some(({ physicalEdgeKey }) => excludedPhysicalEdgeKeys.has(physicalEdgeKey))
        || current.edgeIds.includes(edge.id)) continue;
      // Length remains the dominant term. The tiny, stable order perturbation
      // produces different equal/near-equal tree and path orders without
      // introducing randomness or invalidating the metric bound.
      const rank = order === 0
        ? edge.id
        : order === 1
          ? 0xffff_ffff - edge.id
          : order === 2
            ? stableHashInt(`${edge.toDecisionNodeId}:${edge.id}`)
            : stableHashInt(`${edge.id}:${edge.fromDecisionNodeId}`);
      const cost = current.cost + edge.lengthMeters + (rank % 997) * 1e-9;
      const edgeIds = [...current.edgeIds, edge.id];
      frontier.push({
        nodeId: edge.toDecisionNodeId,
        edgeIds,
        cost,
        signature: edgeIds.join(","),
      });
    }
  }
  return null;
}

function primitiveMetrics(
  edgeIds: readonly number[],
  edgeById: ReadonlyMap<number, TopologyDecisionEdge>,
): Omit<ClosedRoutePrimitive, "id" | "policyVersion" | "profile" | "networkId" | "blockId"> {
  const edges = edgeIds.map((id) => edgeById.get(id)!);
  const physical = edges.flatMap((edge) => edge.members.map(({ physicalEdgeKey }) => physicalEdgeKey));
  const counts = new Map<number, { count: number; length: number }>();
  for (const edge of edges) {
    const memberLength = edge.members.length > 0 ? edge.lengthMeters / edge.members.length : edge.lengthMeters;
    for (const { physicalEdgeKey } of edge.members) {
      const value = counts.get(physicalEdgeKey) ?? { count: 0, length: memberLength };
      value.count += 1;
      value.length = Math.max(value.length, memberLength);
      counts.set(physicalEdgeKey, value);
    }
  }
  const repeatedDistanceMeters = [...counts.values()].reduce(
    (sum, value) => sum + Math.max(0, value.count - 1) * value.length,
    0,
  );
  return {
    entryDecisionNodeId: edges[0]!.fromDecisionNodeId,
    exitDecisionNodeId: edges.at(-1)!.toDecisionNodeId,
    compressedEdgeIds: edgeIds,
    physicalEdgeSignature: [...new Set(physical)].sort((left, right) => left - right),
    distanceMeters: edges.reduce((sum, edge) => sum + edge.lengthMeters, 0),
    elevationGainMeters: edges.reduce((sum, edge) => sum + edge.gainMeters, 0),
    elevationLossMeters: edges.reduce((sum, edge) => sum + edge.lossMeters, 0),
    maximumElevationMeters: edges.some(({ maximumElevationMeters }) => maximumElevationMeters !== null)
      ? Math.max(...edges.map(({ maximumElevationMeters }) => maximumElevationMeters ?? Number.NEGATIVE_INFINITY))
      : null,
    maximumSustainedGradePct: edges.some(({ maximumSustainedGradePct }) => maximumSustainedGradePct !== null)
      ? Math.max(...edges.map(({ maximumSustainedGradePct }) => maximumSustainedGradePct ?? 0))
      : null,
    repeatedDistanceMeters,
    cycleCount: 1,
    trailNames: [...new Set(edges.flatMap(({ trailNames }) => trailNames))].sort(),
  };
}

function estimateBytes(primitives: readonly ClosedRoutePrimitive[]): number {
  return primitives.reduce(
    (sum, primitive) => sum + 160 + primitive.compressedEdgeIds.length * 8
      + primitive.physicalEdgeSignature.length * 8 + primitive.trailNames.join("").length * 2,
    0,
  );
}

export class DeterministicClosedRoutePrimitiveCatalog implements ClosedRoutePrimitiveCatalog {
  readonly #policy: ClosedRoutePrimitivePolicy;
  readonly #maximumResidentBytes: number;
  #dataVersion: string;
  readonly #cache = new Map<string, CacheEntry>();
  #hits = 0;
  #misses = 0;
  #generationCount = 0;
  #generatedPrimitiveCount = 0;
  #discardedPrimitiveCount = 0;
  #residentBytes = 0;
  #evictions = 0;

  constructor(options: ClosedRoutePrimitiveCatalogOptions) {
    if (!options.dataVersion) throw new Error("Primitive catalog requires a pack data version");
    this.#dataVersion = options.dataVersion;
    this.#maximumResidentBytes = options.maximumResidentBytes ?? DEFAULT_MAXIMUM_RESIDENT_BYTES;
    this.#policy = options.policy ?? DEFAULT_CLOSED_ROUTE_PRIMITIVE_POLICY;
    if (this.#maximumResidentBytes < 0) throw new Error("Primitive cache byte budget must be non-negative");
  }

  async getPrimitives(
    network: DecisionNetwork,
    block: TopologyBlock,
    signal?: AbortSignal,
  ): Promise<readonly ClosedRoutePrimitive[]> {
    checkCancellation(signal);
    const key = [this.#dataVersion, network.profile, network.networkId, block.id, this.#policy.version, network.contentHash].join("|");
    const cached = this.#cache.get(key);
    if (cached) {
      this.#hits += 1;
      this.#cache.delete(key);
      this.#cache.set(key, cached);
      return cached.primitives;
    }
    this.#misses += 1;
    this.#generationCount += 1;
    const generated = this.#generate(network, block, signal);
    this.#generatedPrimitiveCount += generated.generatedCount;
    this.#discardedPrimitiveCount += generated.generatedCount - generated.primitives.length;
    const bytes = estimateBytes(generated.primitives);
    if (bytes <= this.#maximumResidentBytes) {
      while (this.#residentBytes + bytes > this.#maximumResidentBytes && this.#cache.size > 0) {
        const oldestKey = this.#cache.keys().next().value as string;
        const oldest = this.#cache.get(oldestKey)!;
        this.#cache.delete(oldestKey);
        this.#residentBytes -= oldest.bytes;
        this.#evictions += 1;
      }
      this.#cache.set(key, { primitives: generated.primitives, bytes });
      this.#residentBytes += bytes;
    }
    return generated.primitives;
  }

  #generate(network: DecisionNetwork, block: TopologyBlock, signal?: AbortSignal): {
    primitives: readonly ClosedRoutePrimitive[];
    generatedCount: number;
  } {
    if (block.kind !== "vertex-cycle" || block.cycleRank < 1) return { primitives: [], generatedCount: 0 };
    const allowed = new Set(block.decisionEdgeIds);
    const edgeById = new Map(network.edges.filter(({ id }) => allowed.has(id)).map((edge) => [edge.id, edge]));
    const adjacency = new Map<number, TopologyDecisionEdge[]>();
    for (const edge of edgeById.values()) {
      const outgoing = adjacency.get(edge.fromDecisionNodeId) ?? [];
      outgoing.push(edge);
      adjacency.set(edge.fromDecisionNodeId, outgoing);
    }
    for (const edges of adjacency.values()) edges.sort((left, right) => left.id - right.id);

    const byPhysicalCycle = new Map<string, readonly number[]>();
    const orders = Math.max(1, Math.min(4, this.#policy.maximumStableSpanningTreeOrders));
    for (let order = 0; order < orders; order += 1) {
      for (const edge of [...edgeById.values()].sort((left, right) => order % 2 === 0 ? left.id - right.id : right.id - left.id)) {
        checkCancellation(signal);
        const returnPath = shortestPath(
          edge.toDecisionNodeId,
          edge.fromDecisionNodeId,
          edge.id,
          new Set(edge.members.map(({ physicalEdgeKey }) => physicalEdgeKey)),
          adjacency,
          order,
          signal,
        );
        if (!returnPath || returnPath.length === 0) continue;
        const cycle = [edge.id, ...returnPath];
        const physicalSequence = cycle.flatMap((id) =>
          edgeById.get(id)?.members.map(({ physicalEdgeKey }) => physicalEdgeKey) ?? []);
        // Opposite directed traversals of one physical edge are a two-edge
        // walk, not a cycle in the physical trail graph.
        if (new Set(physicalSequence).size !== physicalSequence.length) continue;
        const key = physicalCycleKey(cycle, edgeById);
        const existing = byPhysicalCycle.get(key);
        if (!existing || cycle.join(",") < existing.join(",")) byPhysicalCycle.set(key, cycle);
      }
    }

    const generatedCount = byPhysicalCycle.size;
    const primitives = [...byPhysicalCycle.values()].map((edgeIds) => {
      const metrics = primitiveMetrics(edgeIds, edgeById);
      return {
        id: stableHashInt(`${network.profile}|${network.networkId}|${block.id}|${edgeIds.join(",")}`),
        policyVersion: this.#policy.version,
        profile: network.profile,
        networkId: network.networkId,
        blockId: block.id,
        ...metrics,
      } satisfies ClosedRoutePrimitive;
    });
    const bucketKey = (primitive: ClosedRoutePrimitive) => [
      Math.floor(primitive.distanceMeters / Math.max(1, this.#policy.distanceBucketMeters)),
      Math.floor(primitive.elevationGainMeters / Math.max(1, this.#policy.elevationBucketMeters)),
      Math.floor(primitive.repeatedDistanceMeters / Math.max(1, this.#policy.distanceBucketMeters)),
      primitive.trailNames.join("/"),
    ].join("|");
    const archive = new Map<string, ClosedRoutePrimitive>();
    for (const primitive of primitives.sort((left, right) =>
      left.repeatedDistanceMeters - right.repeatedDistanceMeters
      || left.distanceMeters - right.distanceMeters
      || left.elevationGainMeters - right.elevationGainMeters
      || left.compressedEdgeIds.join(",").localeCompare(right.compressedEdgeIds.join(",")))) {
      const bucket = bucketKey(primitive);
      const signatureBucket = `${bucket}|${primitive.physicalEdgeSignature.join(",")}`;
      if (!archive.has(signatureBucket)) archive.set(signatureBucket, primitive);
    }
    const retained = [...archive.values()]
      .sort((left, right) => left.distanceMeters - right.distanceMeters
        || left.elevationGainMeters - right.elevationGainMeters
        || left.id - right.id)
      .slice(0, this.#policy.maximumPrimitivesPerBlock);
    return { primitives: Object.freeze(retained), generatedCount };
  }

  getDiagnostics(): PrimitiveCatalogDiagnostics {
    return {
      hits: this.#hits,
      misses: this.#misses,
      generationCount: this.#generationCount,
      generatedPrimitiveCount: this.#generatedPrimitiveCount,
      discardedPrimitiveCount: this.#discardedPrimitiveCount,
      residentBytes: this.#residentBytes,
      evictions: this.#evictions,
    };
  }

  invalidate(dataVersion?: string, policyVersion?: string): void {
    if (policyVersion !== undefined && policyVersion !== this.#policy.version) return;
    this.#cache.clear();
    this.#residentBytes = 0;
    if (dataVersion !== undefined) this.#dataVersion = dataVersion;
  }
}

export function createClosedRoutePrimitiveCatalog(
  options: ClosedRoutePrimitiveCatalogOptions,
): ClosedRoutePrimitiveCatalog {
  return new DeterministicClosedRoutePrimitiveCatalog(options);
}
