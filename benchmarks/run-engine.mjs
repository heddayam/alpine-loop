/** Descriptive real-data measurements; the window is not an application timeout. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const here = path.dirname(fileURLToPath(import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const readJSON = file => JSON.parse(readFileSync(file, 'utf8'));
const directories = { 'snoqualmie-region': '', 'central-cascades': 'central-cascades',
  'mount-rainier-area': 'mount-rainier-area' };

/** Exact source-edge identity; reversed traversal is reported separately. */
export function witnessMatcher(graph, sourceIndex, witness) {
  if (!witness) return () => ({ directed: false, reversed: false });
  assert.equal(sourceIndex.edgeIds.length, graph.edges.length);
  const byId = new Map(sourceIndex.edgeIds.map((id, index) => [id, index]));
  const byDirection = new Map(graph.edges.map((edge, index) => [`${edge.trail}:${edge.reverse}`, index]));
  const reversed = [...witness.edgeIds].reverse().map(id => {
    assert(byId.has(id), `Witness edge is absent from source index: ${id}`);
    const edge = graph.edges[byId.get(id)];
    const opposite = byDirection.get(`${edge.trail}:${!edge.reverse}`);
    return opposite === undefined ? null : sourceIndex.edgeIds[opposite];
  });
  assert(graph.starts.some(start => start.id === witness.startId), 'Witness start is absent');
  return route => {
    if (graph.starts[route.start]?.id !== witness.startId || route.edges.length !== witness.edgeIds.length)
      return { directed: false, reversed: false };
    const ids = route.edges.map(index => sourceIndex.edgeIds[index]);
    return { directed: ids.every((id, index) => id === witness.edgeIds[index]),
      reversed: reversed.every((id, index) => id !== null && id === ids[index]) };
  };
}

function engineSources(engine) {
  const root = path.dirname(engine);
  function scan(directory) {
    return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') return scan(file);
      return entry.isFile() && /\.(?:ts|js|mjs)$/.test(entry.name)
        ? [{ path: path.relative(root, file), sha256: sha(readFileSync(file)) }] : [];
    });
  }
  const files = scan(root).sort((a, b) => a.path.localeCompare(b.path));
  return { entry: path.basename(engine), entrySha256: sha(readFileSync(engine)), files,
    directorySha256: sha(JSON.stringify(files)) };
}

async function measure(options) {
  const frozen = readFileSync(path.join(here, 'queries.json'));
  const test = JSON.parse(frozen).queries.find(query => query.id === options.query);
  assert(test, `Unknown query: ${options.query}`);
  const witnessBytes = readFileSync(path.join(here, 'witnesses.json'));
  const expected = JSON.parse(witnessBytes);
  assert.equal(expected.querySha256, sha(frozen), 'Frozen queries changed');
  const expectation = expected.records.find(record => record.queryId === test.id);
  const evidence = readJSON(path.join(here, 'pilot-provenance.json')).artifacts
    .find(artifact => artifact.datasetId === test.datasetId);
  const folder = path.join(options.dataRoot, directories[test.regionId]);
  const loadingAt = performance.now();
  const compressed = readFileSync(path.join(folder, 'graph.json.gz'));
  const readAt = performance.now();
  const bytes = gunzipSync(compressed);
  const decompressedAt = performance.now();
  const graph = JSON.parse(bytes.toString());
  const parsedAt = performance.now();
  assert.equal(sha(compressed), evidence.files.graph.sha256, 'Frozen graph changed');
  assert.equal(graph.info.id, test.datasetId);
  const auditAt = performance.now();
  const indexBytes = readFileSync(path.join(folder, 'source-index.json.gz'));
  assert.equal(sha(indexBytes), evidence.files['source-index'].sha256, 'Source mapping changed');
  const matchWitness = witnessMatcher(graph, JSON.parse(gunzipSync(indexBytes)), expectation.witness);
  const auditSetupMs = performance.now() - auditAt;
  const importAt = performance.now();
  const { search } = await import(pathToFileURL(options.engine).href);
  const engineImportMs = performance.now() - importAt;
  const controller = new AbortController();
  let abortAt = null, firstExactMs = null, allAttemptedMs = null, completedMs = null;
  let directedRecoveredMs = null, reversedRecoveredMs = null, consumerComparisonMs = 0;
  let outputs = 0, progressEvents = 0, terminal = null;
  const milestones = [];
  let nextMilestone = 1000;
  const started = performance.now(), cpu = process.cpuUsage();
  const timer = setTimeout(() => {
    abortAt = performance.now();
    controller.abort('benchmark measurement window ended');
  }, options.budgetMs);
  try {
    for await (const event of search(graph, test.query, { signal: controller.signal })) {
      const elapsedMs = performance.now() - started;
      if (event.type === 'route') {
        outputs++;
        firstExactMs ??= elapsedMs;
        const comparingAt = performance.now();
        const match = matchWitness(event.route);
        if (match.directed) directedRecoveredMs ??= elapsedMs;
        if (match.reversed) reversedRecoveredMs ??= elapsedMs;
        consumerComparisonMs += performance.now() - comparingAt;
        // Do not retain route arrays: output storage belongs to full-app measurement.
      } else {
        const p = event.progress;
        if (p.attemptedStarts === p.totalStarts) allAttemptedMs ??= elapsedMs;
        if (event.type === 'progress') {
          progressEvents++;
          if (elapsedMs >= nextMilestone) {
            milestones.push({ ...p, observedMs: elapsedMs, outputs });
            nextMilestone = elapsedMs + 1000;
          }
        } else {
          terminal = event;
          if (event.status === 'complete') completedMs = elapsedMs;
        }
      }
    }
  } finally { clearTimeout(timer); }
  const ended = performance.now(), used = process.cpuUsage(cpu);
  assert(terminal, 'Engine ended without terminal event');
  assert.equal(terminal.progress.totalStarts, test.eligibleStartsAtFreeze, 'Eligible starts changed');
  if (expectation.existence === 'none') assert.equal(outputs, 0, 'Output contradicts independent no-match certificate');
  return { id: test.id, datasetId: graph.info.id, queriesSha256: sha(frozen), witnessesSha256: sha(witnessBytes),
    graphSha256: sha(bytes), graphGzipSha256: sha(compressed), sourceIndexGzipSha256: sha(indexBytes),
    sourceArtifactId: evidence.artifact.id, nodeCount: graph.nodes.length, directedEdges: graph.edges.length,
    graphStarts: graph.starts.length, compressedBytes: compressed.length, graphBytes: bytes.length,
    load: { readMs: readAt - loadingAt, decompressMs: decompressedAt - readAt,
      parseMs: parsedAt - decompressedAt, totalMs: parsedAt - loadingAt, auditSetupMs, engineImportMs },
    budgetMs: options.budgetMs, firstExactMs, allAttemptedMs, completedMs, outputs,
    witness: { existence: expectation.existence, directedRecoveredMs, reversedRecoveredMs },
    elapsedMs: ended - started, cpuMs: (used.user + used.system) / 1000, consumerComparisonMs,
    peakProcessRssMiB: process.resourceUsage().maxRSS / 1024, progressEvents,
    cancellation: abortAt === null ? null : { requestedMs: abortAt - started,
      timerDelayMs: Math.max(0, abortAt - started - options.budgetMs), acknowledgementMs: ended - abortAt },
    terminal, milestones };
}

