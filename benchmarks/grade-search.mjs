/** Paired real-data grade benchmark, isolated from live jobs.
 * Build the chosen checkout first: npx tsc -p tsconfig.server.json
 * node benchmarks/grade-search.mjs <checkout> <dataset> <output.json> [query-id]
 * Each observation gets a fresh process and the app's 40%-of-one-core budget.
 * This measures preparation + solving; result storage and input polling are excluded.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync, execFileSync } from 'node:child_process';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const self = fileURLToPath(import.meta.url);
if (process.argv[2] !== '--case') {
  const [rootArg, datasetArg, outputArg, filter] = process.argv.slice(2);
  if (!outputArg) throw Error('Usage: grade-search.mjs <checkout> <dataset> <output.json> [query-id]');
  const root = resolve(rootArg), dataset = resolve(datasetArg), output = resolve(outputArg);
  const definitions = JSON.parse(readFileSync(new URL('./grade-search-queries.json', import.meta.url)));
  const result = { date: new Date().toISOString(), revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    root, dataset, node: process.version, cpuFraction: 0.4, definitions, observations: [] };
  const queries = definitions.queries.filter(item => !filter || item.id === filter);
  if (!queries.length) throw Error(`Unknown query: ${filter}`);
  for (const definition of queries) for (const gradesEnabled of [false, true]) {
    const child = spawnSync(process.execPath, [self, '--case', JSON.stringify({ root, dataset, definition, gradesEnabled })],
      { encoding: 'utf8', maxBuffer: 1024 * 1024 });
    if (child.status !== 0) throw Error(child.stderr || child.stdout || `Benchmark exited ${child.status}`);
    const observation = JSON.parse(child.stdout);
    result.observations.push(observation);
    writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify(observation));
  }
} else {
  const { root, dataset: directory, definition, gradesEnabled } = JSON.parse(process.argv[3]);
  const load = name => import(pathToFileURL(join(root, 'dist/server', name + '.js')));
  const [{ readDataset }, { solveSection }, { routeGradeCheck }, { createWorkBudget }] = await Promise.all(
    ['dataset', 'diversity', 'route-grades', 'work-budget'].map(load));
  const query = structuredClone(definition.query);
  if (!gradesEnabled) delete query.grades;
  const cpu = process.cpuUsage(), began = performance.now(), budget = createWorkBudget();
  const data = await readDataset(directory, budget), selections = await data.starts(query);
  const routes = [], sections = [];
  let gradeCalls = 0, gradeCheckMs = 0, gradePreparationMs = 0, graphPreparationMs = 0, searchMs = 0;
  let peakRssBytes = process.memoryUsage.rss();
  const sample = () => { peakRssBytes = Math.max(peakRssBytes, process.memoryUsage.rss()); };
  const timer = setInterval(sample, 20);
  try {
    for (const chosen of selections) {
      let at = performance.now();
      const { graph } = await data.select(query, chosen);
      graphPreparationMs += performance.now() - at;
      at = performance.now();
      const check = query.grades ? await routeGradeCheck(graph,
        data.readGeometry(chosen.section.id, new Set(graph.edges.map(edge => edge.trail))), query.grades, budget) : undefined;
      gradePreparationMs += performance.now() - at;
      const gradeCheck = check && (route => {
        const start = performance.now();
        const accepted = check(route);
        gradeCheckMs += performance.now() - start; gradeCalls++;
        return accepted;
      });
      let progress;
      at = performance.now();
      await solveSection(graph, query, { budget, gradeCheck,
        onProgress: value => { progress = value; },
        onRoute: ({ route, groupId }) => routes.push([chosen.section.id, groupId, route.id]) });
      searchMs += performance.now() - at;
      sections.push({ id: chosen.section.id, starts: chosen.eligible.length, expansions: progress.expansions });
      sample();
    }
  } finally {
    clearInterval(timer);
    await data.downloads.close();
  }
  const usage = process.cpuUsage(cpu), elapsedMs = performance.now() - began;
  console.log(JSON.stringify({ id: definition.id, gradesEnabled, query, catalogId: data.catalog.info.id,
    elapsedMs, cpuMs: (usage.user + usage.system) / 1000, graphPreparationMs, gradePreparationMs, searchMs,
    gradeCalls, gradeCheckMs, peakRssBytes, sections, routeCount: routes.length,
    routesHash: hash(routes.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))) }));
}
