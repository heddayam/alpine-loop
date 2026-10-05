import { DEFAULT_ROAD_LIMITS, type SearchQuery } from './model.js';

export class RequestError extends Error {
  constructor(message: string, public statusCode: number) { super(message); }
}

export function parseQuery(value: unknown): SearchQuery {
  if (!value || typeof value !== 'object') throw new RequestError('Choose regions and hike constraints.', 400);
  const query = value as SearchQuery;
  const range = (values: unknown, length: number): values is number[] => Array.isArray(values)
    && values.length === length && values.every(number => typeof number === 'number' && Number.isFinite(number));
  if (!Array.isArray(query.sections) || !query.sections.length || new Set(query.sections).size !== query.sections.length
    || query.sections.some(id => typeof id !== 'string' || !id.trim())) {
    throw new RequestError('Choose at least one distinct search region.', 400);
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
  return { sections: [...query.sections], distance: [...query.distance], gain: [...query.gain], repetition: query.repetition,
    includeUnknown: query.includeUnknown, roads: { distance: roads.distance, fraction: roads.fraction } };
}

import { randomUUID } from 'node:crypto';
import { mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import type { JobInputs, JobProgress, JobSnapshot, ResultSort, SortOrder } from './model.js';
import { createRouteStore } from './route-store.js';

export type JobWorkerEvent = { type: 'progress'; progress: JobProgress; inputs?: JobInputs }
  | { type: 'done'; progress: JobProgress };
const terminal = (job: JobSnapshot) => job.status !== 'running' && job.status !== 'queued';

/** Metadata has one owner. A result file is published only after its worker exits successfully. */
export async function createJobs(dataDirectory: string, directory: string) {
  await mkdir(directory, { recursive: true });
  const owner = new DatabaseSync(join(directory, 'owner.sqlite'));
  try { owner.exec('BEGIN EXCLUSIVE'); }
  catch (error) {
    owner.close();
    if (error instanceof Error && 'code' in error && error.code === 'ERR_SQLITE_ERROR') {
      throw new Error('Another Alpine Loop app is already using this job storage. Close it before starting another.');
    }
    throw error;
  }
  const release = async () => { if (owner.isOpen) owner.close(); };
  let db: DatabaseSync;
  try { db = new DatabaseSync(join(directory, 'metadata.sqlite')); }
  catch (error) { await release(); throw error; }
  try {
  db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS jobs (position INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, snapshot TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS job_inputs (id TEXT PRIMARY KEY, facts TEXT NOT NULL);`);
  const insert = db.prepare('INSERT INTO jobs(id, snapshot) VALUES (?, ?)');
  const update = db.prepare('UPDATE jobs SET snapshot = ? WHERE id = ?');
  const saveInputs = db.prepare('INSERT OR REPLACE INTO job_inputs VALUES (?, ?)');
  const loadInputs = db.prepare('SELECT facts FROM job_inputs WHERE id = ?');
  const rows = () => db.prepare('SELECT snapshot FROM jobs ORDER BY position').all()
    .map(row => JSON.parse(row.snapshot as string) as JobSnapshot);
  const find = (id: string): JobSnapshot => {
    const row = db.prepare('SELECT snapshot FROM jobs WHERE id = ?').get(id);
    if (!row) throw new RequestError('This search job is not available.', 404);
    return JSON.parse(row.snapshot as string) as JobSnapshot;
  };
  const save = (job: JobSnapshot) => update.run(JSON.stringify(job), job.id);
  const resultPath = (id: string, staging = false) => join(directory, `${id}${staging ? '.staging' : ''}.sqlite`);
  const discard = async (id: string) => {
    for (const staging of [false, true]) for (const suffix of ['', '-journal', '-wal', '-shm']) {
      await rm(resultPath(id, staging) + suffix, { force: true });
    }
  };
  // Inputs are separate from frequently polled compact status/history metadata.
  for (const job of rows()) if (job.inputs) {
    saveInputs.run(job.id, JSON.stringify(job.inputs));
    job.regions = job.inputs.sections.map(({ id, name }) => ({ id, name }));
    delete job.inputs; save(job);
  }
  for (const job of rows()) if (job.status === 'running') {
    job.status = 'interrupted'; job.finishedAt = new Date().toISOString();
    job.reason = 'The app restarted before this job finished. Copy its settings to submit it again.';
    save(job); await discard(job.id);
  }
  const known = new Set(rows().filter(job => job.status === 'completed').map(job => `${job.id}.sqlite`));
  for (const file of await readdir(directory)) {
    if (/^[a-f0-9-]{36}(\.staging)?\.sqlite(?:-journal|-wal|-shm)?$/.test(file) && !known.has(file)) {
      await rm(join(directory, file), { force: true });
    }
  }
  let closed = false;
  let active: { id: string; worker: Worker; finished: Promise<void> } | undefined;
  let pumping = false;
  function snapshot(id: string, includeInputs = true): JobSnapshot {
    const job = find(id);
    if (job.status === 'queued') job.queuePosition = rows().filter(entry => entry.status === 'queued').findIndex(entry => entry.id === id) + 1;
    if (job.status === 'running' && job.startedAt) job.progress.elapsedMs = Date.now() - Date.parse(job.startedAt);
    if (includeInputs) {
      const inputs = loadInputs.get(id);
      if (inputs) job.inputs = JSON.parse(inputs.facts as string);
    }
    return job;
  }
  async function run(job: JobSnapshot) {
    job.status = 'running'; job.startedAt = new Date().toISOString(); delete job.queuePosition; save(job);
    let done: Extract<JobWorkerEvent, { type: 'done' }> | undefined, failure: string | undefined;
    let worker: Worker;
    try {
      worker = new Worker(new URL('./search-worker.js', import.meta.url), {
        workerData: { directory: dataDirectory, query: job.query, resultPath: resultPath(job.id, true) },
        resourceLimits: { maxOldGenerationSizeMb: 512 },
      });
    } catch (error) {
      job.status = 'failed'; job.reason = error instanceof Error ? error.message : 'Could not start this job.';
      job.finishedAt = new Date().toISOString(); save(job); await discard(job.id); return;
    }
    const finished = new Promise<void>(resolve => {
      worker.on('message', (event: JobWorkerEvent) => {
        const current = find(job.id);
        if (current.status !== 'running' || closed) return;
        if (event.type === 'done') { done = event; return; }
        current.progress = event.progress;
        if (event.inputs) {
          saveInputs.run(job.id, JSON.stringify(event.inputs));
          current.regions = event.inputs.sections.map(({ id, name }) => ({ id, name }));
        }
        save(current);
      });
      worker.on('error', error => { failure = error instanceof Error ? error.message : 'The search worker failed.'; });
      worker.on('exit', code => {
        if (code !== 0) failure ??= 'The search worker ended unexpectedly.';
        resolve();
      });
    });
    active = { id: job.id, worker, finished };
    await finished;
    let current = find(job.id);
    if (current.status === 'running' && done && !failure && !closed) {
      try {
        const store = createRouteStore(resultPath(job.id, true));
        let counts: { routeCount: number; groupCount: number };
        try { counts = store.counts; } finally { store.close(); }
        await rename(resultPath(job.id, true), resultPath(job.id));
        const folder = await open(directory, 'r');
        try { await folder.sync(); } finally { await folder.close(); }
        const storageBytes = (await stat(resultPath(job.id))).size;
        // Cancellation/close can arrive during filesystem awaits. Publication itself
        // is synchronous, so the final state check and metadata commit are indivisible.
        current = find(job.id);
        if (current.status === 'running' && !closed) {
          const completed = { ...current, ...counts, storageBytes, status: 'completed' as const,
            progress: done.progress, finishedAt: new Date().toISOString() };
          db.exec('BEGIN');
          try { save(completed); db.exec('COMMIT'); }
          catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
        }
      } catch (error) { failure = error instanceof Error ? error.message : 'Could not save this job.'; }
    }
    current = find(job.id);
    if (current.status === 'running') {
      current.status = closed ? 'interrupted' : 'failed'; current.finishedAt = new Date().toISOString();
      current.reason = failure ?? 'The worker ended before all results were saved.';
      save(current);
    }
    if (current.status !== 'completed') await discard(job.id);
    if (active?.id === job.id) active = undefined;
  }
  async function pump() {
    if (pumping || closed) return;
    pumping = true;
    try {
      for (;;) {
        const next = rows().find(job => job.status === 'queued');
        if (!next || closed) break;
        const execution = run(next);
        if (active?.id === next.id) active.finished = execution;
        await execution;
      }
    } finally { pumping = false; }
  }
  const startPump = () => { void pump(); };
  startPump();
  function results<T>(id: string, read: (store: ReturnType<typeof createRouteStore>) => T): T {
    const job = find(id);
    if (job.status !== 'completed') throw new RequestError('Results are available after this job completes.', 409);
    const store = createRouteStore(resultPath(id));
    try { return read(store); } finally { store.close(); }
  }
  return {
    start(query: SearchQuery): JobSnapshot {
      const job: JobSnapshot = { id: randomUUID(), query: structuredClone(query), status: 'queued', createdAt: new Date().toISOString(),
        progress: { stage: 'preparing', completedRegions: [], totalRegions: query.sections.length, elapsedMs: 0, expansions: 0, totalStarts: 0, completedStarts: 0 }, storageBytes: 0 };
      insert.run(job.id, JSON.stringify(job)); startPump(); return snapshot(job.id, false);
    },
    list: () => {
      const entries = rows();
      let queuedPosition = 0;
      for (const job of entries) {
        if (job.status === 'queued') job.queuePosition = ++queuedPosition;
        if (job.status === 'running' && job.startedAt) job.progress.elapsedMs = Date.now() - Date.parse(job.startedAt);
      }
      return entries.toReversed();
    },
    get: snapshot,
    page(id: string, offset = 0, groupId?: string, sort: ResultSort = 'distance', order: SortOrder = 'asc') {
      if (!Number.isSafeInteger(offset) || offset < 0 || !['distance', 'gain', 'repetition', 'roadDistance'].includes(sort) || !['asc', 'desc'].includes(order)) {
        throw new RequestError('Choose a valid results page and sort order.', 400);
      }
      return results(id, store => {
        const page = store.page(offset, groupId, sort, order);
        if (!page) throw new RequestError('This hike is not available.', 404);
        return page;
      });
    },
    locations: (id: string) => results(id, store => store.locations()),
    route: (id: string, routeId: string) => results(id, store => {
      const route = store.route(routeId);
      if (!route) throw new RequestError('This route is not available.', 404);
      return route;
    }),
    async cancel(id: string) {
      const job = snapshot(id, false);
      if (terminal(job)) {
        const pending = active?.id === id ? active.finished : undefined;
        if (pending) await pending;
        return job;
      }
      job.status = 'cancelled'; job.finishedAt = new Date().toISOString(); job.reason = 'Cancelled before completion. No unfinished results were saved.';
      delete job.queuePosition; save(job);
      const running = active?.id === id ? active : undefined;
      if (running) { await running.worker.terminate(); await running.finished; }
      await discard(id); startPump(); return job;
    },
    async delete(id: string) {
      const job = find(id);
      if (!terminal(job)) throw new RequestError('Cancel this job before deleting it.', 409);
      const pending = active?.id === id ? active.finished : undefined;
      if (pending) await pending;
      await discard(id);
      db.exec('BEGIN');
      try { db.prepare('DELETE FROM job_inputs WHERE id = ?').run(id); db.prepare('DELETE FROM jobs WHERE id = ?').run(id); db.exec('COMMIT'); }
      catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
    },
    async close() {
      if (closed) return;
      closed = true;
      const current = active;
      if (current) {
        const job = snapshot(current.id, false);
        if (job.status === 'running') {
          job.status = 'interrupted'; job.finishedAt = new Date().toISOString();
          job.reason = 'The app closed before this job finished. Copy its settings to submit it again.'; save(job);
        }
        await current.worker.terminate(); await current.finished; await discard(current.id);
      }
      while (pumping) await new Promise(resolve => setTimeout(resolve, 1));
      db.close(); await release();
    },
  };
  } catch (error) { db.close(); await release(); throw error; }
}
