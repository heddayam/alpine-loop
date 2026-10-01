/** Prepared-network witness measurements; observation guards are not app limits. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const file = fileURLToPath(import.meta.url), here = path.dirname(file), root = path.resolve(here, '..');
const read = name => JSON.parse(fs.readFileSync(name, 'utf8'));
const hash = name => createHash('sha256').update(fs.readFileSync(name)).digest('hex');
const queriesFile = path.join(here, 'queries.json'), witnessesFile = path.join(here, 'prepared-witnesses.json');
const save = (name, value) => {
  fs.writeFileSync(name + '.tmp', JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(name + '.tmp', name);
};

/** Local edge indexes may change; only the original start and physical walk count. */
export function witnessMatcher(graph, witness) {
  const startId = witness.currentStart.id, walk = witness.currentSectionWalk;
  assert(walk.length && graph.starts.some(start => start.id === startId), 'Witness start or walk is absent');
  const directions = new Map(graph.edges.map((edge, index) => [`${edge.trail}:${edge.reverse}`, index]));
  const forward = walk.map(([trail, reverse]) => {
    const index = directions.get(`${trail}:${reverse}`);
    assert(index !== undefined, `Witness section direction is absent: ${trail}:${reverse}`);
    return index;
  });
  const backward = [...walk].reverse().map(([trail, reverse]) => directions.get(`${trail}:${!reverse}`));
  return route => {
    if (graph.starts[route.start]?.id !== startId || route.edges.length !== forward.length)
      return { directed: false, reversed: false };
    return { directed: route.edges.every((index, part) => index === forward[part]),
      reversed: backward.every((index, part) => index !== undefined && index === route.edges[part]) };
  };
}

function compiledHashes(server, directory = server) {
  return Object.fromEntries(fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const name = path.join(directory, entry.name);
    return entry.isDirectory() ? Object.entries(compiledHashes(server, name))
      : entry.name.endsWith('.js') ? [[path.relative(server, name), hash(name)]] : [];
  }).sort(([a], [b]) => a.localeCompare(b)));
}

function inputPins(options) {
  const expected = read(witnessesFile), manifestFile = path.join(options.dataset, 'manifest.json');
  assert.equal(hash(manifestFile), expected.snapshotManifestSha256, 'Prepared manifest differs from the committed witness snapshot');
  assert.equal(read(manifestFile).info.id, expected.snapshotId, 'Prepared snapshot identity changed');
  assert.equal(hash(queriesFile), expected.frozenQueriesSha256, 'Frozen queries changed');
  assert.equal(hash(path.join(here, 'witnesses.json')), expected.frozenWitnessesSha256, 'Original frozen witnesses changed');
  const compiled = compiledHashes(options.server);
  assert(compiled['dataset.js'] && compiled['engine/search.js'], 'Built modules missing; run npm run build first');
  return { snapshotId: expected.snapshotId, manifestSha256: expected.snapshotManifestSha256,
    queriesSha256: expected.frozenQueriesSha256, originalWitnessesSha256: expected.frozenWitnessesSha256,
    preparedWitnessesSha256: hash(witnessesFile), compiledHashes: compiled, runnerSha256: hash(file) };
}

