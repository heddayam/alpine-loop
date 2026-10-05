import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import type { DataFile, SectionCatalog } from '../../src/data-format.js';
import { openSections } from '../../src/sections.js';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const remove of cleanup.splice(0).reverse()) await remove(); });
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const families = ['graph', 'starts', 'geometry'] as const;
const info = { id: 'fixture', name: 'Fixture mountains', bounds: [-122, 47, -121, 48] as [number, number, number, number],
  sourceDate: '2026-08-01', attribution: [], limitations: [], places: [], startCount: 1 };
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'alpine-sections-test-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const files = {} as Record<typeof families[number], DataFile>, bodies = new Map<string, Buffer>();
  for (const family of families) {
    const raw = Buffer.from(JSON.stringify({ family, content: 'independent prepared data' }));
    const body = gzipSync(raw), path = `sections/one/${family}.json.gz`;
    files[family] = { path, bytes: body.length, jsonBytes: raw.length, sha256: hash(body) };
    bodies.set(path, body);
  }
  const catalog: SectionCatalog = { version: 1, info, sections: [{ id: 'one', regionId: '11202', name: 'One section',
    bounds: info.bounds, boundary: { type: 'MultiPolygon', coordinates: [[[[-122, 47], [-121, 47], [-121, 48], [-122, 48], [-122, 47]]]] },
    sourceSegments: 3, startCount: 1, files }] };
  const save = () => writeFile(join(directory, 'catalog.json'), JSON.stringify(catalog));
  await save();
  const serve = async (respond: (path: string, response: ServerResponse) => void) => {
    const server = createServer((request, response) => respond(request.url!.slice(1), response));
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    cleanup.push(async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture server port');
    catalog.baseUrl = `http://127.0.0.1:${address.port}/`;
    await save();
  };
  return { directory, catalog, files, bodies, save, serve };
}

