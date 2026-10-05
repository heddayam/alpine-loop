import { createHash } from 'node:crypto';
import { parentPort, workerData } from 'node:worker_threads';
import { readDataset } from './dataset.js';
import { solveSection } from './diversity.js';
import { createRouteStore } from './route-store.js';
import type { JobInputs, JobProgress, Position, SearchQuery } from './model.js';

const { directory, query, resultPath } = workerData as { directory: string; query: SearchQuery; resultPath: string };
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
try {
  for (const chosen of selections) {
    await verify();
    progress.stage = 'preparing'; progress.currentRegion = { id: chosen.section.id, name: chosen.section.name }; send();
    const selection = await dataset.select(query, chosen);
    const previousExpansions = progress.expansions;
    progress.stage = 'searching'; send();
    const solved = await solveSection(selection.graph, query, async measured => {
      if (Date.now() - lastVerified >= 1000) { await verify(); lastVerified = Date.now(); }
      progress.expansions = previousExpansions + measured.expansions;
      if (Date.now() - lastProgress >= 100) { send(); lastProgress = Date.now(); }
    });
    await verify();
    progress.stage = 'saving'; send();
    const retained = solved.filter(saved => selection.isHike(saved.route));
    const savedIds = new Set(retained.map(saved => saved.route.id));
    const used = new Set<number>();
    store.begin();
    for (const saved of retained) {
      const route = selection.describe(saved.route);
      route.summary.id = hash(`${chosen.section.id}/${saved.route.id}`);
      for (const step of route.sections) used.add(step.id);
      store.add({ ...saved, route, groupId: hash(`${chosen.section.id}/${saved.groupId}`),
        reverseId: saved.reverseId && savedIds.has(saved.reverseId) ? hash(`${chosen.section.id}/${saved.reverseId}`) : undefined,
        oppositeId: saved.oppositeId && savedIds.has(saved.oppositeId) ? hash(`${chosen.section.id}/${saved.oppositeId}`) : undefined });
    }
    if (used.size) {
      const geometry = await dataset.readGeometry(chosen.section.id);
      for (const saved of retained) {
        let first: Position | undefined, previous: Position | undefined;
        for (const edgeId of saved.route.edges) {
          const edge = selection.graph.edges[edgeId]!;
          const points = geometry[edge.trail]?.coordinates;
          if (!points?.length) throw new Error(`Route drawing is missing in ${chosen.section.name}.`);
          const beginning = points[edge.reverse ? points.length - 1 : 0]!;
          const ending = points[edge.reverse ? 0 : points.length - 1]!;
          if (previous && (previous[0] !== beginning[0] || previous[1] !== beginning[1])) throw new Error(`Route drawing has a broken connection in ${chosen.section.name}.`);
          first ??= beginning; previous = ending;
        }
        if (!first || !previous || first[0] !== previous[0] || first[1] !== previous[1]) throw new Error(`Route drawing does not close in ${chosen.section.name}.`);
      }
      for (const id of used) {
        const shape = geometry[id];
        if (!shape?.coordinates.length) throw new Error(`Route drawing is missing in ${chosen.section.name}.`);
        store.saveGeometry(chosen.section.id, id, shape.coordinates);
      }
    }
    await verify();
    store.commit();
    progress.completedRegions.push(chosen.section.id);
    progress.completedStarts += chosen.eligible.length;
    send();
  }
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
