import { createHash } from 'node:crypto';
import { parentPort, workerData } from 'node:worker_threads';
import { readDataset } from './dataset.js';
import { solveSection } from './diversity.js';
import { createRouteStore } from './route-store.js';
import type { JobInputs, JobProgress, Position, SearchQuery } from './model.js';

const { directory, query, resultPath } = workerData as {
  directory: string; query: SearchQuery; resultPath: string };
const started = performance.now();
const dataset = await readDataset(directory);
const selected = dataset.selectedSections(query);
const inputs: JobInputs = { version: dataset.catalog.info.id,
  sections: selected.map(({ id, name, bounds, boundary, files }) => ({ id, name, bounds, boundary, files })) };
let progress: JobProgress = { stage: 'preparing', completedRegions: [], totalRegions: selected.length,
  elapsedMs: 0, expansions: 0, totalStarts: 0, completedStarts: 0 };
const send = (includeInputs = false) => parentPort!.postMessage({ type: 'progress', ...(includeInputs ? { inputs } : {}),
  progress: { ...progress, elapsedMs: performance.now() - started } });
send(true);
await dataset.verifyInputs(inputs);
const selections = await dataset.starts(query);
progress.totalStarts = selections.reduce((sum, { eligible }) => sum + eligible.length, 0);
const store = createRouteStore(resultPath, true);
const hash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 32);
let verification: Promise<void> | undefined;
const verify = () => verification ??= dataset.verifyInputs(inputs).finally(() => { verification = undefined; });
let lastProgress = 0, lastVerified = Date.now();
const samePosition = (a: Position, b: Position) => a[0] === b[0] && a[1] === b[1];
async function saveRoutes(chosen: (typeof selections)[number]) {
  const selection = await dataset.select(query, chosen);
  const { graph } = selection;
  const used = new Map<number, [Position, Position]>();
  const previousExpansions = progress.expansions;
  progress.stage = 'searching'; send();
  store.begin();
  await solveSection(graph, query, async measured => {
    if (Date.now() - lastVerified >= 1000) { await verify(); lastVerified = Date.now(); }
    progress.expansions = previousExpansions + measured.expansions;
    progress.totalSearchPoints = measured.totalSearchPoints;
    progress.completedSearchPoints = measured.completedSearchPoints;
    if (measured.totalSearchPoints !== undefined && measured.completedSearchPoints === measured.totalSearchPoints) progress.stage = 'saving';
    if (Date.now() - lastProgress >= 100) { send(); lastProgress = Date.now(); }
  }, store.candidatePool, saved => {
    const start = graph.starts[saved.route.start]!.node;
    let previous = start;
    for (const edgeId of saved.route.edges) {
      const edge = graph.edges[edgeId]!;
      if (edge.from !== previous) throw new Error(`Route drawing has a broken connection in ${chosen.section.name}.`);
      const endpoints: [Position, Position] = edge.reverse
        ? [graph.nodes[edge.to]!, graph.nodes[edge.from]!]
        : [graph.nodes[edge.from]!, graph.nodes[edge.to]!];
      const expected = used.get(edge.trail);
      if (expected && (!samePosition(expected[0], endpoints[0]) || !samePosition(expected[1], endpoints[1]))) {
        throw new Error(`Route drawing has inconsistent endpoints in ${chosen.section.name}.`);
      }
      if (!expected) used.set(edge.trail, endpoints);
      previous = edge.to;
    }
    if (!saved.route.edges.length || previous !== start) throw new Error(`Route drawing does not close in ${chosen.section.name}.`);
    const route = selection.describe(saved.route);
    route.summary.id = hash(`${chosen.section.id}/${saved.route.id}`);
    store.add({ ...saved, route, groupId: hash(`${chosen.section.id}/${saved.groupId}`), variantId: hash(`${chosen.section.id}/${saved.variantId}`),
      reverseId: saved.reverseId ? hash(`${chosen.section.id}/${saved.reverseId}`) : undefined,
      oppositeId: saved.oppositeId ? hash(`${chosen.section.id}/${saved.oppositeId}`) : undefined });
  });
  return used;
}
async function completeRegion(chosen: (typeof selections)[number]) {
  await verify();
  delete progress.totalSearchPoints; delete progress.completedSearchPoints;
  progress.stage = 'preparing'; progress.currentRegion = { id: chosen.section.id, name: chosen.section.name }; send();
  // The graph and each circuit's witnesses can be collected before parsing
  // geometry. Closed graph walks plus matching trail endpoints prove drawing continuity.
  const used = await saveRoutes(chosen);
  await verify();
  progress.stage = 'saving'; send();
  if (used.size) {
    const geometry = await dataset.readGeometry(chosen.section.id);
    for (const [id, endpoints] of used) {
      const shape = geometry[id];
      if (!shape?.coordinates.length) throw new Error(`Route drawing is missing in ${chosen.section.name}.`);
      if (!samePosition(shape.coordinates[0]!, endpoints[0]) || !samePosition(shape.coordinates.at(-1)!, endpoints[1])) {
        throw new Error(`Route drawing has mismatched endpoints in ${chosen.section.name}.`);
      }
      store.saveGeometry(chosen.section.id, id, shape.coordinates);
    }
  }
  await verify();
  store.commit();
  progress.completedRegions.push(chosen.section.id);
  progress.completedStarts += chosen.eligible.length;
  send();
}
try {
  for (const chosen of selections) await completeRegion(chosen);
  progress.stage = 'saving'; delete progress.currentRegion; send();
  await verify();
  if (verification) await verification;
  store.close();
  await dataset.downloads.close();
  parentPort!.postMessage({ type: 'done', progress: { ...progress, elapsedMs: performance.now() - started } });
  parentPort!.close();
} finally {
  store.close();
}
