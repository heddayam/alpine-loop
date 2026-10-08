import { elevationSamples, gradeExposure, type ProfileSample } from './grade.js';
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
    const samples = elevationSamples(coordinates);
    const packed = new Float64Array(samples.length * 2);
    for (let i = 0; i < samples.length; i++) {
      packed[i * 2] = samples[i]!.distance;
      packed[i * 2 + 1] = samples[i]!.position[2] ?? NaN;
    }
    profiles.set(id, packed);
    await budget?.checkpoint();
  }
  return route => {
    const samples: ProfileSample[] = [];
    let offset = 0;
    for (const edgeId of route.edges) {
      const edge = graph.edges[edgeId]!;
      const profile = profiles.get(edge.trail);
      if (!profile?.length) throw new Error('Grade-constrained search is missing route drawing geometry.');
      const length = profile[profile.length - 2]!;
      for (let i = samples.length ? 1 : 0; i < profile.length / 2; i++) {
        const index = edge.reverse ? profile.length - 2 - i * 2 : i * 2;
        samples.push({ distance: offset + (edge.reverse ? length - profile[index]! : profile[index]!),
          position: [0, 0, profile[index + 1]!] });
      }
      offset += length;
    }
    const exposure = gradeExposure(samples, { uphill: limits.uphill.above, downhill: limits.downhill.above });
    return exposure !== null && (['uphill', 'downhill'] as const).every(direction =>
      exposure[direction].total <= limits[direction].total && exposure[direction].longest <= limits[direction].longest);
  };
}
