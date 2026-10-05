import { parentPort, workerData } from 'node:worker_threads';
import { readDataset } from './dataset.js';
import { search } from './engine/search.js';
import { createRouteGroups } from './diversity.js';
import type { SearchProgress, SearchQuery } from './model.js';

const { directory, query, snapshotId } = workerData as { directory: string; query: SearchQuery; snapshotId: string };
const dataset = await readDataset(directory);
if (dataset.info.id !== snapshotId) throw new Error('Trail data changed before this search could start. Start a new search.');
const coverage = await dataset.coverage(query);
if (coverage.missing.length) throw new Error('Download the selected trail sections before searching.');
const selections = await dataset.starts(query);
const totalStarts = selections.reduce((sum, { eligible }) => sum + eligible.length, 0);
const started = performance.now();
let completedStarts = 0, expansions = 0, lastProgress = 0;
let progress: SearchProgress = { totalStarts, attemptedStarts: 0, completedStarts: 0, expansions: 0, elapsedMs: 0 };
parentPort!.postMessage({ type: 'progress', progress });
for (const chosen of selections) {
  const selection = await dataset.select(query, chosen);
  const group = createRouteGroups(selection.graph);
  for await (const event of search(selection.graph, query)) {
    if (event.type === 'route') {
      event.route.id = `${chosen.section.id}:${event.route.id}`;
      if (selection.isHike(event.route)) {
        const choice = group(event.route);
        if (choice) parentPort!.postMessage({ type: 'route', route: selection.describe(event.route), ...choice });
      }
      continue;
    }
    progress = { totalStarts, attemptedStarts: completedStarts + event.progress.attemptedStarts,
      completedStarts: completedStarts + event.progress.completedStarts, expansions: expansions + event.progress.expansions,
      elapsedMs: performance.now() - started };
    if (event.type === 'done' && event.status !== 'complete') {
      parentPort!.postMessage({ ...event, progress });
      process.exit(0);
    }
    if (event.type === 'done' || Date.now() - lastProgress >= 100) {
      parentPort!.postMessage({ type: 'progress', progress }); lastProgress = Date.now();
    }
  }
  completedStarts = progress.completedStarts; expansions = progress.expansions;
}
parentPort!.postMessage({ type: 'done', status: 'complete', progress: { ...progress, elapsedMs: performance.now() - started } });
