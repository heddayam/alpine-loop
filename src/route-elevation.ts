import { elevationProfile, gradeExposure, highestElevation } from './grade.js';
import type { SearchQuery, Position, RouteCandidate, TrailGraph } from './model.js';
import type { WorkBudget } from './work-budget.js';

/** Stream geometry once per section. High point needs only one scalar per trail;
 * retain compact profiles only when grade limits also need the ordered walk. */
export async function routeElevationCheck(
  graph: TrailGraph,
  geometry: AsyncIterable<{ id: number; coordinates: Position[] }>,
  constraints: Pick<SearchQuery, 'grades' | 'highPoint'>,
  budget?: WorkBudget,
): Promise<(route: RouteCandidate) => boolean> {
  const { grades: limits, highPoint } = constraints;
  const peaks = new Map<number, number | null>();
  const profiles = new Map<number, Float64Array>();
  for await (const { id, coordinates } of geometry) {
    if (limits) profiles.set(id, elevationProfile(coordinates));
    if (highPoint) peaks.set(id, highestElevation(coordinates));
    await budget?.checkpoint();
  }
  const thresholds = limits && { uphill: limits.uphill.above, downhill: limits.downhill.above };
  // Checks run synchronously. Reuse one walk buffer for this section, retaining
  // repeated edges and joins in traversal order without per-point allocations.
  let walk = new Float64Array(limits ? 4096 : 0);
  return route => {
    if (highPoint) {
      let peak = -Infinity;
      for (const id of route.edges) {
        const value = peaks.get(graph.edges[id]!.trail);
        if (value === undefined) throw new Error('Elevation-constrained search is missing route drawing geometry.');
        if (value === null) return false;
        peak = Math.max(peak, value);
        if (highPoint[1] !== null && peak > highPoint[1]) return false;
      }
      if (!Number.isFinite(peak) || highPoint[0] !== null && peak < highPoint[0]) return false;
    }
    if (!limits) return true;
    let offset = 0, used = 0;
    for (const edgeId of route.edges) {
      const edge = graph.edges[edgeId]!;
      const profile = profiles.get(edge.trail);
      if (!profile?.length) throw new Error('Grade-constrained search is missing route drawing geometry.');
      const length = profile[profile.length - 2]!;
      const required = used + profile.length;
      if (required > walk.length) {
        const grown = new Float64Array(Math.max(required, walk.length * 2));
        grown.set(walk.subarray(0, used));
        walk = grown;
      }
      for (let i = used ? 1 : 0; i < profile.length / 2; i++) {
        const index = edge.reverse ? profile.length - 2 - i * 2 : i * 2;
        walk[used++] = offset + (edge.reverse ? length - profile[index]! : profile[index]!);
        walk[used++] = profile[index + 1]!;
      }
      offset += length;
    }
    return gradeExposure(walk.subarray(0, used), thresholds!, limits) !== null;
  };
}
