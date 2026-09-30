import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import type { SearchEvent, SearchQuery, SearchSnapshot } from './model.js';
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
  return { area: [...query.area], distance: [...query.distance], gain: [...query.gain], repetition: query.repetition, includeUnknown: query.includeUnknown };
}

type Entry = { snapshot: SearchSnapshot; worker?: Worker };

/** Current searches live only as long as this process. Browser disconnects do not stop them. */
export function createSearches(directory: string, dataset: Awaited<ReturnType<typeof readDataset>>) {
  const entries = new Map<string, Entry>();
  function find(id: string): Entry {
    const entry = entries.get(id);
    if (!entry) throw new RequestError('This search has expired. Start a new search.', 404);
    return entry;
  }
  function finish(entry: Entry, status: SearchSnapshot['status'], reason?: string) {
    entry.snapshot.status = status;
    entry.snapshot.reason = reason;
  }
  async function stop(id: string) {
    const entry = find(id);
    if (entry.snapshot.status === 'running') {
      finish(entry, 'stopped', 'Stopped. The routes found so far are still available; exploration is unfinished.');
      await entry.worker?.terminate();
      entry.worker = undefined;
    }
    return entry.snapshot;
  }
  function start(query: SearchQuery) {
    if ([...entries.values()].filter(entry => entry.snapshot.status === 'running').length >= 2) {
      throw new RequestError('Two searches are already running. Stop a search or try again shortly.', 503);
    }
    // Bound retained results without creating a job-history database.
    for (const [id, entry] of entries) {
      if (entries.size < 4) break;
      if (entry.snapshot.status !== 'running') entries.delete(id);
    }
    const snapshot: SearchSnapshot = {
      id: randomUUID(), datasetId: dataset.graph.info.id, query, status: 'running', routes: [],
      selectionNote: 'Similar routes are grouped. Up to 10 choices per start and 300 overall are shown; this display limit does not stop exploration.',
      progress: { totalStarts: 0, attemptedStarts: 0, completedStarts: 0, expansions: 0, elapsedMs: 0 },
    };
    const worker = new Worker(new URL('./search-worker.js', import.meta.url), {
      workerData: { directory, query },
      resourceLimits: { maxOldGenerationSizeMb: 256 },
    });
    const entry: Entry = { snapshot, worker };
    entries.set(snapshot.id, entry);
    worker.on('message', (event: SearchEvent) => {
      if (snapshot.status !== 'running') return;
      try {
        if (event.type === 'route') {
          snapshot.routes.push(dataset.route(event.route));
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
    return snapshot;
  }
  return { start, get: (id: string) => find(id).snapshot, stop,
    close: () => Promise.all([...entries.keys()].map(stop)) };
}
