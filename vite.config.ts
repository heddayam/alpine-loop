import { defineConfig } from 'vite';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { brotliCompress, constants, gzip } from 'node:zlib';

const brotli = promisify(brotliCompress), gz = promisify(gzip);

async function compressAssets(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) await compressAssets(file);
    else if (/\.(js|css|html|json|svg|txt)$/.test(entry.name)) {
      const bytes = await readFile(file);
      if (bytes.length < 1024) continue;
      const variants = await Promise.all([
        brotli(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 9 } }),
        gz(bytes, { level: 9 }),
      ]);
      for (const [index, encoded] of variants.entries())
        if (encoded.length < bytes.length) await writeFile(`${file}.${index ? 'gz' : 'br'}`, encoded);
    }
  }
}

export default defineConfig({
  build: { outDir: 'dist/client', emptyOutDir: true },
  plugins: [{
    name: 'precompress-assets',
    apply: 'build',
    async writeBundle(output) {
      if (output.dir) await compressAssets(output.dir);
    },
  }],
});
