import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gpx, readDataset } from './dataset.js';
import { createJobs, parseQuery, RequestError } from './jobs.js';
import type { ResultSort, SortOrder } from './model.js';

export async function createApp(directory: string, clientDirectory?: string, jobDirectory = resolve('.local-data/jobs')) {
  // Saved jobs remain usable even when the prepared catalog has been removed.
  let dataset = await readDataset(directory).catch(() => undefined);
  const jobs = await createJobs(directory, jobDirectory);
  const availableData = async () => {
    if (!dataset) dataset = await readDataset(directory).catch(() => undefined);
    if (!dataset) throw new RequestError('Prepared trail data is unavailable. Saved jobs remain available in Jobs.', 503);
    return dataset;
  };
  const app = Fastify({ bodyLimit: 4096 });
  app.setErrorHandler((error, _request, reply) => {
    const status = error instanceof Error && 'statusCode' in error && typeof error.statusCode === 'number' ? error.statusCode : 500;
    if (status === 500) app.log.error(error);
    reply.code(status).send({ message: status === 500 || !(error instanceof Error) ? 'The app could not complete this request.' : error.message });
  });
  app.addHook('onClose', async () => { await Promise.all([jobs.close(), dataset?.downloads.close()]); });
  app.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const origin = request.headers.origin;
    if ((request.method === 'POST' || request.method === 'DELETE') && origin) {
      let valid = false;
      try { valid = new URL(origin).host === request.headers.host; } catch { /* Invalid origins are rejected. */ }
      if (!valid) throw new RequestError('Open this app directly before changing a job or download.', 403);
    }
  });
  app.get('/api/catalog', async () => (await availableData()).view());
  app.post('/api/coverage', async request => (await availableData()).coverage(parseQuery(request.body)));
  app.get('/api/downloads', async () => (await availableData()).downloads.latest());
  app.post('/api/downloads', async (request, reply) => {
    const ids = (request.body as { sections?: unknown })?.sections;
    if (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== 'string')) throw new RequestError('Choose trail sections to download.', 400);
    return reply.code(202).send((await availableData()).downloads.start(ids));
  });
  app.post('/api/downloads/stop', async () => (await availableData()).downloads.stop());
  app.get('/api/jobs', async () => jobs.history().jobs);
  app.get('/api/jobs/active', async () => jobs.active());
  app.get<{ Querystring: { before?: string } }>('/api/jobs/history', async request => jobs.history(request.query.before));
  app.post('/api/jobs', async (request, reply) => {
    const query = parseQuery(request.body);
    const coverage = await (await availableData()).coverage(query);
    if (coverage.missing.length) return reply.code(409).send({ message: 'Download the selected trail sections before searching.', ...coverage });
    return reply.code(202).send(jobs.start(query));
  });
  app.get<{ Params: { id: string }; Querystring: { inputs?: string } }>('/api/jobs/:id', async request => jobs.get(request.params.id, request.query.inputs !== 'false'));
  const revision = (value?: string) => value === undefined ? undefined : Number(value);
  app.get<{ Params: { id: string }; Querystring: { offset?: string; sort?: ResultSort; order?: SortOrder; revision?: string } }>('/api/jobs/:id/results', async request =>
    jobs.page(request.params.id, Number(request.query.offset ?? 0), request.query.sort, request.query.order, revision(request.query.revision)));
  app.get<{ Params: { id: string }; Querystring: { revision?: string } }>('/api/jobs/:id/locations', async request => jobs.locations(request.params.id, revision(request.query.revision)));
  app.post<{ Params: { id: string } }>('/api/jobs/:id/cancel', async request => jobs.cancel(request.params.id));
  app.delete<{ Params: { id: string } }>('/api/jobs/:id', async (request, reply) => { await jobs.delete(request.params.id); return reply.code(204).send(); });
  app.get<{ Params: { id: string; routeId: string }; Querystring: { revision?: string } }>('/api/jobs/:id/routes/:routeId', async request => jobs.route(request.params.id, request.params.routeId, revision(request.query.revision)));
  app.get<{ Params: { id: string; routeId: string }; Querystring: { revision?: string } }>('/api/jobs/:id/routes/:routeId.gpx', async (request, reply) => {
    const route = jobs.route(request.params.id, request.params.routeId, revision(request.query.revision));
    return reply.type('application/gpx+xml').header('Content-Disposition', 'attachment; filename="alpine-loop.gpx"').send(gpx(route));
  });
  if (clientDirectory) await app.register(fastifyStatic, { root: clientDirectory });
  return app;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = resolve(process.env.ALPINE_DATA ?? '.local-data/mountains');
  const app = await createApp(directory, fileURLToPath(new URL('../client', import.meta.url)), resolve(process.env.ALPINE_JOBS ?? '.local-data/jobs'));
  const address = await app.listen({ host: process.env.HOST ?? '127.0.0.1', port: Number(process.env.PORT ?? 3000) });
  console.log(`Alpine Loop: ${address}`);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void app.close(); });
}
