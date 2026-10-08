import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { composeCatalog } from './compose-catalog.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const encoded = value => `${JSON.stringify(value, null, 2)}\n`;
const run = promisify(execFile);

/** Verify a complete local catalog, then package immutable, flat GitHub release assets. */
export async function packageData(input, destination, { repository, tag }) {
  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repository)
    || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(tag)) throw new Error('Choose a GitHub owner/repository and a simple immutable release tag');
  const output = resolve(destination), prepared = join(output, '.prepared');
  const baseUrl = `https://github.com/${repository}/releases/download/${tag}/`;
  await mkdir(output); // Never overwrite or remove a pre-existing destination.
  try {
    const verification = await composeCatalog([input], prepared);
    const evidence = JSON.parse(await readFile(join(prepared, 'provenance.json'), 'utf8'));
    const source = evidence.sources[0];
    const catalog = JSON.parse(await readFile(join(prepared, 'sources', source.catalogSha256, 'catalog.json'), 'utf8'));
    delete catalog.baseUrl;
    for (const section of catalog.sections) {
      for (const [family, facts] of Object.entries(section.files)) {
        // Metadata-only releases reuse already published, checksum-pinned files.
        if (facts.url) continue;
        const name = `${section.id}.${family}.${family === 'geometry' ? 'jsonl' : 'json'}.gz`;
        await rename(join(prepared, facts.path), join(output, name));
        facts.url = `${baseUrl}${name}`;
      }
    }
    const body = encoded(catalog);
    if (Buffer.byteLength(body) > 16 * 1024 * 1024) throw new Error('Published catalog exceeds 16 MB');
    await writeFile(join(output, 'catalog.json'), body, { flag: 'wx' });
    const release = { catalogUrl: `${baseUrl}catalog.json`, catalogSha256: hash(body) };
    await writeFile(join(output, 'data-release.json'), encoded(release), { flag: 'wx' });
    // Evidence is a separate optional download, never part of normal startup.
    await rm(join(prepared, 'sections'), { recursive: true });
    await run('tar', ['-czf', join(output, 'preparation-evidence.tar.gz'), '-C', prepared, '.']);
    await rm(prepared, { recursive: true });
    const notes = [`# ${catalog.info.name}`, '',
      `Prepared source date: ${catalog.info.sourceDate}. Catalog: ${catalog.info.id}.`, '',
      `${catalog.sections.length} sections; ${verification.compressedBytes} compressed trail bytes.`, '',
      'Use the matching Alpine Loop checkout. Startup downloads catalog.json; chosen sections download on demand.',
      'Section IDs, local paths, compressed bytes and SHA-256 hashes are unchanged from the verified input.',
      'preparation-evidence.tar.gz retains source catalogs, provenance and audits. No raw inputs or saved jobs are included.', '',
      '## Attribution', '', ...catalog.info.attribution.map(item => `- ${item.name}: ${item.license}. ${item.url}`), '',
      '## Limitations', '', ...catalog.info.limitations.map(item => `- ${item}`), ''];
    await writeFile(join(output, 'DATA.md'), notes.join('\n'), { flag: 'wx' });
    const sums = [];
    for (const name of (await readdir(output)).sort()) {
      const sha = createHash('sha256');
      for await (const chunk of createReadStream(join(output, name))) sha.update(chunk);
      sums.push(`${sha.digest('hex')}  ${name}`);
    }
    await writeFile(join(output, 'SHA256SUMS'), `${sums.join('\n')}\n`, { flag: 'wx' });
    return { output, tag, sections: catalog.sections.length, compressedBytes: verification.compressedBytes, release };
  } catch (error) {
    await rm(output, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [input, output, repository, tag, extra] = process.argv.slice(2);
    if (!input || !output || !repository || !tag || extra) throw new Error('Usage: node scripts/package-data.mjs INPUT NEW_OUTPUT OWNER/REPO TAG');
    console.log(encoded(await packageData(input, output, { repository, tag })));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