async function measure(options) {
  const result = { id: options.query, observationMs: options.observationMs, rssGuardBytes: options.rssBytes,
    outcome: 'unfinished', outputs: 0, firstCandidateMs: null, allStartsAttemptedMs: null,
    witness: { directedRecoveredMs: null, reversedRecoveredMs: null }, progress: null, terminal: null,
    guard: null, measurementError: null, milestones: [] };
  const controller = new AbortController(), started = performance.now(), cpu = process.cpuUsage();
  let engineAt = null, engineEndedAt = null, peakRss = 0, sampleCount = 0, previousSample = started, maxSampleGapMs = 0, milestoneAt = -Infinity;
  const elapsed = () => performance.now() - started;
  function stop(reason, rssBytes) {
    result.guard ??= { reason, requestedMs: elapsed(), ...(rssBytes === undefined ? {} : { rssBytes }) };
    controller.abort(reason);
  }
  function sample() {
    const now = performance.now(), rss = process.memoryUsage.rss();
    maxSampleGapMs = Math.max(maxSampleGapMs, now - previousSample); previousSample = now;
    peakRss = Math.max(peakRss, rss); sampleCount++;
    if (rss > options.rssBytes && !result.terminal) stop('rss_guard', rss);
  }
  sample();
  const timer = setTimeout(() => stop('observation_window'), options.observationMs), sampler = setInterval(sample, 20);
  try {
    assert.deepEqual(inputPins(options), options.inputs, 'Inputs changed before child measurement');
    const proof = read(witnessesFile), witness = proof.results.find(entry => entry.queryId === options.query && entry.status === 'eligible');
    const definition = read(queriesFile).queries.find(entry => entry.id === options.query);
    assert(witness && definition, 'Query has no qualifying committed witness');
    assert.deepEqual(definition.query, witness.originalQuery, 'Witness constraints differ from the frozen query');
    result.query = { ...definition.query, roads: proof.resolvedRoadLimits };
    result.originalStartId = witness.currentStart.id;
    const { readDataset } = await import(pathToFileURL(path.join(options.server, 'dataset.js')));
    const { search } = await import(pathToFileURL(path.join(options.server, 'engine/search.js')));
    const dataset = await readDataset(options.dataset);
    assert.equal(dataset.info.id, options.inputs.snapshotId);
    const selection = await dataset.select(result.query), graph = selection.graph;
    const match = witnessMatcher(graph, witness);
    result.coverageNote = selection.coverageNote ?? null;
    result.graph = { nodes: graph.nodes.length, directedEdges: graph.edges.length, starts: graph.starts.length };
    result.setupMs = elapsed(); sample(); save(options.checkpoint, result);
    // Include setup in the observation window even when synchronous parsing delayed its timer.
    if (elapsed() >= options.observationMs) stop('observation_window');
    engineAt = performance.now();
    for await (const event of search(graph, result.query, { signal: controller.signal })) {
      const at = elapsed();
      if (event.type === 'route') {
        result.outputs++; result.firstCandidateMs ??= at;
        const found = match(event.route);
        if (found.directed) result.witness.directedRecoveredMs ??= at;
        if (found.reversed) result.witness.reversedRecoveredMs ??= at;
        // Deliberately discard every route: this measures the engine, not app retention.
      } else {
        result.progress = event.progress;
        if (event.progress.attemptedStarts === event.progress.totalStarts) result.allStartsAttemptedMs ??= at;
        if (event.type === 'done') { result.terminal = event; result.terminalObservedMs = at; }
        if (at - milestoneAt >= 1000 || event.type === 'done') {
          result.milestones.push({ atMs: at, outputs: result.outputs, ...event.progress });
          milestoneAt = at; save(options.checkpoint, result);
        }
      }
    }
    engineEndedAt = performance.now();
    assert(result.terminal, 'Engine ended without a terminal event');
    if (result.terminal.status === 'complete') {
      assert(result.witness.directedRecoveredMs !== null || result.witness.reversedRecoveredMs !== null,
        'Completed search missed its qualifying fixed witness');
      result.outcome = 'complete_within_snapshot';
    }
    assert.deepEqual(inputPins(options), options.inputs, 'Inputs changed during child measurement');
  } catch (error) {
    result.measurementError = String(error.stack ?? error); result.outcome = 'failed';
  } finally {
    sample(); clearTimeout(timer); clearInterval(sampler);
    result.elapsedMs = elapsed(); result.engineMs = engineAt === null ? null : (engineEndedAt ?? performance.now()) - engineAt;
    const used = process.cpuUsage(cpu); result.cpuMs = (used.user + used.system) / 1000;
    result.sampledPeakRssBytes = peakRss; result.osProcessPeakRssBytes = process.resourceUsage().maxRSS * 1024;
    result.sampleCount = sampleCount; result.maxSampleGapMs = maxSampleGapMs;
    result.cancellation = result.guard ? { ...result.guard, acknowledgementMs: result.terminal?.status === 'stopped' && result.guard.requestedMs <= result.terminalObservedMs
        ? result.terminalObservedMs - result.guard.requestedMs : null } : null;
    result.witness.recovered = result.witness.directedRecoveredMs !== null || result.witness.reversedRecoveredMs !== null;
    save(options.checkpoint, result);
  }
  if (result.measurementError) process.exitCode = 1;
}

