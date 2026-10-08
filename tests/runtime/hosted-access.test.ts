import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNetworkFixture, query } from './network-fixture.js';
import type { JobSnapshot } from '../../src/model.js';

type App = Awaited<ReturnType<typeof import('../../src/server.js').createApp>>;
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action(); });
const secret = 'offline-fixture-persistent-secret-1234567890';
const origin = 'https://alpineloop.test';
const headers = (cookie?: string) => ({ host: 'alpineloop.test', origin, ...(cookie ? { cookie } : {}) });
async function fixture(dense = false) {
  const data = await createNetworkFixture({ dense });
  const jobs = await mkdtemp(join(tmpdir(), 'alpine-hosted-test-'));
  cleanup.push(() => rm(data.directory, { recursive: true, force: true }), () => rm(jobs, { recursive: true, force: true }));
  const { createApp } = await import('../../dist/server/server.js');
  const open = async () => {
    const app = await createApp(data.directory, undefined, jobs, { enabled: true, secret });
    cleanup.push(() => app.close());
    return app;
  };
  return { ...data, jobs, open, app: await open() };
}
async function visitor(app: App) {
  const response = await app.inject({ url: '/api/jobs', headers: headers() });
  return String(response.headers['set-cookie']).split(';')[0]!;
}
const submit = (app: App, cookie: string, dense = false) => app.inject({ method: 'POST', url: '/api/jobs', headers: headers(cookie),
  payload: dense ? { ...query, distance: [600, 2600], gain: [0, 1000] } : query });
