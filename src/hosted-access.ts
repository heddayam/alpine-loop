import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { RequestError } from './jobs.js';

export type HostingOptions = { enabled?: boolean; secret?: string };

/** Anonymous ownership survives browser reconnects and server restarts. */
export function createHostedAccess({ enabled = process.env.ALPINE_HOSTED === '1', secret = process.env.ALPINE_SESSION_SECRET }: HostingOptions = {}) {
  if (!enabled) return undefined;
  if (!secret || Buffer.byteLength(secret) < 32) throw new Error('Hosted mode requires a persistent ALPINE_SESSION_SECRET of at least 32 bytes.');
  const key = secret;
  const sessions = new WeakMap<FastifyRequest, string>();
  const cookieName = '__Host-alpine_session';
  const sign = (id: string) => createHmac('sha256', key).update(id).digest('base64url');
  return {
    identify(request: FastifyRequest, reply: FastifyReply) {
      const cookie = request.headers.cookie?.split(';').map(value => value.trim()).find(value => value.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
      const [id = '', signature = ''] = cookie?.split('.') ?? [];
      const expected = Buffer.from(sign(id));
      const supplied = Buffer.from(signature);
      const valid = /^[a-f0-9-]{36}$/.test(id) && expected.length === supplied.length && timingSafeEqual(expected, supplied);
      const visitor = valid ? id : randomUUID();
      sessions.set(request, visitor);
      if (!valid) reply.header('Set-Cookie', `${cookieName}=${visitor}.${sign(visitor)}; Path=/; Max-Age=31536000; Secure; HttpOnly; SameSite=Lax`);
    },
    visitor(request: FastifyRequest) { return sessions.get(request)!; },
    mutation(request: FastifyRequest) {
      if (!['POST', 'DELETE', 'PUT', 'PATCH'].includes(request.method)) return;
      let valid = false;
      try {
        const origin = new URL(request.headers.origin ?? '');
        valid = origin.protocol === 'https:' && origin.host === request.headers.host && origin.origin === request.headers.origin
          && request.headers['sec-fetch-site'] !== 'cross-site';
      } catch { /* Missing and malformed origins are rejected. */ }
      if (!valid) throw new RequestError('Open this site directly over HTTPS before changing a search.', 403);
    },
  };
}
