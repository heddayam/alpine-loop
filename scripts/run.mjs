import { resolve } from 'node:path';
import { installCatalog } from './install-data.mjs';
import release from './data-release.json' with { type: 'json' };
import { startServer } from '../dist/server/server.js';

// Both native and container launches share this bootstrap; workers import neither.
const controller = new AbortController();
const stop = () => controller.abort();
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, stop);
if (!process.env.ALPINE_DATA && release) {
  try { await installCatalog(resolve('.local-data/mountains'), release, { signal: controller.signal }); }
  catch (error) {
    if (!controller.signal.aborted) console.warn(`Trail catalog unavailable: ${error.message}. Saved jobs remain available. Restart to retry.`);
  }
}
for (const signal of ['SIGINT', 'SIGTERM']) process.removeListener(signal, stop);
if (!controller.signal.aborted) await startServer();