async function finished(app: App, cookie: string, id: string) {
  const deadline = Date.now() + 5000;
  for (;;) {
    const response = await app.inject({ url: `/api/jobs/${id}`, headers: headers(cookie) });
    const job = response.json() as JobSnapshot;
    if (!['running', 'queued'].includes(job.status)) return job;
    if (Date.now() > deadline) throw new Error('Offline job did not finish');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

describe('hosted anonymous search ownership', () => {
  it('requires a persistent secret, rejects mutation origins, and keeps health checks session-free', async () => {
    const { createApp } = await import('../../dist/server/server.js');
    await expect(createApp('/unused', undefined, '/unused', { enabled: true, secret: 'short' })).rejects.toThrow('ALPINE_SESSION_SECRET');
    const { app } = await fixture();
    const health = await app.inject('/health');
    expect(health.json()).toEqual({ status: 'ok' });
    expect(health.headers['set-cookie']).toBeUndefined();
    expect(health.headers['cache-control']).toBe('no-store');
    expect((await app.inject('/api/catalog')).json().hosted).toBe(true);
    expect((await app.inject('/')).headers['set-cookie']).toBeDefined();
    const cookie = await visitor(app);
    for (const invalid of [undefined, 'http://alpineloop.test', 'https://other.test', `${origin}/path`]) {
      expect((await app.inject({ method: 'POST', url: '/api/jobs', headers: { host: 'alpineloop.test', cookie,
        ...(invalid ? { origin: invalid } : {}) }, payload: query })).statusCode).toBe(403);
    }
    expect((await app.inject({ method: 'POST', url: '/api/jobs', headers: { ...headers(cookie), 'sec-fetch-site': 'cross-site' }, payload: query })).statusCode).toBe(403);
    expect((await app.inject({ url: '/api/jobs', headers: headers(cookie) })).json()).toEqual([]);
    for (const url of ['/api/downloads', '/api/downloads/stop']) {
      expect((await app.inject({ method: 'POST', url, headers: headers(cookie), payload: { sections: query.sections } })).statusCode).toBe(503);
    }
  });

  it('isolates unfinished jobs, filters history and active jobs, and enforces per-browser admission', async () => {
    const source = await fixture(true);
    let app = source.app;
    const alice = await visitor(app), bob = await visitor(app);
    const firstResponse = await submit(app, alice, true), first = firstResponse.json();
    expect(firstResponse.statusCode).toBe(202);
    expect(first.canManage).toBe(true);
    const second = (await submit(app, alice, true)).json();
    expect(second.status).toBe('queued');
    const rejected = await submit(app, alice, true);
    expect(rejected.statusCode).toBe(429);
    expect(rejected.headers['retry-after']).toBe('60');
    expect(rejected.json().message).toMatch(/two searches/);
    for (const suffix of ['', '/results', '/locations', '/paths?west=-122&south=47&east=-121&north=48', '/routes/absent', '/routes/absent.gpx']) {
      expect((await app.inject({ url: `/api/jobs/${first.id}${suffix}`, headers: headers(bob) })).statusCode).toBe(404);
    }
    for (const url of ['/api/jobs', '/api/jobs/active', '/api/jobs/history']) {
      const response = (await app.inject({ url, headers: headers(bob) })).json();
      expect(url.endsWith('history') ? response.jobs : response).toEqual([]);
    }
    expect((await app.inject({ url: `/api/jobs/history?before=${first.id}`, headers: headers(bob) })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `/api/jobs/${first.id}/cancel`, headers: headers(bob) })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: `/api/jobs/${first.id}`, headers: headers(bob) })).statusCode).toBe(404);
    const history = (await app.inject({ url: '/api/jobs', headers: headers(alice) })).json();
    expect(history.map((job: JobSnapshot) => job.id)).toEqual([second.id, first.id]);
    expect(JSON.stringify(history)).not.toContain(alice.split('=')[1]!.split('.')[0]);
    await app.close();
    app = await source.open();
    expect((await app.inject({ url: `/api/jobs/${first.id}`, headers: headers(alice) })).json()).toMatchObject({ status: 'interrupted', canManage: true });
    expect((await app.inject({ url: `/api/jobs/${first.id}`, headers: headers(bob) })).statusCode).toBe(404);
    expect((await app.inject({ url: `/api/jobs/${second.id}`, headers: headers(alice) })).json().canManage).toBe(true);
  });

  it('shares completed immutable results without granting management and retains ownership across restart', async () => {
    const source = await fixture();
    let app = source.app;
    const aliceResponse = await app.inject({ url: '/api/jobs', headers: headers() });
    expect(aliceResponse.headers['set-cookie']).toMatch(/Secure; HttpOnly; SameSite=Lax/);
    const alice = String(aliceResponse.headers['set-cookie']).split(';')[0]!, bob = await visitor(app);
    const first = (await submit(app, alice)).json();
    expect((await finished(app, alice, first.id)).status).toBe('completed');
    const shared = await app.inject({ url: `/api/jobs/${first.id}`, headers: headers(bob) });
    expect(shared.json()).toMatchObject({ id: first.id, status: 'completed', canManage: false });
    const page = (await app.inject({ url: `/api/jobs/${first.id}/results`, headers: headers(bob) })).json();
    expect(page.routes.length).toBeGreaterThan(0);
    const routeUrl = `/api/jobs/${first.id}/routes/${page.routes[0].id}`;
    expect((await app.inject({ url: routeUrl, headers: headers(bob) })).statusCode).toBe(200);
    expect((await app.inject({ url: `${routeUrl}.gpx`, headers: headers(bob) })).statusCode).toBe(200);
    for (const [method, url] of [['POST', `/api/jobs/${first.id}/cancel`], ['DELETE', `/api/jobs/${first.id}`]] as const) {
      expect((await app.inject({ method, url, headers: headers(bob) })).statusCode).toBe(403);
    }
    const tampered = alice.slice(0, -1) + (alice.endsWith('a') ? 'b' : 'a');
    const tamperedResponse = await app.inject({ url: '/api/jobs', headers: headers(tampered) });
    expect(tamperedResponse.json()).toEqual([]);
    expect(tamperedResponse.headers['set-cookie']).toBeDefined();
    await app.close();
    await rm(source.directory, { recursive: true, force: true });
    app = await source.open();
    expect((await app.inject({ url: `/api/jobs/${first.id}`, headers: headers(alice) })).json().canManage).toBe(true);
    expect((await app.inject({ url: '/api/jobs', headers: headers(alice) })).json()).toHaveLength(1);
    expect((await app.inject({ url: '/api/jobs', headers: headers(bob) })).json()).toEqual([]);
    expect((await app.inject({ url: routeUrl, headers: headers(bob) })).statusCode).toBe(200);
    expect((await app.inject({ method: 'DELETE', url: `/api/jobs/${first.id}`, headers: headers(alice) })).statusCode).toBe(204);
  });

  it('caps the durable shared queue without creating rejected jobs', async () => {
    const { app } = await fixture(true);
    const visitors = await Promise.all(Array.from({ length: 11 }, () => visitor(app)));
    for (const cookie of visitors.slice(0, 10)) {
      expect((await submit(app, cookie, true)).statusCode).toBe(202);
      expect((await submit(app, cookie, true)).statusCode).toBe(202);
    }
    const rejected = await submit(app, visitors[10]!, true);
    expect(rejected.statusCode).toBe(429);
    expect(rejected.json().message).toMatch(/queue is full/);
    expect((await app.inject({ url: '/api/jobs', headers: headers(visitors[10]) })).json()).toEqual([]);
  });
});
