import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gpx, readDataset } from './dataset.js';
import { gpxFilename } from './route-name.js';
import { createJobs, parseQuery, RequestError } from './jobs.js';
import { createHostedAccess, type HostingOptions } from './hosted-access.js';
import type { JobSnapshot, ResultSort, SortOrder } from './model.js';
import type { FastifyRequest } from 'fastify';

export async function createApp(directory: string, clientDirectory?: string, jobDirectory = resolve('.local-data/jobs'), hosting: HostingOptions = {}) {
  const access = createHostedAccess(hosting);
  // Saved jobs remain usable even when the prepared catalog has been removed.
  let dataset = await readDataset(directory).catch(() => undefined);
  const jobs = await createJobs(directory, jobDirectory);
  // Old immutable results lack per-trail names. Retain only one section's names,
  // never its graph, and share concurrent reads. New jobs save names themselves.
  let trailNames: { key: string; pending: Promise<(string | null)[] | undefined> } | undefined;
  const availableData = async () => {
    if (!dataset) dataset = await readDataset(directory).catch(() => undefined);
    if (!dataset) throw new RequestError('Prepared trail data is unavailable. Saved jobs remain available in Jobs.', 503);
    return dataset;
  };
  const app = Fastify({ bodyLimit: 16_384 });
  app.setErrorHandler((error, _request, reply) => {
    const status = error instanceof Error && 'statusCode' in error && typeof error.statusCode === 'number' ? error.statusCode : 500;
    if (status === 500) app.log.error(error);
    if (status === 429) reply.header('Retry-After', '60');
    reply.code(status).send({ message: status === 500 || !(error instanceof Error) ? 'The app could not complete this request.' : error.message });
  });
  app.addHook('onClose', async () => { await Promise.all([jobs.close(), dataset?.downloads.close()]); });
  app.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (access) {
      access.mutation(request);
      // Set the cookie on the initial document before its concurrent API reads.
      if (request.url.split('?')[0] !== '/health') access.identify(request, reply);
      return;
    }
    const origin = request.headers.origin;
    if ((request.method === 'POST' || request.method === 'DELETE') && origin) {
      let valid = false;
      try { valid = new URL(origin).host === request.headers.host; } catch { /* Invalid origins are rejected. */ }
      if (!valid) throw new RequestError('Open this app directly before changing a job or download.', 403);
    }
  });
  app.addHook('preHandler', async request => {
    if (access && request.routeOptions.url?.startsWith('/api/jobs/:id')) {
      jobs.authorize((request.params as { id: string }).id, access.visitor(request), request.method !== 'GET' && request.method !== 'HEAD');
    }
  });
  const visitor = (request: FastifyRequest) => access?.visitor(request);
  const view = (request: FastifyRequest, job: JobSnapshot) => access
    ? { ...job, canManage: jobs.authorize(job.id, access.visitor(request)) } : job;
  const requireDownloads = () => {
    if (access) throw new RequestError('Trail data is installed by the site administrator. This area is currently unavailable for new searches.', 503);
  };
  app.get('/health', async () => ({ status: 'ok' }));
  app.get('/api/catalog', async () => (await availableData()).view());
  app.post('/api/coverage', async request => (await availableData()).coverage(parseQuery(request.body)));
  app.get('/api/downloads', async () => (await availableData()).downloads.latest());
  app.post('/api/downloads', async (request, reply) => {
    requireDownloads();
    const ids = (request.body as { sections?: unknown })?.sections;
    if (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== 'string')) throw new RequestError('Choose trail sections to download.', 400);
    return reply.code(202).send((await availableData()).downloads.start(ids));
  });
  app.post('/api/downloads/stop', async () => { requireDownloads(); return (await availableData()).downloads.stop(); });
  app.get('/api/jobs', async request => jobs.history(undefined, visitor(request)).jobs.map(job => view(request, job)));
  app.get('/api/jobs/active', async request => jobs.active(visitor(request)).map(job => view(request, job)));
  app.get<{ Querystring: { before?: string } }>('/api/jobs/history', async request => {
    const page = jobs.history(request.query.before, visitor(request));
    return { ...page, jobs: page.jobs.map(job => view(request, job)) };
  });
  app.post('/api/jobs', async (request, reply) => {
    const query = parseQuery(request.body);
    const coverage = await (await availableData()).coverage(query);
    query.sections = coverage.sections;
    if (coverage.missing.length) {
      requireDownloads();
      return reply.code(409).send({ message: 'Download the selected trail sections before searching.', ...coverage });
    }
    return reply.code(202).send(view(request, jobs.start(query, visitor(request))));
  });
  app.get<{ Params: { id: string }; Querystring: { inputs?: string } }>('/api/jobs/:id', async request => view(request, jobs.get(request.params.id, request.query.inputs !== 'false')));
  const revision = (value?: string) => value === undefined ? undefined : Number(value);
  app.get<{ Params: { id: string }; Querystring: { offset?: string; sort?: ResultSort; order?: SortOrder; revision?: string } }>('/api/jobs/:id/results', async request =>
    jobs.page(request.params.id, Number(request.query.offset ?? 0), request.query.sort, request.query.order, revision(request.query.revision)));
  app.get<{ Params: { id: string }; Querystring: { revision?: string } }>('/api/jobs/:id/locations', async request => jobs.locations(request.params.id, revision(request.query.revision)));
  app.get<{ Params: { id: string }; Querystring: { west?: string; south?: string; east?: string; north?: string; revision?: string } }>('/api/jobs/:id/paths', async request =>
    jobs.paths(request.params.id, [request.query.west, request.query.south, request.query.east, request.query.north].map(value => value === undefined || !value.trim() ? NaN : Number(value)), revision(request.query.revision)));
  app.post<{ Params: { id: string } }>('/api/jobs/:id/cancel', async request => view(request, await jobs.cancel(request.params.id)));
  app.delete<{ Params: { id: string } }>('/api/jobs/:id', async (request, reply) => { await jobs.delete(request.params.id); return reply.code(204).send(); });
  app.get<{ Params: { id: string; routeId: string }; Querystring: { revision?: string } }>('/api/jobs/:id/routes/:routeId', async request => {
    const route = jobs.route(request.params.id, request.params.routeId, revision(request.query.revision));
    if (!dataset || !route.segments?.some(segment => segment.name === undefined)) return route;
    for (const section of jobs.get(request.params.id).inputs?.sections ?? []) {
      const missing = route.segments.filter(segment => segment.name === undefined && segment.id.startsWith(`${section.id}:`));
      if (!missing.length) continue;
      const key = `${section.id}:${section.files.graph.sha256}`;
      if (trailNames?.key !== key) trailNames = { key, pending: dataset.readTrailNames(section).catch(() => undefined) };
      const names = await trailNames.pending;
      for (const segment of missing) {
        const name = names?.[Number(segment.id.slice(section.id.length + 1))];
        if (name !== undefined) segment.name = name;
      }
    }
    return route;
  });
  app.get<{ Params: { id: string; routeId: string }; Querystring: { revision?: string; units?: string } }>('/api/jobs/:id/routes/:routeId.gpx', async (request, reply) => {
    const route = jobs.route(request.params.id, request.params.routeId, revision(request.query.revision));
    return reply.type('application/gpx+xml').header('Content-Disposition', `attachment; filename="${gpxFilename(route, request.query.units === 'metric' ? 'metric' : 'imperial')}"`).send(gpx(route));
  });
  if (clientDirectory) await app.register(fastifyStatic, {
    root: clientDirectory,
    preCompressed: true,
    setHeaders(reply, path) {
      if (relative(clientDirectory, path).startsWith(`assets${sep}`))
        reply.header('Cache-Control', 'public, max-age=31536000, immutable');
    },
  });
  return app;
}

export async function startServer() {
  const directory = resolve(process.env.ALPINE_DATA ?? '.local-data/mountains');
  const app = await createApp(directory, fileURLToPath(new URL('../client', import.meta.url)), resolve(process.env.ALPINE_JOBS ?? '.local-data/jobs'));
  const address = await app.listen({ host: process.env.HOST ?? '127.0.0.1', port: Number(process.env.PORT ?? 3000) });
  console.log(`Alpine Loop: ${address}`);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void app.close(); });
  return app;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await startServer();
