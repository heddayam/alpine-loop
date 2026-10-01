// Observe recovery of the already-proven ordered source walk; never mine an oracle.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { search } from '../../dist/server/engine/search.js';

const [dataset, sourceReport] = process.argv.slice(2);
if (!dataset || !sourceReport) throw new Error('Usage: node recover.mjs DATASET SOURCE_REPLAY_JSON');
const directory = resolve(dataset);
const witness = JSON.parse(await readFile(sourceReport, 'utf8'));
const fixed = JSON.parse(await readFile(new URL('./witness.json', import.meta.url), 'utf8'));
const frozen = JSON.parse(await readFile(new URL('../queries.json', import.meta.url), 'utf8'));
assert.deepEqual(fixed.query, frozen.queries.find(query => query.id === 'north-bend-known').query);
assert.equal(witness.sourceSnapshotVerified, true);
assert.equal(witness.querySatisfied, true);
const graphHash = createHash('sha256').update(await readFile(join(directory, 'graph.json.gz'))).digest('hex');
assert.equal(graphHash, witness.graphSha256, 'Replay the independent source witness on this exact dataset first');
const index = JSON.parse(gunzipSync(await readFile(join(directory, 'source-index.json.gz'))));
const graph = JSON.parse(gunzipSync(await readFile(join(directory, 'graph.json.gz'))));
const expected = witness.orderedEdges.join('|');
const observationMs = 30_000;
let recovery = null, final = null, candidates = 0;
const started = performance.now();
for await (const event of search(graph, fixed.query, { signal: AbortSignal.timeout(observationMs) })) {
  if (event.type === 'route') {
    candidates++;
    if (!recovery && graph.starts[event.route.start].id === witness.startId
      && event.route.edges.map(number => index.edgeIds[number]).join('|') === expected) {
      recovery = { elapsedMs: performance.now() - started, route: event.route };
    }
  }
  if (event.type === 'done') final = event;
}
console.log(JSON.stringify({ query: fixed.query, graphSha256: graphHash, node: process.version,
  observationMs, candidates, recovered: !!recovery, recovery, final }, null, 2));
assert.ok(recovery, 'The fixed witness was not observed within this measurement window; this is not an emptiness proof');
