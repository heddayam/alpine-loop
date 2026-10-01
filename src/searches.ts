import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { DEFAULT_ROAD_LIMITS, type SearchQuery, type SearchSnapshot } from './model.js';
import type { WorkerEvent } from './data-format.js';
import type { readDataset } from './dataset.js';
import { createRouteStore } from './route-store.js';

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

type Entry = {
  snapshot: SearchSnapshot;
  store: ReturnType<typeof createRouteStore>;
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
  function page(entry: Entry, offset = 0, groupId?: string): SearchSnapshot {
    if (!Number.isSafeInteger(offset) || offset < 0) throw new RequestError('Choose a valid results page.', 400);
    const choices = entry.store.page(offset, groupId);
    if (!choices) throw new RequestError('This route group is not available.', 400);
    return { ...entry.snapshot, ...entry.store.counts, ...choices, offset, groupId };
  }
  async function stop(id: string, offset = 0, groupId?: string) {
    const entry = find(id);
    const current = page(entry, offset, groupId);
    if (current.status === 'running') {
      finish(entry, 'stopped', 'Stopped. The routes found so far are still available; exploration is unfinished.');
      await entry.worker?.terminate();
      entry.worker = undefined;
    }
    return page(find(id), offset, groupId);
  }
  function start(query: SearchQuery) {
    if (current?.snapshot.status === 'running') {
      throw new RequestError('A search is already running. Reload to reconnect, or stop it before starting another.', 409);
    }
    const store = createRouteStore();
    const snapshot: SearchSnapshot = {
      id: randomUUID(), datasetId: dataset.info.id, query, status: 'running', routes: [], routeCount: 0, groupCount: 0, pageTotal: 0, offset: 0,
      selectionNote: 'Small trail variations are combined when the overall trail path and loop each overlap by at least 95%, with no connected path difference longer than 500 meters. Road connections do not create separate hikes. For each starting point, shown routes prefer mapped access, then less road walking and shorter distance. Every shown route meets your limits. Different starting points and qualifying reverse directions are available in the details. Search continues through all eligible starts; these are representative choices, not every graph-path permutation.',
      progress: { totalStarts: 0, attemptedStarts: 0, completedStarts: 0, expansions: 0, elapsedMs: 0 },
    };
    let worker: Worker;
    try {
      worker = new Worker(new URL('./search-worker.js', import.meta.url), {
        workerData: { directory, query, snapshotId: dataset.info.id },
        resourceLimits: { maxOldGenerationSizeMb: 512 },
      });
    } catch (error) { store.close(); throw error; }
    current?.store.close();
    const entry: Entry = { snapshot, store, worker };
    current = entry;
    worker.on('message', (event: WorkerEvent) => {
      if (snapshot.status !== 'running') return;
      try {
        if (event.type === 'coverage') snapshot.coverageNote = event.note;
        else if (event.type === 'route') entry.store.add(event);
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
      const candidate = find(id).store.route(routeId);
      if (!candidate) throw new RequestError('This route is not available.', 404);
      return dataset.route(candidate.stored).then(route => {
        find(id);
        return { ...route, ...candidate.summary };
      });
    },
    close: async () => {
      const entry = current;
      current = undefined;
      if (!entry) return;
      if (entry.snapshot.status === 'running') finish(entry, 'stopped');
      try { await entry.worker?.terminate(); }
      finally { entry.store.close(); }
    } };
}
