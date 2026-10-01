import { createHash, randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { DEFAULT_ROAD_LIMITS, ROUTES_PER_PAGE, type RouteChoice, type SearchQuery, type SearchSnapshot } from './model.js';
import type { StoredRoute, WorkerEvent } from './data-format.js';
import type { readDataset } from './dataset.js';

export class RequestError extends Error {
  constructor(message: string, public statusCode: number) { super(message); }
}

export function parseQuery(value: unknown): SearchQuery {
  if (!value || typeof value !== 'object') throw new RequestError('Choose an area and hike constraints.', 400);
  const query = value as SearchQuery;
  const range = (values: unknown, length: number): values is number[] => Array.isArray(values)
    && values.length === length && values.every(number => typeof number === 'number' && Number.isFinite(number));
  if (!range(query.area, 4) || query.area[0] < -180 || query.area[2] > 180
    || query.area[1] < -90 || query.area[3] > 90 || query.area[0] >= query.area[2] || query.area[1] >= query.area[3]) {
    throw new RequestError('Choose a valid rectangular area on the map.', 400);
  }
  if ([query.distance, query.gain].some(values => !range(values, 2) || values[0]! < 0 || values[0]! > values[1]!)
    || query.distance[1] <= 0 || !Number.isFinite(query.repetition) || query.repetition < 0 || query.repetition > 1
    || typeof query.includeUnknown !== 'boolean') {
    throw new RequestError('Use ordered, nonnegative distance and gain ranges and a repeated-trail limit from 0% to 100%.', 400);
  }
  const roads = query.roads === undefined ? DEFAULT_ROAD_LIMITS : query.roads;
  if (!roads || typeof roads.distance !== 'number' || !Number.isFinite(roads.distance) || roads.distance < 0
    || typeof roads.fraction !== 'number' || !Number.isFinite(roads.fraction) || roads.fraction < 0 || roads.fraction > 1) {
    throw new RequestError('Use a nonnegative road distance and a road percentage from 0% to 100%.', 400);
  }
  return { area: [...query.area], distance: [...query.distance], gain: [...query.gain], repetition: query.repetition,
    includeUnknown: query.includeUnknown, roads: { distance: roads.distance, fraction: roads.fraction } };
}

type Choice = { groupId: string; directions: StoredRoute[] };
type Entry = {
  snapshot: SearchSnapshot;
  candidates: Map<string, { route: StoredRoute; choice: Choice }>;
  groups: Map<string, Choice[]>;
  worker?: Worker;
};

/** Current searches live only as long as this process. Browser disconnects do not stop them. */
export function createSearches(directory: string, dataset: Awaited<ReturnType<typeof readDataset>>) {
  let current: Entry | undefined;
  function find(id: string): Entry {
    if (!current || current.snapshot.id !== id) throw new RequestError('This search has expired. Open the current search or start a new one.', 404);
    return current;
  }
  function finish(entry: Entry, status: SearchSnapshot['status'], reason?: string) {
    entry.snapshot.status = status === 'complete' && entry.snapshot.coverageNote ? 'limited' : status;
    entry.snapshot.reason = reason ?? (status === 'complete' ? entry.snapshot.coverageNote : undefined);
  }
  function summary(entry: Entry, route: StoredRoute, choice: Choice): RouteChoice {
    return { ...route.summary, groupId: choice.groupId, groupSize: entry.groups.get(choice.groupId)!.length,
      reverseId: choice.directions.find(other => other.summary.id !== route.summary.id)?.summary.id };
  }
  function page(entry: Entry, offset = 0, groupId?: string): SearchSnapshot {
    if (!Number.isSafeInteger(offset) || offset < 0) throw new RequestError('Choose a valid results page.', 400);
    const choices = groupId === undefined ? [...entry.groups.values()].map(group => group[0]!) : entry.groups.get(groupId);
    if (!choices) throw new RequestError('This route group is not available.', 400);
    return { ...entry.snapshot, offset, groupId, pageTotal: choices.length,
      routes: choices.slice(offset, offset + ROUTES_PER_PAGE).map(choice => summary(entry, choice.directions[0]!, choice)) };
  }
  async function stop(id: string, offset = 0, groupId?: string) {
    const entry = find(id);
    const current = page(entry, offset, groupId);
    if (current.status === 'running') {
      finish(entry, 'stopped', 'Stopped. The routes found so far are still available; exploration is unfinished.');
      await entry.worker?.terminate();
      entry.worker = undefined;
    }
    return page(entry, offset, groupId);
  }
  function start(query: SearchQuery) {
    if (current?.snapshot.status === 'running') {
      throw new RequestError('A search is already running. Reload to reconnect, or stop it before starting another.', 409);
    }
    const snapshot: SearchSnapshot = {
      id: randomUUID(), datasetId: dataset.info.id, query, status: 'running', routes: [], routeCount: 0, groupCount: 0, pageTotal: 0, offset: 0,
      selectionNote: 'Groups organize routes using approximate overlap of their paths and loops. Open a group to compare every starting point and path. Opposite directions share one route option; you can switch direction in its details when both qualify. Grouping does not stop exploration or limit the number of routes.',
      progress: { totalStarts: 0, attemptedStarts: 0, completedStarts: 0, expansions: 0, elapsedMs: 0 },
    };
    const worker = new Worker(new URL('./search-worker.js', import.meta.url), {
      workerData: { directory, query, snapshotId: dataset.info.id },
      resourceLimits: { maxOldGenerationSizeMb: 512 },
    });
    const entry: Entry = { snapshot, candidates: new Map(), groups: new Map(), worker };
    current = entry;
    worker.on('message', (event: WorkerEvent) => {
      if (snapshot.status !== 'running') return;
      try {
        if (event.type === 'coverage') snapshot.coverageNote = event.note;
        else if (event.type === 'route') {
          const hash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 32);
          const id = hash(event.route.summary.id);
          if (entry.candidates.has(id)) return;
          const groupId = hash(event.groupId), optionId = hash(event.optionId);
          const candidate = { ...event.route, summary: { ...event.route.summary, id } };
          let choice = entry.candidates.get(optionId)?.choice;
          if (!choice) {
            choice = { groupId, directions: [] };
            const group = entry.groups.get(groupId) ?? [];
            group.push(choice);
            entry.groups.set(groupId, group);
            snapshot.routeCount++;
            snapshot.groupCount = entry.groups.size;
          }
          choice.directions.push(candidate);
          entry.candidates.set(id, { route: candidate, choice });
        }
        else {
          snapshot.progress = event.progress;
          if (event.type === 'done') finish(entry, event.status, event.reason);
        }
      } catch (error) {
        finish(entry, 'failed', error instanceof Error ? error.message : 'Could not read a route');
        void worker.terminate();
      }
    });
    worker.on('error', error => {
      if (snapshot.status === 'running') finish(entry, 'failed', `Search failed: ${error instanceof Error ? error.message : 'worker error'}`);
    });
    worker.on('exit', () => {
      entry.worker = undefined;
      if (snapshot.status === 'running') finish(entry, 'failed', 'Search ended unexpectedly. Exploration is unfinished.');
    });
    return page(entry);
  }
  return { start, latest: () => current ? page(current) : null,
    get: (id: string, offset = 0, groupId?: string) => page(find(id), offset, groupId), stop,
    route: (id: string, routeId: string) => {
      const candidate = find(id).candidates.get(routeId);
      if (!candidate) throw new RequestError('This route is not available.', 404);
      return dataset.route(candidate.route).then(route => ({ ...route, ...summary(find(id), candidate.route, candidate.choice) }));
    },
    close: async () => { if (current) await stop(current.snapshot.id); } };
}
