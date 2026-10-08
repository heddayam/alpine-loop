import { DEFAULT_ROAD_LIMITS, type SearchQuery } from './model.js';
import { boundaryError } from './boundary.js';
import { validGradeLimits } from './grade.js';

export class RequestError extends Error {
  constructor(message: string, public statusCode: number) { super(message); }
}

export function parseQuery(value: unknown): SearchQuery {
  if (!value || typeof value !== 'object') throw new RequestError('Choose regions and hike constraints.', 400);
  const query = value as SearchQuery;
  if (query.grades !== undefined && !validGradeLimits(query.grades)) {
    throw new RequestError('Grade thresholds and allowed distances must be finite and zero or greater.', 400);
  }
  if (query.boundary !== undefined) {
    const error = boundaryError(query.boundary);
    if (error) throw new RequestError(error, 400);
  }
  if (query.effort !== undefined && query.effort !== 'deep') throw new RequestError('Submit a search using the current search settings.', 400);
  const range = (values: unknown, length: number): values is number[] => Array.isArray(values)
    && values.length === length && values.every(number => typeof number === 'number' && Number.isFinite(number));
  if (!Array.isArray(query.sections) || (!query.sections.length && !query.boundary) || new Set(query.sections).size !== query.sections.length
    || query.sections.some(id => typeof id !== 'string' || !id.trim())) {
    throw new RequestError('Choose at least one distinct search region.', 400);
  }
  if ([query.distance, query.gain].some(values => !range(values, 2) || values[0]! < 0 || values[0]! > values[1]!)
    || query.distance[1] <= 0
    || typeof query.includeUnknown !== 'boolean') {
    throw new RequestError('Use ordered, nonnegative distance and elevation gain ranges.', 400);
  }
  if (query.stem === undefined && query.repetition === undefined) throw new RequestError('Specify a stem distance or percentage limit.', 400);
  if (query.stem !== undefined && (typeof query.stem !== 'number' || !Number.isFinite(query.stem) || query.stem < 0)) {
    throw new RequestError('Use a finite, nonnegative stem distance.', 400);
  }
  if (query.repetition !== undefined && (typeof query.repetition !== 'number' || !Number.isFinite(query.repetition)
    || query.repetition < 0 || query.repetition > 1)) throw new RequestError('Use a stem percentage from 0% to 100%.', 400);
  const roads = query.roads === undefined ? DEFAULT_ROAD_LIMITS : query.roads;
  if (!roads || typeof roads.distance !== 'number' || !Number.isFinite(roads.distance) || roads.distance < 0
    || typeof roads.fraction !== 'number' || !Number.isFinite(roads.fraction) || roads.fraction < 0 || roads.fraction > 1) {
    throw new RequestError('Use a nonnegative road distance and a road percentage from 0% to 100%.', 400);
  }
  return { sections: [...query.sections], effort: 'deep', distance: [...query.distance], gain: [...query.gain],
    ...(query.grades ? { grades: {
      uphill: { above: query.grades.uphill.above, total: query.grades.uphill.total, longest: query.grades.uphill.longest },
      downhill: { above: query.grades.downhill.above, total: query.grades.downhill.total, longest: query.grades.downhill.longest },
    } } : {}),
    ...(query.boundary ? { boundary: query.boundary.map(point => [...point]) } : {}),
    ...(query.stem === undefined ? {} : { stem: query.stem }),
    ...(query.repetition === undefined ? {} : { repetition: query.repetition }),
    includeUnknown: query.includeUnknown, roads: { distance: roads.distance, fraction: roads.fraction } };
}

