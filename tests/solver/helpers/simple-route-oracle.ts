import type { AccessState, GraphEdge, GraphNode, InducedGraph } from "@/lib/graph";
import type { RouteSearchRequest } from "@/lib/solver/types";

type Sample = { distanceMeters: number; elevationMeters: number };

export type PhysicalTrail = {
  id: number;
  from: string;
  to: string;
  length: number;
  reverseLength?: number;
  oneWay?: boolean;
  gain?: number;
  reverseGain?: number;
  access?: AccessState;
  profile?: Sample[];
};

export type OracleRoute = {
  edges: GraphEdge[];
  loopKey: string;
  distance: number;
  gain: number;
  stemDistance: number;
  repeatedDistance: number;
  maximumGrade: number;
  violations: string[];
};

/** Small, explicitly measured graphs; no production compiler or contraction. */
export function oracleGraph(trails: readonly PhysicalTrail[]): InducedGraph {
  const ids = [...new Set(trails.flatMap(({ from, to }) => [from, to]))];
  const nodes = new Map<string, GraphNode>(ids.map((id, index) => [id, {
    id, lon: -122 + index * 0.0001, lat: 37, elevationMeters: 100, flags: [],
  }]));
  for (const trail of trails) {
    if (!trail.profile) continue;
    nodes.get(trail.from)!.elevationMeters = trail.profile[0]!.elevationMeters;
    nodes.get(trail.to)!.elevationMeters = trail.profile.at(-1)!.elevationMeters;
  }
  const edges: GraphEdge[] = [];
  for (const trail of trails) {
    const profile = trail.profile ?? [
      { distanceMeters: 0, elevationMeters: nodes.get(trail.from)!.elevationMeters! },
      { distanceMeters: trail.length, elevationMeters: nodes.get(trail.to)!.elevationMeters! },
    ];
    const add = (reverse: boolean): void => {
      const from = nodes.get(reverse ? trail.to : trail.from)!;
      const to = nodes.get(reverse ? trail.from : trail.to)!;
      const length = reverse ? trail.reverseLength ?? trail.length : trail.length;
      const directedProfile = reverse ? [...profile].reverse().map((sample) => ({
        distanceMeters: (trail.length - sample.distanceMeters) * length / trail.length,
        elevationMeters: sample.elevationMeters,
      })) : profile;
      edges.push({
        id: `${trail.id}:${reverse ? "back" : "out"}`, edgeKey: edges.length + 1,
        physicalEdgeKey: trail.id, fromNodeId: from.id, toNodeId: to.id,
        coordinates: [[from.lon, from.lat], [to.lon, to.lat]],
        lengthMeters: length, gainMeters: reverse ? trail.reverseGain ?? 0 : trail.gain ?? 0,
        lossMeters: reverse ? trail.gain ?? 0 : trail.reverseGain ?? 0,
        maximumElevationMeters: Math.max(...profile.map(({ elevationMeters }) => elevationMeters)),
        maximumSustainedGradePct: grade(directedProfile), elevationProfile: directedProfile,
        accessState: trail.access ?? "public", edgeClass: "trail", trailName: null,
        sourceIds: ["oracle"], flags: [],
      });
    };
    add(false);
    if (!trail.oneWay) add(true);
  }
  return { nodes, edges, accessPoints: [] };
}

/** Deliberately slow independent interpolation, suitable only for tiny fixtures. */
function grade(samples: readonly Sample[]): number {
  if (samples.length < 2 || samples.at(-1)!.distanceMeters < 100) return 0;
  const end = samples.at(-1)!.distanceMeters;
  const starts = new Set(samples.flatMap(({ distanceMeters }) => [distanceMeters, distanceMeters - 100]));
  const elevation = (position: number): number => {
    const right = samples.findIndex(({ distanceMeters }) => distanceMeters >= position);
    if (samples[right]!.distanceMeters === position) return samples[right]!.elevationMeters;
    const before = samples[right - 1]!;
    const after = samples[right]!;
    return before.elevationMeters + (after.elevationMeters - before.elevationMeters)
      * (position - before.distanceMeters) / (after.distanceMeters - before.distanceMeters);
  };
  return Math.max(0, ...[...starts].filter((position) => position >= 0 && position + 100 <= end)
    .map((position) => Math.abs(elevation(position + 100) - elevation(position))));
}

export function directedKey(edges: readonly GraphEdge[]): string {
  return edges.map(({ id }) => id).join(",");
}

/** Identity of the cycle only: stem alternatives and orientation do not add loops. */
export function physicalLoopKey(edges: readonly GraphEdge[]): string {
  let first = 0;
  let last = edges.length - 1;
  while (first < last && edges[first]!.physicalEdgeKey === edges[last]!.physicalEdgeKey
    && edges[first]!.fromNodeId === edges[last]!.toNodeId
    && edges[first]!.toNodeId === edges[last]!.fromNodeId) {
    first += 1;
    last -= 1;
  }
  return edges.slice(first, last + 1).map(({ physicalEdgeKey }) => physicalEdgeKey!).sort((a, b) => a - b).join(",");
}

/**
 * Exhaustively choose a reversible node-simple stem, then independently choose
 * a node-simple cycle at its attachment. Unlike the production DFS, this never
 * discovers cycles by closing a prefix to an ancestor and uses no distance
 * bounds, contraction, candidate archive, or production topology/metric helpers.
 */
