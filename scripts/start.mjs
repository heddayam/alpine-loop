import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { installData } from './install-data.mjs';
import release from './data-release.json' with { type: 'json' };

const root = fileURLToPath(new URL('../', import.meta.url));
const local = join(root, '.local-data');
const exists = file => readFile(file).then(() => true, error => {
  if (error.code === 'ENOENT') return false;
  throw error;
});

async function npm(args) {
  if (!process.env.npm_execpath) throw new Error('Launch Alpine Loop with npm start.');
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [process.env.npm_execpath, ...args], { cwd: root, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`npm ${args[0]} did not finish successfully.`)));
  });
}

try {
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Alpine Loop needs Node.js 24 or newer.');
  let directory = process.env.ALPINE_DATA ? resolve(process.env.ALPINE_DATA) : join(local, 'network');
  if (!process.env.ALPINE_DATA && release) {
    let last = -1;
    directory = await installData(join(local, 'snapshots'), release, { onProgress(progress) {
      const percent = progress.totalBytes ? Math.floor(progress.completedBytes / progress.totalBytes * 100) : 100;
      if (Math.floor(percent / 10) !== last) {
        last = Math.floor(percent / 10);
        console.log(`Preparing trail data: ${percent}%`);
      }
    } });
  } else if (!await exists(join(directory, 'manifest.json'))) {
    if (process.env.ALPINE_DATA) throw new Error(`Configured trail data is unavailable: ${directory}`);
    throw new Error('Prepared trail data has not been published for this development build yet. This checkout needs its existing local snapshot.');
  }
  await mkdir(local, { recursive: true });
  const lockHash = createHash('sha256').update(await readFile(join(root, 'package-lock.json'))).digest('hex');
  const stamp = join(root, 'node_modules', '.alpine-lock');
  const installedHash = await readFile(stamp, 'utf8').catch(error => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  if (installedHash !== lockHash || !await exists(join(root, 'node_modules', 'vite', 'bin', 'vite.js'))) {
    await npm(['ci']);
    await writeFile(stamp, lockHash);
  }
  await npm(['run', 'build']);
  const server = spawn(process.execPath, ['dist/server/server.js'], {
    cwd: root, stdio: 'inherit', env: { ...process.env, ALPINE_DATA: directory },
  });
  server.once('error', error => { console.error(error.message); process.exitCode = 1; });
  server.once('exit', code => { process.exitCode = code ?? 1; });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { server.kill(signal); });
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