import { randomUUID } from 'node:crypto';
import { mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import type { JobHistoryPage, JobInputs, JobProgress, JobSnapshot, ResultSort, SortOrder } from './model.js';
import { createRouteStore } from './route-store.js';

export type JobWorkerEvent = { type: 'progress'; progress: JobProgress; inputs?: JobInputs }
  | { type: 'done'; progress: JobProgress; counts: { routeCount: number; groupCount: number } };
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
    CREATE TABLE IF NOT EXISTS jobs (position INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, snapshot TEXT NOT NULL, status TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS job_inputs (id TEXT PRIMARY KEY, facts TEXT NOT NULL);`);
  if (!db.prepare('PRAGMA table_info(jobs)').all().some(column => column.name === 'status')) db.exec("ALTER TABLE jobs ADD COLUMN status TEXT NOT NULL DEFAULT ''");
  db.exec('CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status, position)');
  const insert = db.prepare('INSERT INTO jobs(id, snapshot, status) VALUES (?, ?, ?)');
  const update = db.prepare('UPDATE jobs SET snapshot = ?, status = ? WHERE id = ?');
  const saveInputs = db.prepare('INSERT OR REPLACE INTO job_inputs VALUES (?, ?)');
  const loadInputs = db.prepare('SELECT facts FROM job_inputs WHERE id = ?');
  const rows = () => db.prepare('SELECT snapshot FROM jobs ORDER BY position').all()
    .map(row => JSON.parse(row.snapshot as string) as JobSnapshot);
  let currentProgress: JobSnapshot | undefined;
  const find = (id: string): JobSnapshot => {
    if (currentProgress?.id === id) return structuredClone(currentProgress);
    const row = db.prepare('SELECT snapshot FROM jobs WHERE id = ?').get(id);
    if (!row) throw new RequestError('This search job is not available.', 404);
    return JSON.parse(row.snapshot as string) as JobSnapshot;
  };
  const save = (job: JobSnapshot) => {
    update.run(JSON.stringify(job), job.status, job.id);
    if (currentProgress?.id === job.id) currentProgress = structuredClone(job);
  };
  const resultPath = (id: string, staging = false, revision = 0) => join(directory,
    `${id}${staging ? '.staging' : revision ? `.results-${revision}` : ''}.sqlite`);
  const published = (job: JobSnapshot) => job.resultsRevision !== undefined || job.status === 'completed';
  const publishedPath = (job: JobSnapshot) => resultPath(job.id, false, job.resultsRevision ?? 0);
  const discard = async (id: string, keep?: JobSnapshot) => {
    for (const file of await readdir(directory)) if (file.startsWith(`${id}.`) && file.endsWith('.sqlite')
      || file.startsWith(`${id}.`) && /\.sqlite-(journal|wal|shm)$/.test(file)) {
      if (keep && published(keep) && join(directory, file) === publishedPath(keep)) continue;
      await rm(join(directory, file), { force: true });
    }
  };
  const restore = (job: JobSnapshot, status: 'failed' | 'cancelled' | 'interrupted', reason: string) => {
    job.status = published(job) ? 'completed' : status;
    job.finishedAt = new Date().toISOString(); delete job.queuePosition;
    job.reason = published(job) ? `${reason} Existing results were kept.` : reason;
    save(job);
  };
  const nextQueued = () => {
    const row = db.prepare("SELECT snapshot FROM jobs WHERE status = 'queued' ORDER BY position LIMIT 1").get();
    return row && JSON.parse(row.snapshot as string) as JobSnapshot | undefined;
  };
  // Reconcile old metadata once on startup; routine status reads touch only active rows.
  db.exec("UPDATE jobs SET status = json_extract(snapshot, '$.status') WHERE status != json_extract(snapshot, '$.status')");
  // Inputs are separate from frequently polled compact status/history metadata.
  for (const job of rows()) if (job.inputs) {
    saveInputs.run(job.id, JSON.stringify(job.inputs));
    job.regions = job.inputs.sections.map(({ id, name, state, regionId, regionName }) => ({ id, name, state, regionId, regionName }));
    delete job.inputs; save(job);
  }
  for (const job of rows()) if (job.status === 'running') {
    restore(job, 'interrupted', 'The app restarted before this search finished.');
    await discard(job.id, job);
  }
  const known = new Set(rows().filter(published).map(job => publishedPath(job).slice(directory.length + 1)));
  for (const file of await readdir(directory)) {
    if (/^[a-f0-9-]{36}(\.staging|\.results-\d+)?\.sqlite(?:-journal|-wal|-shm)?$/.test(file) && !known.has(file)) {
      await rm(join(directory, file), { force: true });
    }
  }
  let closed = false;
  let active: { id: string; worker: Worker; finished: Promise<void> } | undefined;
  let pumping = false;
  function snapshot(id: string, includeInputs = true): JobSnapshot {
    const job = find(id);
    if (job.status === 'queued') job.queuePosition = Number(db.prepare(`SELECT COUNT(*) AS count FROM jobs
      WHERE status = 'queued' AND position <= (SELECT position FROM jobs WHERE id = ?)`).get(id)!.count);
    if (job.status === 'running' && job.startedAt) job.progress.elapsedMs = Date.now() - Date.parse(job.startedAt);
    if (includeInputs) {
      const inputs = loadInputs.get(id);
      if (inputs) job.inputs = JSON.parse(inputs.facts as string);
    }
    return job;
  }
  async function run(job: JobSnapshot) {
    job.status = 'running'; job.startedAt = new Date().toISOString(); delete job.queuePosition; save(job);
    currentProgress = structuredClone(job);
    let persistedAt = Date.now();
    let done: Extract<JobWorkerEvent, { type: 'done' }> | undefined, failure: string | undefined;
    let worker: Worker;
    const revision = 0;
    try {
      worker = new Worker(new URL('./search-worker.js', import.meta.url), {
        workerData: { directory: dataDirectory, query: job.query, resultPath: resultPath(job.id, true) },
        resourceLimits: { maxOldGenerationSizeMb: 256 },
      });
    } catch (error) {
      restore(job, 'failed', error instanceof Error ? error.message : 'Could not start this job.');
      await discard(job.id, job); currentProgress = undefined; return;
    }
    const finished = new Promise<void>(resolve => {
      worker.on('message', (event: JobWorkerEvent) => {
        const current = find(job.id);
        if (current.status !== 'running' || closed) return;
        if (event.type === 'done') { done = event; return; }
        current.progress = event.progress;
        if (event.inputs) {
          saveInputs.run(job.id, JSON.stringify(event.inputs));
          current.regions = event.inputs.sections.map(({ id, name, state, regionId, regionName }) => ({ id, name, state, regionId, regionName }));
        }
        currentProgress = current;
        if (event.inputs || Date.now() - persistedAt >= 1000) {
          save(current); persistedAt = Date.now();
        }
      });
      worker.on('error', error => { failure = error instanceof Error ? error.message : 'The search worker failed.'; });
      worker.on('exit', code => {
        if (code !== 0) failure ??= 'The search worker ended unexpectedly.';
        resolve();
      });
    });
    active = { id: job.id, worker, finished };
    // Worker heap limits exclude native buffers and SQLite; RSS includes the whole backend.
    const memoryGuard = setInterval(() => {
      if (process.memoryUsage.rss() <= 768 * 1024 * 1024 || failure) return;
      failure = 'This search exceeded the local app memory budget. Try fewer regions or a narrower distance range.';
      void worker.terminate();
    }, 250);
    try { await finished; } finally { clearInterval(memoryGuard); }
    let current = find(job.id);
    if (current.status === 'running' && done && !failure && !closed) {
      try {
        const counts = done.counts;
        await rename(resultPath(job.id, true), resultPath(job.id, false, revision));
        const folder = await open(directory, 'r');
        try { await folder.sync(); } finally { await folder.close(); }
        const storageBytes = (await stat(resultPath(job.id, false, revision))).size;
        // Cancellation/close can arrive during filesystem awaits. Publication itself
        // is synchronous, so the final state check and metadata commit are indivisible.
        current = find(job.id);
        if (current.status === 'running' && !closed) {
          const completed = { ...current, ...counts, storageBytes, status: 'completed' as const,
            resultsRevision: revision,
            progress: done.progress, finishedAt: new Date().toISOString() };
          db.exec('BEGIN');
          try { save(completed); db.exec('COMMIT'); }
          catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
        }
      } catch (error) { failure = error instanceof Error ? error.message : 'Could not save this job.'; }
    }
    current = find(job.id);
    if (current.status === 'running') {
      restore(current, closed ? 'interrupted' : 'failed', failure ?? 'The worker ended before all results were saved.');
    }
    await discard(job.id, current);
    if (active?.id === job.id) active = undefined;
    currentProgress = undefined;
  }
  async function pump() {
    if (pumping || closed) return;
    pumping = true;
    try {
      for (;;) {
        const next = nextQueued();
        if (!next || closed) break;
        const execution = run(next);
        if (active?.id === next.id) active.finished = execution;
        await execution;
      }
    } finally { pumping = false; }
  }
  const startPump = () => { void pump(); };
  startPump();
  function results<T>(id: string, read: (store: ReturnType<typeof createRouteStore>) => T, revision?: number): T {
    const job = find(id);
    if (!published(job)) throw new RequestError('Results are available after this job completes.', 409);
    revision ??= job.resultsRevision ?? 0;
    if (!Number.isSafeInteger(revision) || revision < 0 || revision > (job.resultsRevision ?? 0)) {
      throw new RequestError('Choose a published results revision.', 400);
    }
    const store = createRouteStore(publishedPath(job), { revision, counts: revision === (job.resultsRevision ?? 0) && job.routeCount !== undefined && job.groupCount !== undefined
      ? { routeCount: job.routeCount, groupCount: job.groupCount } : undefined });
    try { return read(store); } finally { store.close(); }
  }
  return {
    start(query: SearchQuery): JobSnapshot {
      const job: JobSnapshot = { id: randomUUID(), query: structuredClone(query), status: 'queued', createdAt: new Date().toISOString(),
        progress: { stage: 'preparing', completedRegions: [], totalRegions: query.sections.length, elapsedMs: 0, expansions: 0, totalStarts: 0, completedStarts: 0 }, storageBytes: 0 };
      insert.run(job.id, JSON.stringify(job), job.status);
      startPump(); return snapshot(job.id, false);
    },
    active: () => db.prepare("SELECT id FROM jobs WHERE status IN ('queued', 'running') ORDER BY position DESC").all()
      .map(row => snapshot(row.id as string, false)),
    history(before?: string): JobHistoryPage {
      let position = Number.MAX_SAFE_INTEGER;
      if (before !== undefined) {
        const row = db.prepare('SELECT position FROM jobs WHERE id = ?').get(before);
        if (!row) throw new RequestError('This history page is no longer available.', 404);
        position = Number(row.position);
      }
      const entries = db.prepare('SELECT id FROM jobs WHERE position < ? ORDER BY position DESC LIMIT 51').all(position);
      const jobs = entries.slice(0, 50).map(row => snapshot(row.id as string, false));
      return { jobs, ...(entries.length > 50 ? { nextCursor: jobs.at(-1)!.id } : {}) };
    },
    get: snapshot,
    page(id: string, offset = 0, sort: ResultSort = 'distance', order: SortOrder = 'asc', revision?: number) {
      if (!Number.isSafeInteger(offset) || offset < 0 || !['distance', 'gain', 'repetition', 'roadDistance'].includes(sort) || !['asc', 'desc'].includes(order)) {
        throw new RequestError('Choose a valid results page and sort order.', 400);
      }
      return results(id, store => store.page(offset, sort, order), revision);
    },
    locations: (id: string, revision?: number) => results(id, store => store.locations(), revision),
    paths(id: string, bounds: number[], revision?: number) {
      if (bounds.length !== 4 || bounds.some(value => !Number.isFinite(value))
        || bounds[0]! > bounds[2]! || bounds[1]! > bounds[3]!
        || bounds[0]! < -180 || bounds[2]! > 180 || bounds[1]! < -90 || bounds[3]! > 90) {
        throw new RequestError('Choose valid map bounds.', 400);
      }
      return results(id, store => store.paths(bounds as [number, number, number, number]), revision);
    },
    route: (id: string, routeId: string, revision?: number) => results(id, store => {
      const route = store.route(routeId);
      if (!route) throw new RequestError('This route is not available.', 404);
      return route;
    }, revision),
    async cancel(id: string) {
      const job = snapshot(id, false);
      if (terminal(job)) {
        const pending = active?.id === id ? active.finished : undefined;
        if (pending) await pending;
        return job;
      }
      restore(job, 'cancelled', 'Cancelled before completion.');
      const running = active?.id === id ? active : undefined;
      if (running) { await running.worker.terminate(); await running.finished; }
      await discard(id, job); startPump(); return job;
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
          restore(job, 'interrupted', 'The app closed before this search finished.');
        }
        await current.worker.terminate(); await current.finished; await discard(current.id, find(current.id));
      }
      while (pumping) await new Promise(resolve => setTimeout(resolve, 1));
      db.close(); await release();
    },
  };
  } catch (error) { db.close(); await release(); throw error; }
}
