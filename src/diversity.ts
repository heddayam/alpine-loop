import { createHash } from 'node:crypto';
import { search, validateQuery } from './engine/search.js';
import { canonical, compareNumbers, preference } from './engine/quality.js';
import type { RouteCandidate, SearchProgress, SearchQuery, TrailGraph } from './model.js';
import type { WorkBudget } from './work-budget.js';

export type SolvedRoute = { route: RouteCandidate; groupId: string };
type Options = {
  onProgress?: (progress: SearchProgress) => void | Promise<void>;
  onRoute?: (route: SolvedRoute) => void | Promise<void>;
  budget?: WorkBudget;
};
export const MIN_LOOP_SIMILARITY = 0.6;
const hash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 32);
function coreOf(graph: TrailGraph, route: RouteCandidate): number[] {
  let first = 0, last = route.edges.length - 1;
  while (first < last && graph.edges[route.edges[first]!]!.trail === graph.edges[route.edges[last]!]!.trail) { first++; last--; }
  return canonical(route.edges.slice(first, last + 1).map(id => graph.edges[id]!.trail));
}

/** Search every planned circuit and start, then keep one preferred walk per
 * displayed hike. Similarity uses fixed representatives and ordered main-loop
 * trails, so hidden discoveries cannot bridge two otherwise distinct hikes. */
export async function solveSection(graph: TrailGraph, query: SearchQuery, options: Options = {}): Promise<SolvedRoute[]> {
  validateQuery(query);
  query = { ...query, sections: [...query.sections], distance: [...query.distance], gain: [...query.gain], roads: query.roads && { ...query.roads } };
  const circuits = new Map<string, { core: number[]; route: RouteCandidate }>();
  let progress: SearchProgress | undefined;
  for await (const event of search(graph, query, { budget: options.budget })) {
    if (event.type !== 'route') {
      progress = event.progress;
      await options.onProgress?.(progress);
      if (event.type === 'done' && event.status !== 'complete') throw new Error('Section exploration did not complete');
      continue;
    }
    const core = coreOf(graph, event.route), key = JSON.stringify(core), previous = circuits.get(key);
    if (!previous || preference(graph, event.route, previous.route) < 0) circuits.set(key, { core, route: event.route });
  }
  const physical = new Map<number, (typeof graph.edges)[number]>();
  for (const edge of graph.edges) if (!physical.has(edge.trail) || !edge.reverse) physical.set(edge.trail, edge);
  const lengthOf = (trails: number[]) => trails.toSorted((a, b) => a - b).reduce((length, trail) => length + physical.get(trail)!.distance, 0);
  const ranked = [...circuits].map(([key, item]) => ({ ...item, key, trails: new Set(item.core), length: lengthOf(item.core) }));
  circuits.clear();
  ranked.sort((a, b) => preference(graph, a.route, b.route) || compareNumbers(a.core, b.core));
  const representatives: (typeof ranked)[number][] = [], result: SolvedRoute[] = [];
  let work = 0, yieldedAt = performance.now();
  const checkpoint = async () => {
    if (++work % 128 || performance.now() - yieldedAt < 8) return;
    if (options.budget) await options.budget.checkpoint();
    else await new Promise<void>(resolve => setTimeout(resolve, 0));
    if (progress) await options.onProgress?.(progress);
    yieldedAt = performance.now();
  };
  for (const item of ranked) {
    let represented = false;
    for (const shown of representatives) {
      const common = item.core.filter(trail => shown.trails.has(trail));
      const score = lengthOf(common) / Math.max(item.length, shown.length);
      if (score >= MIN_LOOP_SIMILARITY && compareNumbers(canonical(common), canonical(shown.core.filter(trail => item.trails.has(trail)))) === 0) {
        represented = true;
        break;
      }
      await checkpoint();
    }
    if (!represented) {
      representatives.push(item);
      const saved = { route: item.route, groupId: `family-${hash(item.key)}` };
      if (options.onRoute) await options.onRoute(saved);
      else result.push(saved);
    }
    await checkpoint();
  }
  await options.budget?.checkpoint();
  return result;
}