function run(options) {
  const proof = read(witnessesFile), tests = proof.results.filter(entry => entry.status === 'eligible'
    && (!options.query || entry.queryId === options.query));
  assert(tests.length, 'No qualifying committed witness for the requested query');
  const report = { version: 2, startedAt: new Date().toISOString(), dataset: options.dataset, server: options.server,
    inputs: inputPins(options), sourceProof: { osmSha256: proof.sourceOsmSha256, sourceIndexSha256: proof.sourceIndexSha256,
      compilerHashes: proof.compilerHashes, independentReplaySha256: proof.fullReportSha256 },
    machine: { node: process.version, platform: os.platform(), arch: os.arch(), release: os.release(),
      cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length, memoryBytes: os.totalmem() },
    measurement: { observationMs: options.observationMs, rssGuardBytes: options.rssBytes,
      note: 'Fresh sequential child per qualifying witness. All eligible starts and frozen constraints remain unchanged; explicit resolved road defaults are included. Exact recovery requires original start and ordered or fully reversed physical section walk. No diversity grouping or retained route arrays. Observation starts before setup; RSS includes loader, engine and matcher, excludes coordinator/browser. Sampled RSS can miss peaks. Guards leave exploration unfinished; a recovered witness does not establish completion. Timing is descriptive; filesystem caches and concurrent work are uncontrolled. This is not HTTP/GPX proof or a coverage certificate.' },
    plannedQueries: tests.map(test => test.queryId), results: [] };
  fs.mkdirSync(path.dirname(options.output), { recursive: true });
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'alpine-witness-measurements-')), checkpoint = path.join(temporary, 'case.json');
  try {
    save(options.output, report);
    for (const test of tests) {
      assert.deepEqual(inputPins(options), report.inputs, 'Inputs changed between cases');
      fs.rmSync(checkpoint, { force: true }); report.currentQuery = test.queryId; save(options.output, report);
      const child = spawnSync(process.execPath, [file, '--worker', JSON.stringify({ ...options,
        query: test.queryId, inputs: report.inputs, checkpoint })],
      { encoding: 'utf8', timeout: options.observationMs + 15_000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 });
      const result = fs.existsSync(checkpoint) ? read(checkpoint) : { id: test.queryId, outcome: 'unfinished',
        progress: null, witness: { recovered: null }, measurementError: 'No child observation was saved; no route conclusion is possible.' };
      result.processOutcome = { exitCode: child.status, signal: child.signal, error: child.error?.message ?? null, stderr: child.stderr };
      if (child.status !== 0) {
        const deadline = child.error?.code === 'ETIMEDOUT';
        result.outcome = result.outcome === 'failed' || !deadline ? 'failed' : 'unfinished';
        result.measurementError ??= deadline ? 'Outer deadline killed the child; exploration is unfinished.'
          : 'Child execution failed; no completion claim is possible.';
      }
      report.results.push(result); report.currentQuery = null; save(options.output, report);
      assert.deepEqual(inputPins(options), report.inputs, 'Inputs changed during case measurement');
      console.log(JSON.stringify({ id: result.id, outcome: result.outcome, outputs: result.outputs,
        witness: result.witness, progress: result.progress, error: result.measurementError }));
    }
    report.finishedAt = new Date().toISOString();
  } catch (error) { report.measurementError = String(error.stack ?? error); }
  finally {
    report.hasFailures = !!report.measurementError || report.results.some(result => result.measurementError || result.guard?.reason === 'rss_guard');
    try { save(options.output, report); } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
  }
  if (report.hasFailures) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === file) {
  if (process.argv[2] === '--worker') await measure(JSON.parse(process.argv[3]));
  else {
    const usage = 'Usage: node benchmarks/run-engine.mjs --dataset DIR --output FILE [--server DIR] [--observation-ms 60000] [--rss-bytes 1000000000] [--query ID]\nRun npm run build first. Omitting --query measures all seven qualifying prepared witnesses.';
    const args = new Map();
    for (let index = 2; index < process.argv.length; index += 2) {
      const key = process.argv[index], value = process.argv[index + 1];
      if (key === '--help') { console.log(usage); process.exit(0); }
      assert(['--dataset', '--output', '--server', '--observation-ms', '--rss-bytes', '--query'].includes(key) && value && !args.has(key), usage);
      args.set(key, value);
    }
    assert(args.has('--dataset') && args.has('--output'), usage);
    const observationMs = Number(args.get('--observation-ms') ?? 60_000), rssBytes = Number(args.get('--rss-bytes') ?? 1_000_000_000);
    assert(Number.isSafeInteger(observationMs) && observationMs > 0 && Number.isSafeInteger(rssBytes) && rssBytes > 0,
      'Limits must be positive integer milliseconds/bytes');
    run({ dataset: path.resolve(args.get('--dataset')), output: path.resolve(args.get('--output')),
      server: path.resolve(args.get('--server') ?? path.join(root, 'dist/server')), observationMs, rssBytes, query: args.get('--query') });
  }
}
