import { gradeExperienceMetrics, maximumSustainedGradePct, SUSTAINED_GRADE_WINDOW_M } from "@/lib/data/metrics";
import type { ReconstructedDirectedEdge } from "@/lib/graph";

type ElevationEdge = Pick<ReconstructedDirectedEdge, "lengthMeters" | "fromElevationMeters" | "toElevationMeters" | "elevationProfile" | "maximumSustainedGradePct">;

function routeElevationSamples(
  edges: readonly ElevationEdge[],
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
  edges: readonly ElevationEdge[],
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

/** Candidate ranking and final validation must use the same route-wide samples. */
export function routeElevationMetrics(edges: readonly ElevationEdge[], includeExperience = true) {
  const exact = exactRouteElevationSamples(edges);
  const samples = exact ?? routeElevationSamples(edges);
  const routeGrade = samples ? maximumSustainedGradePct(samples) : null;
  let grade = routeGrade ?? 0;
  for (const edge of edges) {
    if (edge.lengthMeters >= SUSTAINED_GRADE_WINDOW_M) grade = Math.max(grade, edge.maximumSustainedGradePct ?? 0);
  }
  return { samples, grade, experience: includeExperience && exact ? gradeExperienceMetrics(exact) : null };
}