async function settled(sections: Awaited<ReturnType<typeof openSections>>) {
  const deadline = Date.now() + 3000;
  while (sections.downloads.latest()?.status === 'running' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  expect(sections.downloads.latest()?.status).not.toBe('running');
  return sections.downloads.latest()!;
}

describe('independent section installation', () => {
  it('streams progress, cancels a partial file, and resumes verified files without exposing a partial section', async () => {
    const { directory, bodies, files, serve } = await fixture();
    let interrupted = true;
    const calls: string[] = [];
    await serve((path, response) => {
      calls.push(path);
      response.writeHead(200);
      if (path === files.starts.path && interrupted) response.write(bodies.get(path)!.subarray(0, 3));
      else response.end(bodies.get(path));
    });
    const sections = await openSections(directory);
    cleanup.push(() => sections.downloads.close());
    expect((await sections.view()).sections[0]).toMatchObject({ installed: false, bytes: [...bodies.values()].reduce((sum, body) => sum + body.length, 0) });
    expect(sections.downloads.start(['one']).status).toBe('running');
    expect(() => sections.downloads.start(['one'])).toThrow(/already running/);
    const deadline = Date.now() + 3000;
    while (sections.downloads.latest()!.completedBytes < files.graph.bytes + 3 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    expect(sections.downloads.latest()!.completedBytes).toBe(files.graph.bytes + 3);
    expect(await sections.installed('one')).toBe(false);
    await expect(sections.read('one', 'graph')).rejects.toThrow(/not installed/);
    const before = performance.now();
    expect((await sections.downloads.stop())!.status).toBe('stopped');
    expect(performance.now() - before).toBeLessThan(1000);
    expect(await readFile(join(directory, '.downloads/one/graph.json.gz'))).toEqual(bodies.get(files.graph.path));
    expect(await readdir(join(directory, '.downloads/one'))).toEqual(['graph.json.gz']);
    interrupted = false;
    sections.downloads.start(['one']);
    expect(await settled(sections)).toMatchObject({ status: 'complete', completedBytes: [...bodies.values()].reduce((sum, body) => sum + body.length, 0) });
    expect(calls.filter(path => path === files.graph.path)).toHaveLength(1);
    expect(await sections.installed('one')).toBe(true);
    expect(await sections.read('one', 'graph')).toMatchObject({ family: 'graph' });
    sections.downloads.start(['one']);
    expect((await settled(sections)).status).toBe('complete');
    expect(calls).toHaveLength(4);
  });

  it('keeps checksum failures out of installed data, reuses good files, and rejects later corruption', async () => {
    const { directory, bodies, files, serve } = await fixture();
    let corrupt = true;
    const calls: string[] = [];
    await serve((path, response) => {
      calls.push(path);
      const body = Buffer.from(bodies.get(path)!);
      if (path === files.geometry.path && corrupt) body[0] = body[0]! ^ 1;
      response.end(body);
    });
    const sections = await openSections(directory);
    sections.downloads.start(['one']);
    expect(await settled(sections)).toMatchObject({ status: 'failed', reason: expect.stringContaining('checksum') });
    expect(await sections.installed('one')).toBe(false);
    corrupt = false;
    sections.downloads.start(['one']);
    expect((await settled(sections)).status).toBe('complete');
    expect(calls.filter(path => path === files.graph.path)).toHaveLength(1);
    expect(calls.filter(path => path === files.starts.path)).toHaveLength(1);
    await writeFile(join(directory, files.graph.path), Buffer.alloc(files.graph.bytes));
    await expect(sections.installed('one')).rejects.toThrow(/checksum/);
    await expect(sections.read('one', 'graph')).rejects.toThrow(/checksum/);
    sections.downloads.start(['one']);
    expect((await settled(sections)).status).toBe('complete');
    expect(calls.filter(path => path === files.starts.path)).toHaveLength(1);
    expect(calls.filter(path => path === files.geometry.path)).toHaveLength(2);
    expect(await sections.installed('one')).toBe(true);
  });

  it('rejects unsafe or duplicate catalog sections before any download', async () => {
    const { directory, catalog, save } = await fixture();
    catalog.sections[0]!.files.graph.path = '../escape.json.gz';
    await save();
    await expect(openSections(directory)).rejects.toThrow(/Invalid prepared section file/);
    catalog.sections[0]!.files.graph.path = 'sections/one/graph.json.gz';
    catalog.sections.push(catalog.sections[0]!);
    await save();
    await expect(openSections(directory)).rejects.toThrow(/duplicate/);
    catalog.sections.pop();
    catalog.baseUrl = 'file:///tmp/';
    await save();
    await expect(openSections(directory)).rejects.toThrow(/HTTP/);
    delete catalog.baseUrl;
    catalog.unavailable = [{ name: 'Unresolved range', bounds: info.bounds, boundary: catalog.sections[0]!.boundary,
      reason: 'No through-highway divides this oversized region.' }];
    catalog.sections = [];
    await save();
    const sections = await openSections(directory);
    expect((await sections.view()).unavailable).toEqual(catalog.unavailable);
    expect(() => sections.downloads.start(['absent'])).toThrowError(expect.objectContaining({ statusCode: 400 }));
    catalog.unavailable[0]!.reason = '';
    await save();
    await expect(openSections(directory)).rejects.toThrow(/Invalid unavailable/);
  });

  it('requires all files and exact bounded gzip output even when compressed checksums match', async () => {
    const { directory, catalog, files, bodies, save, serve } = await fixture();
    catalog.sections[0]!.files.graph.jsonBytes--;
    await serve((path, response) => response.end(bodies.get(path)));
    const sections = await openSections(directory);
    sections.downloads.start(['one']);
    expect(await settled(sections)).toMatchObject({ status: 'failed', reason: expect.stringContaining('decoded size mismatch') });
    expect(await sections.installed('one')).toBe(false);
    for (const family of families) {
      const path = join(directory, files[family].path);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, bodies.get(files[family].path)!);
    }
    await save();
    expect(await sections.installed('one')).toBe(true);
    await expect(sections.read('one', 'graph')).rejects.toThrow(/decoded size mismatch/);
    await rm(join(directory, files.geometry.path));
    expect(await sections.installed('one')).toBe(false);
    await expect(sections.read('one', 'starts')).rejects.toThrow(/not installed/);
  });
});
