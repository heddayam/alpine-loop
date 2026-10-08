import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliCompressSync, brotliDecompressSync, gunzipSync, gzipSync } from 'node:zlib';
import { expect, it } from 'vitest';
import { createApp } from '../../src/server.js';

it('negotiates compressed assets with exact decoded content and keeps app metadata fresh', async () => {
  const root = await mkdtemp(join(tmpdir(), 'alpine-static-'));
  const client = join(root, 'client');
  await mkdir(join(client, 'assets'), { recursive: true });
  const script = Buffer.from('console.log("hiking");\n'.repeat(100));
  await writeFile(join(client, 'index.html'), '<!doctype html><title>Alpine Loop</title>');
  for (const [suffix, bytes] of [['', script], ['.br', brotliCompressSync(script)], ['.gz', gzipSync(script)]] as const)
    await writeFile(join(client, `assets/app-abc12345.js${suffix}`), bytes);
  const app = await createApp(join(root, 'missing-data'), client, join(root, 'jobs'));
  try {
    for (const [encoding, decode] of [['br', brotliDecompressSync], ['gzip', gunzipSync]] as const) {
      const response = await app.inject({ url: '/assets/app-abc12345.js', headers: { 'accept-encoding': encoding } });
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-encoding']).toBe(encoding);
      expect(String(response.headers.vary).toLowerCase()).toContain('accept-encoding');
      expect(response.headers['cache-control']).toBe('public, max-age=31536000, immutable');
      expect(decode(response.rawPayload)).toEqual(script);
    }
    const plain = await app.inject({ url: '/assets/app-abc12345.js', headers: { 'accept-encoding': 'identity' } });
    expect(plain.headers['content-encoding']).toBeUndefined();
    expect(plain.rawPayload).toEqual(script);
    expect(String(plain.headers.vary).toLowerCase()).toContain('accept-encoding');
    const index = await app.inject({ url: '/' });
    expect(index.statusCode).toBe(200);
    expect(index.headers['cache-control']).toBe('public, max-age=0');
    const active = await app.inject({ url: '/api/jobs/active' });
    expect(active.json()).toEqual([]);
    expect(active.headers['cache-control']).toBe('no-store');
    expect((await app.inject({ url: '/assets/missing.js' })).statusCode).toBe(404);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
