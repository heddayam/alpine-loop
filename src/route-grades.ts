import { elevationProfile, gradeExposure } from './grade.js';
import type { GradeLimits, Position, RouteCandidate, TrailGraph } from './model.js';
import type { WorkBudget } from './work-budget.js';

/** Only enabled searches load profiles. Keep distance/elevation pairs, not map
 * coordinates, and release the entire section after search. */
export async function routeGradeCheck(
  graph: TrailGraph,
  geometry: AsyncIterable<{ id: number; coordinates: Position[] }>,
  limits: GradeLimits,
  budget?: WorkBudget,
): Promise<(route: RouteCandidate) => boolean> {
  const profiles = new Map<number, Float64Array>();
  for await (const { id, coordinates } of geometry) {
    profiles.set(id, elevationProfile(coordinates));
    await budget?.checkpoint();
  }
  const thresholds = { uphill: limits.uphill.above, downhill: limits.downhill.above };
  // Checks run synchronously. Reuse one walk buffer for this section, retaining
  // repeated edges and joins in traversal order without per-point allocations.
  let walk = new Float64Array(4096);
  return route => {
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
    return gradeExposure(walk.subarray(0, used), thresholds, limits) !== null;
  };
}
