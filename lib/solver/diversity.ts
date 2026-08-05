import type { ScoredCandidate } from "./candidate";
import { undirectedEdgeKey } from "./canonical";

const MAXIMUM_ALLOWED_OVERLAP = 0.8;
const distanceCache = new WeakMap<ScoredCandidate, {
  distances: Map<string, number>;
  total: number;
}>();

function undirectedDistances(candidate: ScoredCandidate): { distances: Map<string, number>; total: number } {
  const cached = distanceCache.get(candidate);
  if (cached) return cached;
  const distances = new Map<string, number>();
  for (const { edge } of candidate.traversals) {
    const key = undirectedEdgeKey(edge);
    distances.set(key, Math.max(distances.get(key) ?? 0, edge.lengthMeters));
  }
  const result = {
    distances,
    total: [...distances.values()].reduce((sum, distance) => sum + distance, 0),
  };
  distanceCache.set(candidate, result);
  return result;
}

/** The share of the candidate's physical (undirected) distance used by selected. */
export function undirectedDistanceOverlap(candidate: ScoredCandidate, selected: ScoredCandidate): number {
  const { distances: candidateDistances, total } = undirectedDistances(candidate);
  const { distances: selectedDistances } = undirectedDistances(selected);
  if (total === 0) return 0;
  const shared = [...candidateDistances].reduce(
    (sum, [key, distance]) => sum + (selectedDistances.has(key) ? distance : 0),
    0,
  );
  return shared / total;
}

export function selectDiverseCandidates(
  ranked: readonly ScoredCandidate[],
  limit: number,
  alreadySelected: readonly ScoredCandidate[] = [],
): ScoredCandidate[] {
  const selected: ScoredCandidate[] = [];
  for (const candidate of ranked) {
    if (selected.length >= limit) break;
    if (
      [...alreadySelected, ...selected].some(
        (other) => undirectedDistanceOverlap(candidate, other) > MAXIMUM_ALLOWED_OVERLAP,
      )
    ) {
      continue;
    }
    selected.push(candidate);
  }
  return selected;
}
