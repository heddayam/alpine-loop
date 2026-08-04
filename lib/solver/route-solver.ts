import type {
  GenerateRoutesRequestV1,
  GenerateRoutesResponseV1,
  GeneratedRoute,
} from "@/lib/contracts";
import type { GraphAccessPoint } from "@/lib/graph";
import { compareScoredCandidates, scoreCandidate, type ScoredCandidate } from "./candidate";
import { RouteSearchCancelledError } from "./control";
import { selectDiverseCandidates } from "./diversity";
import { generateInitialCandidates } from "./generate";
import type { RouteGenerationContext, RouteSolver } from "./types";

type PackResponseMetadata = GenerateRoutesResponseV1["pack"];
type Confidence = GeneratedRoute["source"]["confidence"];

export type RouteSolverOptions = {
  pack: PackResponseMetadata;
  requestIdFactory?: (request: GenerateRoutesRequestV1) => string;
  sourceFreshness?: string;
  sourceConfidence?: Confidence;
  fallbackSourceIds?: string[];
};

function stableHash(value: string): string {
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(36).padStart(13, "0");
}

function defaultRequestId(request: GenerateRoutesRequestV1): string {
  return `route-request-${stableHash(JSON.stringify(request))}`;
}

function accessPoint(candidate: ScoredCandidate, point: GraphAccessPoint, start: boolean) {
  const traversal = start ? candidate.traversals[0] : candidate.traversals.at(-1);
  if (!traversal) throw new Error(`Candidate ${candidate.id} has no traversals`);
  const node = start ? traversal.from : traversal.to;
  return {
    id: point.id,
    name: point.name,
    lon: node.lon,
    lat: node.lat,
    accessState: point.accessState,
    confidence: point.confidence,
  };
}

function lowerConfidence(left: Confidence, right: Confidence): Confidence {
  const rank: Record<Confidence, number> = { high: 0, medium: 1, low: 2 };
  return rank[left] >= rank[right] ? left : right;
}

function routeConfidence(candidate: ScoredCandidate, configured: Confidence): Confidence {
  let confidence = lowerConfidence(configured, candidate.startAccessPoint.confidence);
  confidence = lowerConfidence(confidence, candidate.endAccessPoint.confidence);
  if (candidate.traversals.some(({ edge }) => edge.accessState === "unknown")) confidence = "low";
  return confidence;
}

function generatedRoute(
  candidate: ScoredCandidate,
  options: Required<Pick<RouteSolverOptions, "sourceFreshness" | "sourceConfidence" | "fallbackSourceIds">>,
  truncated: boolean,
): GeneratedRoute {
  const warnings = [
    ...candidate.warnings,
    "Planning aid only; verify current trail and access conditions",
    ...(truncated ? ["Search was truncated; additional alternatives may exist"] : []),
  ];
  return {
    id: candidate.id,
    shape: candidate.shape,
    geometry: { type: "LineString", coordinates: candidate.coordinates.map(([lon, lat]) => [lon, lat]) },
    startAccessPoint: accessPoint(candidate, candidate.startAccessPoint, true),
    endAccessPoint: accessPoint(candidate, candidate.endAccessPoint, false),
    distanceMeters: candidate.metrics.distanceMeters,
    elevationGainMeters: candidate.metrics.elevationGainMeters,
    elevationLossMeters: candidate.metrics.elevationLossMeters,
    minimumElevationMeters: candidate.metrics.minimumElevationMeters,
    maximumElevationMeters: candidate.metrics.maximumElevationMeters,
    steepestSustainedGradePct: candidate.metrics.steepestSustainedGradePct,
    repeatedEdgeFraction: candidate.metrics.repeatedEdgeFraction,
    trailNames: candidate.trailNames,
    warnings: [...new Set(warnings)],
    source: {
      freshness: options.sourceFreshness,
      confidence: routeConfidence(candidate, options.sourceConfidence),
      sourceIds: candidate.sourceIds.length > 0 ? candidate.sourceIds : options.fallbackSourceIds,
    },
    ...(candidate.elevationSamples ? { elevationSamples: candidate.elevationSamples } : {}),
  };
}

export class DeterministicRouteSolver implements RouteSolver {
  readonly #options: RouteSolverOptions;

  constructor(options: RouteSolverOptions) {
    this.#options = options;
  }

  async generate(
    request: GenerateRoutesRequestV1,
    context: RouteGenerationContext,
  ): Promise<GenerateRoutesResponseV1> {
    if (request.packId !== this.#options.pack.id || context.repository.packId !== request.packId) {
      throw new Error(`Route solver pack mismatch for ${request.packId}`);
    }
    if (context.signal?.aborted) throw new RouteSearchCancelledError(context.signal.reason);
    let graph;
    try {
      graph = await context.repository.getInducedGraph({
        bbox: request.bbox,
        includeUncertainAccess: request.includeUncertainAccess,
        signal: context.signal,
      });
    } catch (error) {
      if (context.signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) {
        throw new RouteSearchCancelledError(context.signal?.reason ?? error);
      }
      throw error;
    }
    const generation = generateInitialCandidates(graph, request, {
      budget: context.budget,
      signal: context.signal,
      now: context.now,
    });
    const ranked = generation.candidates.map((candidate) => scoreCandidate(candidate, request)).sort(compareScoredCandidates);
    const exact = selectDiverseCandidates(ranked.filter((candidate) => candidate.exact), request.limit);
    const nearMisses = selectDiverseCandidates(
      ranked.filter((candidate) => !candidate.exact),
      3,
      exact,
    );
    const reasons = new Set(generation.diagnostics.truncationReasons);
    if (exact.length < request.limit) reasons.add("fewer-exact-routes-than-requested");
    const sourceOptions = {
      sourceFreshness: this.#options.sourceFreshness ?? this.#options.pack.builtAt,
      sourceConfidence: this.#options.sourceConfidence ?? "high",
      fallbackSourceIds: this.#options.fallbackSourceIds ?? [`${this.#options.pack.id}:manifest`],
    } satisfies Required<Pick<RouteSolverOptions, "sourceFreshness" | "sourceConfidence" | "fallbackSourceIds">>;
    const budgetTruncated = generation.diagnostics.exhausted;
    return {
      version: 1,
      requestId: (this.#options.requestIdFactory ?? defaultRequestId)(request),
      pack: this.#options.pack,
      requested: request.limit,
      exact: exact.map((candidate) => generatedRoute(candidate, sourceOptions, budgetTruncated)),
      nearMisses: nearMisses.map((candidate) => ({
        ...generatedRoute(candidate, sourceOptions, budgetTruncated),
        violations: candidate.violations,
      })),
      diagnostics: {
        ...generation.diagnostics,
        exhausted: generation.diagnostics.exhausted || exact.length < request.limit,
        truncationReasons: [...reasons].sort(),
      },
    };
  }
}

export function createRouteSolver(options: RouteSolverOptions): RouteSolver {
  return new DeterministicRouteSolver(options);
}
