import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureBuild, ensureDependencies } from '../../scripts/start.mjs';
import { stampInstall } from '../../scripts/stamp-install.mjs';

test('launch reuses manual installs and repairs changed locks or missing dependencies', async () => {
  const root = await mkdtemp(join(tmpdir(), 'alpine-install-cache-'));
  try {
    await mkdir(join(root, 'node_modules/vite/bin'), { recursive: true });
    await writeFile(join(root, 'package-lock.json'), 'original lock');
    await writeFile(join(root, 'node_modules/vite/bin/vite.js'), 'installed vite');
    await stampInstall(root);
    let installs = 0;
    const install = async () => {
      installs++;
      await writeFile(join(root, 'node_modules/vite/bin/vite.js'), 'installed vite');
    };
    await ensureDependencies(root, install);
    await ensureDependencies(root, install);
    assert.equal(installs, 0);
    await writeFile(join(root, 'package-lock.json'), 'updated lock');
    await ensureDependencies(root, install);
    await ensureDependencies(root, install);
    assert.equal(installs, 1);
    await rm(join(root, 'node_modules/vite/bin/vite.js'));
    await ensureDependencies(root, install);
    await ensureDependencies(root, install);
    assert.equal(installs, 2);
    await rm(join(root, 'node_modules/.alpine-lock'));
    await ensureDependencies(root, install);
    assert.equal(installs, 3);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('launch reuses complete outputs and rebuilds after source, configuration or output changes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'alpine-build-cache-'));
  try {
    for (const dir of ['src', 'scripts', 'dist/client', 'dist/server']) await mkdir(join(root, dir), { recursive: true });
    for (const file of ['src/app.ts', 'index.html', 'package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.server.json', 'vite.config.ts', 'scripts/start.mjs', 'scripts/stamp-install.mjs']) await writeFile(join(root, file), file);
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