function run(options) {
  const frozen = readJSON(path.join(here, 'queries.json')).queries;
  const tests = options.query ? frozen.filter(query => query.id === options.query) : frozen;
  assert(tests.length, 'Unknown query');
  const report = { version: 1, startedAt: new Date().toISOString(),
    referenceMachine: { cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length, arch: os.arch(),
      platform: os.platform(), release: os.release(), memoryBytes: os.totalmem(), node: process.version,
      nodeArgs: process.execArgv },
    runnerSha256: sha(readFileSync(fileURLToPath(import.meta.url))), engine: engineSources(options.engine),
    measurement: { budgetMs: options.budgetMs, sequentialFreshProcesses: true, retainsRoutes: false,
      includesAuditMappingInRss: true, note: 'Descriptive engine-only run. No warmup; filesystem cache uncontrolled. Wall time includes witness comparisons. Not full-app memory or a coverage certificate.' },
    results: [] };
  for (const test of tests) {
    const child = spawnSync(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url),
      '--worker', JSON.stringify({ ...options, query: test.id })],
    { encoding: 'utf8', timeout: options.budgetMs + 15_000, maxBuffer: 4 * 1024 * 1024 });
    assert.equal(child.status, 0, `${test.id}: ${child.error?.message ?? child.stderr}`);
    assert.deepEqual(engineSources(options.engine), report.engine, 'Engine sources changed during measurement');
    const result = JSON.parse(child.stdout);
    report.results.push(result);
    report.updatedAt = new Date().toISOString();
    writeFileSync(options.output, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`${test.id}: ${result.outputs} outputs; ${result.terminal.status}; witness ${result.witness.directedRecoveredMs ?? result.witness.reversedRecoveredMs ?? 'unrecovered/not proven'} ms`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === '--worker') console.log(JSON.stringify(await measure(JSON.parse(process.argv[3]))));
  else {
    const args = new Map();
    for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1]);
    assert(args.has('--data-root') && args.has('--output'),
      'Usage: node --import tsx benchmarks/run-engine.mjs --data-root DIR --output FILE [--engine FILE] [--budget-ms 10000] [--query ID]');
    const budgetMs = Number(args.get('--budget-ms') ?? 10_000);
    assert(Number.isFinite(budgetMs) && budgetMs > 0, 'Positive measurement window required');
    run({ dataRoot: path.resolve(args.get('--data-root')), output: path.resolve(args.get('--output')),
      engine: path.resolve(args.get('--engine') ?? path.join(here, '../src/engine/search.ts')),
      budgetMs, query: args.get('--query') });
  }
}
