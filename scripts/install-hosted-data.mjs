import { resolve } from 'node:path';
import { openSections } from '../dist/server/sections.js';

// Hosted visitors search immediately; only the operator installs prepared data.
export async function installHostedData(directory, signal) {
  const sections = await openSections(directory);
  const stop = () => { void sections.downloads.stop(); };
  signal.addEventListener('abort', stop, { once: true });
  try {
    if (signal.aborted) return;
    const missing = (await sections.view()).sections.filter(section => !section.installed).map(section => section.id);
    if (!missing.length) return;
    console.log(`Installing ${missing.length} prepared trail sections…`);
    sections.downloads.start(missing);
    while (sections.downloads.latest()?.status === 'running') await new Promise(done => setTimeout(done, 200));
    const result = sections.downloads.latest();
    if (!signal.aborted && result?.status !== 'complete') throw new Error(result?.reason ?? 'Prepared trail installation did not complete.');
  } finally {
    signal.removeEventListener('abort', stop);
    await sections.downloads.close();
  }
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  await installHostedData(resolve(process.env.ALPINE_DATA ?? '.local-data/mountains'), new AbortController().signal);
}
