import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gpx, readDataset } from './dataset.js';
import { createSearches, parseQuery, RequestError } from './searches.js';

export async function createApp(directory: string, clientDirectory?: string) {
  const dataset = await readDataset(directory);
  const searches = createSearches(directory, dataset);
  const app = Fastify({ bodyLimit: 4096 });
  app.setErrorHandler((error, _request, reply) => {
    const status = error instanceof Error && 'statusCode' in error && typeof error.statusCode === 'number' ? error.statusCode : 500;
    if (status === 500) app.log.error(error);
    reply.code(status).send({ message: status === 500 || !(error instanceof Error) ? 'The app could not complete this request.' : error.message });
  });
  app.addHook('onClose', async () => { await Promise.all([searches.close(), dataset.downloads.close()]); });
  app.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const origin = request.headers.origin;
    if (request.method === 'POST' && origin && new URL(origin).host !== request.headers.host) {
      throw new RequestError('Open this app directly before starting or stopping a search.', 403);
    }
  });
  app.get('/api/catalog', async () => dataset.view());
  app.post('/api/coverage', async request => dataset.coverage(parseQuery(request.body)));
  app.get('/api/downloads', async () => dataset.downloads.latest());
  app.post('/api/downloads', async (request, reply) => {
    const ids = (request.body as { sections?: unknown })?.sections;
    if (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== 'string')) {
      throw new RequestError('Choose trail sections to download.', 400);
    }
    return reply.code(202).send(dataset.downloads.start(ids));
  });
  app.post('/api/downloads/stop', async () => dataset.downloads.stop());
  app.get('/api/search', async () => searches.latest());
  app.post('/api/search', async (request, reply) => {
    const query = parseQuery(request.body), coverage = await dataset.coverage(query);
    if (coverage.missing.length) return reply.code(409).send({ message: 'Download the selected trail sections before searching.', ...coverage });
    return reply.code(202).send(searches.start(query));
  });
  app.get<{ Params: { id: string }; Querystring: { offset?: string; group?: string } }>('/api/search/:id', async request => searches.get(request.params.id, Number(request.query.offset ?? 0), request.query.group));
  app.post<{ Params: { id: string }; Querystring: { offset?: string; group?: string } }>('/api/search/:id/stop', async request => searches.stop(request.params.id, Number(request.query.offset ?? 0), request.query.group));
  app.get<{ Params: { id: string; routeId: string } }>('/api/search/:id/routes/:routeId', async request => searches.route(request.params.id, request.params.routeId));
  app.get<{ Params: { id: string; routeId: string } }>('/api/search/:id/routes/:routeId.gpx', async (request, reply) => {
    const route = await searches.route(request.params.id, request.params.routeId);
    return reply.type('application/gpx+xml').header('Content-Disposition', 'attachment; filename="alpine-loop.gpx"').send(gpx(route));
  });
  if (clientDirectory) await app.register(fastifyStatic, { root: clientDirectory });
  return app;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = resolve(process.env.ALPINE_DATA ?? '.local-data/mountains');
  const app = await createApp(directory, fileURLToPath(new URL('../client', import.meta.url)));
  const address = await app.listen({ host: process.env.HOST ?? '127.0.0.1', port: Number(process.env.PORT ?? 3000) });
  console.log(`Alpine Loop: ${address}`);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void app.close(); });
}
