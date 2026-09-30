import { createHash } from "node:crypto";
import type {
  ClosedRouteTopologyV3,
  GeneratedClosedRouteV3,
} from "@/lib/contracts";
import {
  edgeIsTraversable,
  lineIsInsideArea,
  type AccessPointCandidate,
  type AreaGeometry,
  type ReconstructedDirectedEdge,
} from "@/lib/graph";
import { gradeExperienceMetrics, maximumSustainedGradePct, SUSTAINED_GRADE_WINDOW_M } from "@/lib/data/metrics";
import { trailSegmentsForRoute } from "./trail-segments";

export type ClosedRouteValidationFailure =
  | "empty"
  | "discontinuous"
  | "wrong-start"
  | "not-closed"
  | "illegal-access"
  | "outside-coverage"
  | "incomplete-elevation"
  | "unsupported-route-shape";

export type ValidatedClosedRoute = {
  edges: readonly ReconstructedDirectedEdge[];
  physicalEdgeKeys: ReadonlySet<number>;
  route: GeneratedClosedRouteV3;
};

export type ClosedRouteValidationResult =
  | { valid: true; value: ValidatedClosedRoute }
  | { valid: false; reason: ClosedRouteValidationFailure };

export type ClosedRouteValidationOptions = {
  start: AccessPointCandidate;
  includeUncertainAccess: boolean;
  coverage: AreaGeometry;
  sourceFreshness: string;
  sourceConfidence: "high" | "medium" | "low";
  fallbackSourceIds: readonly string[];
  routeId: string;
};

/** Peel the one permitted retrace, then require exactly one simple cycle. */
function topologyFor(edges: readonly ReconstructedDirectedEdge[], startNodeId: string): { topology: ClosedRouteTopologyV3; physicalLoopId: string } | null {
  let left = 0;
  let right = edges.length - 1;
  let sharedStemDistanceMeters = 0;
  let repeatedTrailDistanceMeters = 0;
  const usedNodes = new Set<string>();
  const usedPhysical = new Set<number>();
  while (left < right) {
    const outward = edges[left]!;
    const inward = edges[right]!;
    if (outward.physicalEdgeKey !== inward.physicalEdgeKey
      || outward.fromNodeId !== inward.toNodeId || outward.toNodeId !== inward.fromNodeId) break;
    if (usedNodes.has(outward.fromNodeId) || usedPhysical.has(outward.physicalEdgeKey)) return null;
    usedNodes.add(outward.fromNodeId);
    usedPhysical.add(outward.physicalEdgeKey);
    sharedStemDistanceMeters += outward.lengthMeters;
    repeatedTrailDistanceMeters += inward.lengthMeters;
    left += 1;
    right -= 1;
  }
  if (left > right) return null;
  const attachment = edges[left]!.fromNodeId;
  if (edges[right]!.toNodeId !== attachment || usedNodes.has(attachment)) return null;
  const cyclePhysicalKeys: number[] = [];
  for (let index = left; index <= right; index += 1) {
    const edge = edges[index]!;
    if (usedNodes.has(edge.fromNodeId) || usedPhysical.has(edge.physicalEdgeKey)) return null;
    usedNodes.add(edge.fromNodeId);
    usedPhysical.add(edge.physicalEdgeKey);
    cyclePhysicalKeys.push(edge.physicalEdgeKey);
  }
  if (edges[0]!.fromNodeId !== startNodeId) return null;
  const totalDistanceMeters = edges.reduce((sum, edge) => sum + edge.lengthMeters, 0);
  return {
    topology: {
      kind: left === 0 ? "simple-loop" : "lollipop",
      cycleCount: 1,
      cycleBlockCount: 1,
      sharedStemDistanceMeters,
      repeatedTrailDistanceMeters,
      repeatedTrailFraction: totalDistanceMeters > 0 ? repeatedTrailDistanceMeters / totalDistanceMeters : 0,
      connectorCount: left === 0 ? 0 : 1,
    },
    // A valid simple cycle is uniquely identified by its physical edge set.
    // Sorting removes traversal rotation/direction; the peeled stem is excluded.
    physicalLoopId: `physical-loop-v1:${createHash("sha256").update(JSON.stringify(cyclePhysicalKeys.sort((a, b) => a - b))).digest("hex")}`,
  };
}

function routeCoordinates(edges: readonly ReconstructedDirectedEdge[]): Array<[number, number]> {
  const coordinates: Array<[number, number]> = [];
  for (const [index, edge] of edges.entries()) {
    coordinates.push(...edge.coordinates.slice(index === 0 ? 0 : 1).map(([lon, lat]) => [lon, lat] as [number, number]));
  }
  return coordinates;
}

