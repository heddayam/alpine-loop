import { parentPort, workerData } from 'node:worker_threads';
import { readGraph } from './dataset.js';
import { search } from './engine/search.js';
import { createShortlist } from './shortlist.js';
import type { SearchQuery } from './model.js';

const { directory, query } = workerData as {
  directory: string; query: SearchQuery;
};
const graph = await readGraph(directory);
const shortlist = createShortlist(graph);
let lastProgress = 0;
for await (const event of search(graph, query)) {
  if (event.type === 'route' && !shortlist(event.route)) continue;
  if (event.type !== 'progress' || Date.now() - lastProgress >= 100) {
    parentPort!.postMessage(event);
    lastProgress = Date.now();
  }
}
