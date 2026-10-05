import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { installCatalog } from './install-data.mjs';
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
  let directory = process.env.ALPINE_DATA ? resolve(process.env.ALPINE_DATA) : join(local, 'mountains');
  if (!process.env.ALPINE_DATA && release) {
    directory = await installCatalog(directory, release);
  } else if (!await exists(join(directory, 'catalog.json'))) {
    if (process.env.ALPINE_DATA) throw new Error(`Configured trail data is unavailable: ${directory}`);
    throw new Error('Prepared mountain sections have not been published for this development build yet. This checkout needs its local mountain catalog.');
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
