import { parentPort, workerData } from 'node:worker_threads';
import { readGraph } from './dataset.js';
import { search } from './engine/search.js';
import type { SearchQuery } from './model.js';

const { directory, query, maxResults, maxExpansions } = workerData as {
  directory: string; query: SearchQuery; maxResults: number; maxExpansions: number;
};
const graph = await readGraph(directory);
let lastProgress = 0;
for await (const event of search(graph, query, { maxResults, maxExpansions })) {
  if (event.type !== 'progress' || Date.now() - lastProgress >= 100) {
    parentPort!.postMessage(event);
    lastProgress = Date.now();
  }
}
