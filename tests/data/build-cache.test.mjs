import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureBuild } from '../../scripts/start.mjs';

test('launch reuses complete outputs and rebuilds after source, configuration or output changes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'alpine-build-cache-'));
  try {
    for (const dir of ['src', 'scripts', 'dist/client', 'dist/server']) await mkdir(join(root, dir), { recursive: true });
    for (const file of ['src/app.ts', 'index.html', 'package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.server.json', 'vite.config.ts', 'scripts/start.mjs']) await writeFile(join(root, file), file);
    let builds = 0;
    const build = async () => {
      builds++;
      await writeFile(join(root, 'dist/server/server.js'), 'compiled server');
      await writeFile(join(root, 'dist/client/index.html'), 'compiled client');
    };
    await ensureBuild(root, build);
    await ensureBuild(root, build);
    assert.equal(builds, 1);
    await writeFile(join(root, 'src/app.ts'), 'changed source');
    await ensureBuild(root, build);
    await writeFile(join(root, 'package-lock.json'), 'changed dependency');
    await ensureBuild(root, build);
    await rm(join(root, 'dist/server/server.js'));
    await ensureBuild(root, build);
    assert.equal(builds, 4);
    await ensureBuild(root, build);
    assert.equal(builds, 4);
  } finally { await rm(root, { recursive: true, force: true }); }
});
