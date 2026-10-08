import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function dependencyFingerprint(directory) {
  return createHash('sha256').update(await readFile(join(directory, 'package-lock.json'))).digest('hex');
}

export async function stampInstall(directory) {
  await writeFile(join(directory, 'node_modules', '.alpine-lock'), await dependencyFingerprint(directory));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await stampInstall(fileURLToPath(new URL('../', import.meta.url)));
}
