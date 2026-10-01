import { parentPort, workerData } from 'node:worker_threads';
import { readDataset } from './dataset.js';
import { search } from './engine/search.js';
import { createRouteGroups } from './diversity.js';
import type { SearchQuery } from './model.js';

const { directory, query, snapshotId } = workerData as {
  directory: string; query: SearchQuery; snapshotId: string;
};
const dataset = await readDataset(directory);
if (dataset.info.id !== snapshotId) throw new Error('Trail data changed before this search could start. Start a new search.');
const selection = await dataset.select(query);
const { graph } = selection;
parentPort!.postMessage({ type: 'coverage', note: selection.coverageNote });
const group = createRouteGroups(graph);
let lastProgress = 0;
for await (const event of search(graph, query)) {
  if (event.type === 'route') {
    if (selection.isHike(event.route)) {
      const choice = group(event.route);
      if (choice) parentPort!.postMessage({ type: 'route', route: selection.describe(event.route), ...choice });
    }
    continue;
  }
  if (event.type !== 'progress' || Date.now() - lastProgress >= 100) {
    parentPort!.postMessage(event);
    lastProgress = Date.now();
  }
}
