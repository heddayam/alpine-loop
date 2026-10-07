import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { installCatalog } from './install-data.mjs';
import release from './data-release.json' with { type: 'json' };

const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
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

async function files(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(entry => entry.isDirectory()
    ? files(join(directory, entry.name)) : [join(directory, entry.name)]));
  return nested.flat().sort();
}

/** Build outputs are disposable; invalidate on source/config/lock changes or a missing output. */
export async function ensureBuild(directory, build) {
  const hash = createHash('sha256');
  const inputs = [...await files(join(directory, 'src')), ...['index.html', 'package.json', 'package-lock.json',
    'tsconfig.json', 'tsconfig.server.json', 'vite.config.ts', 'scripts/start.mjs'].map(file => join(directory, file))].sort();
  for (const file of inputs) hash.update(file.slice(directory.length)).update('\0').update(await readFile(file)).update('\0');
  const fingerprint = hash.digest('hex'), stamp = join(directory, '.local-data', 'build.json');
  const cached = await readFile(stamp, 'utf8').then(JSON.parse).catch(error => {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  });
  if (cached?.fingerprint === fingerprint && cached.outputs?.includes('dist/server/server.js')
    && cached.outputs.includes('dist/client/index.html') && (await Promise.all(cached.outputs.map(file => exists(join(directory, file))))).every(Boolean)) return;
  await build();
  const outputs = (await files(join(directory, 'dist'))).map(file => file.slice(directory.length + 1));
  if (!outputs.includes('dist/server/server.js') || !outputs.includes('dist/client/index.html')) throw new Error('Build outputs are incomplete.');
  await mkdir(join(directory, '.local-data'), { recursive: true });
  await writeFile(stamp, JSON.stringify({ fingerprint, outputs }));
}

export async function start() {
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
    await ensureBuild(root, () => npm(['run', 'build']));
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
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await start();
