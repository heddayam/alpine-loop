import type { ConstraintViolation, GenerateRoutesRequestV1, RouteType } from "@/lib/contracts";
import type { EdgeTraversal, GraphAccessPoint } from "@/lib/graph";
import { canonicalRouteId, undirectedEdgeKey } from "./canonical";

export type CandidateMetrics = {
  distanceMeters: number;
  elevationGainMeters: number;
  elevationLossMeters: number;
  minimumElevationMeters: number;
  maximumElevationMeters: number;
  steepestSustainedGradePct: number;
  repeatedEdgeFraction: number;
};

export type RouteCandidate = {
  id: string;
  shape: RouteType;
  traversals: EdgeTraversal[];
  startAccessPoint: GraphAccessPoint;
  endAccessPoint: GraphAccessPoint;
  coordinates: Array<readonly [number, number]>;
  metrics: CandidateMetrics;
  trailNames: string[];
  sourceIds: string[];
  warnings: string[];
};

export type ScoredCandidate = RouteCandidate & {
  exact: boolean;
  score: number;
  violations: ConstraintViolation[];
};

function routeCoordinates(traversals: readonly EdgeTraversal[]): Array<readonly [number, number]> {
  const coordinates: Array<readonly [number, number]> = [];
  for (const [index, traversal] of traversals.entries()) {
    coordinates.push(...(index === 0 ? traversal.edge.coordinates : traversal.edge.coordinates.slice(1)));
  }
  return coordinates;
}

function routeMetrics(traversals: readonly EdgeTraversal[]): CandidateMetrics {
  const elevations = traversals.flatMap(({ from, to }) => [from.elevationMeters, to.elevationMeters]).filter(
    (elevation): elevation is number => elevation !== null,
  );
  const totalDistance = traversals.reduce((sum, { edge }) => sum + edge.lengthMeters, 0);
  const distanceByPhysicalEdge = new Map<string, { count: number; lengthMeters: number }>();
  for (const { edge } of traversals) {
    const key = undirectedEdgeKey(edge);
    const current = distanceByPhysicalEdge.get(key) ?? { count: 0, lengthMeters: edge.lengthMeters };
    current.count += 1;
    distanceByPhysicalEdge.set(key, current);
  }
  const repeatedDistance = [...distanceByPhysicalEdge.values()].reduce(
    (sum, edge) => sum + Math.max(0, edge.count - 1) * edge.lengthMeters,
    0,
  );
  return {
    distanceMeters: totalDistance,
    elevationGainMeters: traversals.reduce((sum, { edge }) => sum + edge.gainMeters, 0),
    elevationLossMeters: traversals.reduce((sum, { edge }) => sum + edge.lossMeters, 0),
    minimumElevationMeters: elevations.length > 0 ? Math.min(...elevations) : 0,
    maximumElevationMeters: Math.max(
      elevations.length > 0 ? Math.max(...elevations) : 0,
      ...traversals.map(({ edge }) => edge.maximumElevationMeters ?? 0),
    ),
    steepestSustainedGradePct: Math.max(
      0,
      ...traversals.map(({ edge }) => edge.maximumSustainedGradePct ?? 0),
    ),
    repeatedEdgeFraction: totalDistance > 0 ? repeatedDistance / totalDistance : 0,
  };
}

export function createCandidate(
  shape: RouteType,
  traversals: EdgeTraversal[],
  startAccessPoint: GraphAccessPoint,
  endAccessPoint: GraphAccessPoint,
): RouteCandidate {
  const edges = traversals.map(({ edge }) => edge);
  const warnings: string[] = [];
  if (shape === "point-to-point") warnings.push("Shuttle or two-car logistics required");
  if (startAccessPoint.accessState === "unknown" || endAccessPoint.accessState === "unknown") {
    warnings.push("Access is uncertain");
  }
  return {
    id: canonicalRouteId(shape, edges),
    shape,
    traversals,
    startAccessPoint,
    endAccessPoint,
    coordinates: routeCoordinates(traversals),
    metrics: routeMetrics(traversals),
    trailNames: [...new Set(edges.map((edge) => edge.trailName).filter((name): name is string => Boolean(name)))],
    sourceIds: [...new Set(edges.flatMap((edge) => edge.sourceIds))].sort(),
    warnings,
  };
}

const METERS_PER_MILE = 1_609.344;
const METERS_PER_FOOT = 0.3048;

function violation(
  constraint: ConstraintViolation["constraint"],
  value: number,
  min: number,
  max: number,
): ConstraintViolation | null {
  if (value >= min && value <= max) return null;
  const delta = value < min ? min - value : value - max;
  const scale = Math.max(max - min, Math.abs(min), Math.abs(max), 1);
  return { constraint, value, min, max, delta, normalizedDelta: delta / scale };
}

function centerDistance(value: number, min: number, max: number): number {
  const scale = Math.max(max - min, Math.abs(min), Math.abs(max), 1);
  return Math.abs(value - (min + max) / 2) / scale;
}

export function scoreCandidate(candidate: RouteCandidate, request: GenerateRoutesRequestV1): ScoredCandidate {
  const ranges: Array<{
    constraint: ConstraintViolation["constraint"];
    value: number;
    min: number;
    max: number;
  }> = [
    {
      constraint: "distance",
      value: candidate.metrics.distanceMeters,
      min: request.distanceMiles.min * METERS_PER_MILE,
      max: request.distanceMiles.max * METERS_PER_MILE,
    },
  ];
  if (request.elevationGainFeet) {
    ranges.push({
      constraint: "elevation-gain",
      value: candidate.metrics.elevationGainMeters,
      min: request.elevationGainFeet.min * METERS_PER_FOOT,
      max: request.elevationGainFeet.max * METERS_PER_FOOT,
    });
  }
  if (request.maximumElevationFeet) {
    ranges.push({
      constraint: "maximum-elevation",
      value: candidate.metrics.maximumElevationMeters,
      min: request.maximumElevationFeet.min * METERS_PER_FOOT,
      max: request.maximumElevationFeet.max * METERS_PER_FOOT,
    });
  }
  if (request.steepestSustainedGradePct) {
    ranges.push({
      constraint: "steepest-sustained-grade",
      value: candidate.metrics.steepestSustainedGradePct,
      min: request.steepestSustainedGradePct.min,
      max: request.steepestSustainedGradePct.max,
    });
  }
  const violations = ranges
    .map((range) => violation(range.constraint, range.value, range.min, range.max))
    .filter((item): item is ConstraintViolation => item !== null);
  const constraintDistance = ranges.reduce(
    (sum, range) => sum + centerDistance(range.value, range.min, range.max),
    0,
  );
  const confidencePenalty = { high: 0, medium: 0.1, low: 0.2 }[candidate.startAccessPoint.confidence];
  const continuityPenalty = candidate.trailNames.length > 0 ? Math.max(0, candidate.trailNames.length - 1) * 0.03 : 0.1;
  return {
    ...candidate,
    exact: violations.length === 0,
    score: constraintDistance + candidate.metrics.repeatedEdgeFraction + confidencePenalty + continuityPenalty,
    violations,
  };
}

export function compareScoredCandidates(left: ScoredCandidate, right: ScoredCandidate): number {
  return (
    Number(left.exact !== right.exact) * (left.exact ? -1 : 1) ||
    left.violations.length - right.violations.length ||
    left.violations.reduce((sum, item) => sum + item.normalizedDelta, 0) -
      right.violations.reduce((sum, item) => sum + item.normalizedDelta, 0) ||
    left.score - right.score ||
    left.id.localeCompare(right.id)
  );
}
