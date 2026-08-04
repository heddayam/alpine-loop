import type { ScoredCandidate } from "./candidate";
import { undirectedEdgeKey } from "./canonical";

const MAXIMUM_ALLOWED_OVERLAP = 0.8;

function undirectedDistances(candidate: ScoredCandidate): Map<string, number> {
  const distances = new Map<string, number>();
  for (const { edge } of candidate.traversals) {
    const key = undirectedEdgeKey(edge);
    distances.set(key, Math.max(distances.get(key) ?? 0, edge.lengthMeters));
  }
  return distances;
}

/** The share of the candidate's physical (undirected) distance used by selected. */
export function undirectedDistanceOverlap(candidate: ScoredCandidate, selected: ScoredCandidate): number {
  const candidateDistances = undirectedDistances(candidate);
  const selectedDistances = undirectedDistances(selected);
  const total = [...candidateDistances.values()].reduce((sum, distance) => sum + distance, 0);
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