export function enumerateSimpleRoutes(graph: InducedGraph, start: string, request: RouteSearchRequest): OracleRoute[] {
  const allowed = graph.edges.filter((edge) =>
    (edge.accessState === "public" || (request.includeUncertainAccess && edge.accessState === "unknown"))
    && (edge.edgeClass === undefined || edge.edgeClass === "trail")
    && !edge.flags.some((flag) => ["non-pedestrian", "pedestrian:no", "foot:no", "legal:no"].includes(flag.toLowerCase())));
  const outgoing = (node: string) => allowed.filter(({ fromNodeId }) => fromNodeId === node);
  const results = new Map<string, OracleRoute>();

  const offer = (stem: GraphEdge[], cycle: GraphEdge[], back: GraphEdge[]): void => {
    const edges = [...stem, ...cycle, ...back];
    const distance = edges.reduce((sum, edge) => sum + edge.lengthMeters, 0);
    const gain = edges.reduce((sum, edge) => sum + edge.gainMeters, 0);
    const repeatedDistance = back.reduce((sum, edge) => sum + edge.lengthMeters, 0);
    const stemDistance = stem.reduce((sum, edge) => sum + edge.lengthMeters, 0);
    const maximumElevation = Math.max(...edges.map((edge) => edge.maximumElevationMeters ?? -Infinity));
    let offset = 0;
    const samples = edges.flatMap((edge, index) => {
      const profile = edge.elevationProfile ?? [
        { distanceMeters: 0, elevationMeters: graph.nodes.get(edge.fromNodeId)!.elevationMeters! },
        { distanceMeters: edge.lengthMeters, elevationMeters: graph.nodes.get(edge.toNodeId)!.elevationMeters! },
      ];
      const translated = profile.slice(index === 0 ? 0 : 1).map((sample) => ({
        distanceMeters: sample.distanceMeters + offset, elevationMeters: sample.elevationMeters,
      }));
      offset += edge.lengthMeters;
      return translated;
    });
    const maximumGrade = Math.max(grade(samples), ...edges.filter((edge) => edge.lengthMeters >= 100)
      .map((edge) => edge.maximumSustainedGradePct ?? 0));
    const violations: string[] = [];
    if (distance < request.distanceMiles.min * 1_609.344) violations.push("distance-below-minimum");
    if (distance > request.distanceMiles.max * 1_609.344) violations.push("distance-above-maximum");
    if (request.elevationGainFeet && gain < request.elevationGainFeet.min * 0.3048) violations.push("gain-below-minimum");
    if (request.elevationGainFeet && gain > request.elevationGainFeet.max * 0.3048) violations.push("gain-above-maximum");
    if (request.maximumElevationFeet && (maximumElevation < request.maximumElevationFeet.min * 0.3048
      || maximumElevation > request.maximumElevationFeet.max * 0.3048)) violations.push("maximum-elevation-outside-range");
    if (request.steepestSustainedGradePct && (maximumGrade < request.steepestSustainedGradePct.min
      || maximumGrade > request.steepestSustainedGradePct.max)) violations.push("sustained-grade-outside-range");
    if (repeatedDistance / distance > request.closedRoute.maximumRepeatedTrailPct / 100 + 1e-9) {
      violations.push("repeated-trail-above-maximum");
    }
    if (request.closedRoute.maximumSharedStemMiles !== undefined
      && stemDistance > request.closedRoute.maximumSharedStemMiles * 1_609.344) violations.push("shared-stem-above-maximum");
    results.set(directedKey(edges), {
      edges, loopKey: cycle.map(({ physicalEdgeKey }) => physicalEdgeKey!).sort((a, b) => a - b).join(","),
      distance, gain, stemDistance, repeatedDistance, maximumGrade, violations,
    });
  };

  const stems = (node: string, stem: GraphEdge[], back: GraphEdge[], stemNodes: Set<string>, stemPhysical: Set<number>): void => {
    const cycles = (current: string, cycle: GraphEdge[], cycleNodes: Set<string>, physical: Set<number>): void => {
      for (const edge of outgoing(current)) {
        if (physical.has(edge.physicalEdgeKey!)) continue;
        if (edge.toNodeId === node) {
          offer(stem, [...cycle, edge], back);
        } else if (!stemNodes.has(edge.toNodeId) && !cycleNodes.has(edge.toNodeId)) {
          cycles(edge.toNodeId, [...cycle, edge], new Set([...cycleNodes, edge.toNodeId]),
            new Set([...physical, edge.physicalEdgeKey!]));
        }
      }
    };
    cycles(node, [], new Set([node]), stemPhysical);
    for (const edge of outgoing(node)) {
      if (stemNodes.has(edge.toNodeId) || stemPhysical.has(edge.physicalEdgeKey!)) continue;
      for (const reverse of outgoing(edge.toNodeId).filter((candidate) =>
        candidate.toNodeId === node && candidate.physicalEdgeKey === edge.physicalEdgeKey)) {
        stems(edge.toNodeId, [...stem, edge], [reverse, ...back], new Set([...stemNodes, edge.toNodeId]),
          new Set([...stemPhysical, edge.physicalEdgeKey!]));
      }
    }
  };
  stems(start, [], [], new Set([start]), new Set());
  return [...results.values()];
}