function routeElevationSamples(
  edges: readonly ReconstructedDirectedEdge[],
): Array<{ distanceMeters: number; elevationMeters: number }> | undefined {
  if (edges.length === 0 || edges.some((edge) =>
    edge.fromElevationMeters === null
    || edge.fromElevationMeters === undefined
    || edge.toElevationMeters === null
    || edge.toElevationMeters === undefined)) return undefined;
  const samples = [{ distanceMeters: 0, elevationMeters: edges[0]!.fromElevationMeters! }];
  let distanceMeters = 0;
  for (const edge of edges) {
    distanceMeters += edge.lengthMeters;
    samples.push({ distanceMeters, elevationMeters: edge.toElevationMeters! });
  }
  return samples;
}

function exactRouteElevationSamples(
  edges: readonly ReconstructedDirectedEdge[],
): Array<{ distanceMeters: number; elevationMeters: number }> | undefined {
  if (edges.length === 0 || edges.some((edge) => !edge.elevationProfile || edge.elevationProfile.length < 2)) return undefined;
  const result: Array<{ distanceMeters: number; elevationMeters: number }> = [];
  let offset = 0;
  for (const [edgeIndex, edge] of edges.entries()) {
    for (const sample of edge.elevationProfile!) {
      if (edgeIndex > 0 && sample.distanceMeters === 0) continue;
      result.push({ distanceMeters: offset + sample.distanceMeters, elevationMeters: sample.elevationMeters });
    }
    offset += edge.lengthMeters;
  }
  return result;
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
  if (edges.some((edge) => !lineIsInsideArea(edge.coordinates, options.coverage))) {
    return { valid: false, reason: "outside-coverage" };
  }
  const shape = topologyFor(edges, options.start.nodeId);
  if (!shape) return { valid: false, reason: "unsupported-route-shape" };
  const entranceFamilyId = options.includeUncertainAccess ? options.start.inclusiveEntranceFamilyId : options.start.knownEntranceFamilyId;
  const distanceMeters = edges.reduce((sum, edge) => sum + edge.lengthMeters, 0);
  const knownMinimumElevations = edges.map(({ minimumElevationMeters }) => minimumElevationMeters);
  if (knownMinimumElevations.some((value) => value === null)) {
    return { valid: false, reason: "incomplete-elevation" };
  }
  const knownMaximumElevations = edges.map(({ maximumElevationMeters }) => maximumElevationMeters).filter(
    (value): value is number => value !== null,
  );
  const maximumElevationMeters = knownMaximumElevations.length > 0 ? Math.max(...knownMaximumElevations) : 0;
  const warnings: string[] = [];
  if (options.start.accessState === "unknown") warnings.push("Access is uncertain");
  if (edges.some(({ accessState }) => accessState === "unknown")) warnings.push("Route uses trail access marked uncertain");
  if (knownMaximumElevations.length !== edges.length) warnings.push("Elevation data is incomplete");
  const sourceIds = [...new Set([
    ...edges.flatMap(({ sourceIds }) => sourceIds),
    ...options.start.sourceIds,
    ...options.fallbackSourceIds,
  ])].sort();
  const trailNames = [...new Set(edges.map(({ trailName }) => trailName).filter((name): name is string => Boolean(name)))].sort();
  const exactElevationSamples = exactRouteElevationSamples(edges);
  const elevationSamples = exactElevationSamples ?? routeElevationSamples(edges);
  const routeWindowGrade = elevationSamples ? maximumSustainedGradePct(elevationSamples) : null;
  const gradeExperience = exactElevationSamples ? gradeExperienceMetrics(exactElevationSamples) : null;
  // Older packs persisted fragment grades on edges shorter than 100 m. Those
  // values are not sustained grades; route-wide endpoint windows replace them.
  // Long-edge values retain DEM samples that are not present in the route
  // endpoint profile.
  const longEdgeGrades = edges
    .filter(({ lengthMeters }) => lengthMeters >= SUSTAINED_GRADE_WINDOW_M)
    .map(({ maximumSustainedGradePct: grade }) => grade)
    .filter((grade): grade is number => grade !== null);
  const steepestSustainedGradePct = Math.max(0, routeWindowGrade ?? 0, ...longEdgeGrades);
  return {
    valid: true,
    value: {
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
          ...(entranceFamilyId ? { entranceFamilyId } : {}),
        },
        distanceMeters,
        elevationGainMeters: edges.reduce((sum, edge) => sum + edge.gainMeters, 0),
        elevationLossMeters: edges.reduce((sum, edge) => sum + edge.lossMeters, 0),
        minimumElevationMeters: Math.min(...knownMinimumElevations as number[]),
        maximumElevationMeters,
        steepestSustainedGradePct,
        ...(gradeExperience ? { gradeExperience } : {}),
        trailNames,
        trailSegments: trailSegmentsForRoute(options.routeId, edges),
        warnings,
        ...(elevationSamples ? { elevationSamples } : {}),
        source: {
          freshness: options.sourceFreshness,
          confidence: options.sourceConfidence,
          sourceIds: sourceIds.length > 0 ? sourceIds : ["unknown-source"],
        },
        topology: shape.topology,
        physicalLoopId: shape.physicalLoopId,
      },
    },
  };
}
