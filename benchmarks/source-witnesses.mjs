/** Independent witnesses from stored physical trails. No production solver imports.
 * Fundamental cycles supply examples, never an exhaustive existence oracle.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { gunzipSync } from 'node:zlib';

const sha = value => createHash('sha256').update(value).digest('hex');
const acceptable = (access, query) => access === 'public' || (query.includeUnknown && access === 'unknown');
const inside = ([x, y], [w, s, e, n]) => x >= w && x <= e && y >= s && y <= n;

export function verifyWitness(source, test, witness) {
  const start = source.starts.find(start => start.id === witness.startId);
  assert(start && inside(source.positions.get(start.node), test.query.area), 'Start must be in the requested area');
  assert(acceptable(start.access, test.query), 'Starting access');
  const walk = witness.edgeIds.map(id => {
    const edge = source.edgeById.get(id);
    assert(edge && acceptable(edge.access, test.query), `Missing or forbidden edge ${id}`);
    return edge;
  });
  assert(walk.length > 0);
  const nodes = [start.node];
  let distance = 0;
  let gain = 0;
  let repeated = 0;
  const physical = new Set();
  for (const edge of walk) {
    assert.equal(edge.from, nodes.at(-1), 'Directed continuity');
    nodes.push(edge.to);
    distance += edge.distance;
    gain += edge.gain;
    if (physical.has(edge.trail)) repeated += edge.distance;
    physical.add(edge.trail);
  }
  assert.equal(nodes.at(-1), start.node, 'Closed route');
  const firstVisit = new Map([[start.node, 0]]);
  let attachment = -1;
  let closure = -1;
  for (let index = 1; index < nodes.length; index++) {
    if (firstVisit.has(nodes[index])) {
      attachment = firstVisit.get(nodes[index]);
      closure = index;
      break;
    }
    firstVisit.set(nodes[index], index);
  }
  assert(closure > attachment && closure + attachment === walk.length, 'Exactly one simple cycle plus optional stem');
  const cycleTrails = walk.slice(attachment, closure).map(edge => edge.trail);
  assert.equal(new Set(cycleTrails).size, cycleTrails.length, 'Cycle cannot merely reverse one physical trail');
  for (let index = 0; index < attachment; index++) {
    const outbound = walk[attachment - 1 - index];
    const inbound = walk[closure + index];
    assert.equal(inbound.trail, outbound.trail, 'Return on the identical stem');
    assert.equal(inbound.from, outbound.to);
    assert.equal(inbound.to, outbound.from);
  }
  const repetition = repeated / distance;
  assert(distance >= test.query.distance[0] - 1e-7 && distance <= test.query.distance[1] + 1e-7, 'Distance');
  assert(gain >= test.query.gain[0] - 1e-7 && gain <= test.query.gain[1] + 1e-7, 'Gain');
  assert(repetition <= test.query.repetition + 1e-10, 'Repeated-trail fraction');
  return { distance, gain, repetition, kind: attachment === 0 ? 'loop' : 'lollipop',
    uncertain: start.access === 'unknown' || walk.some(edge => edge.access === 'unknown') };
}

function sourceGraph(db) {
  const positions = new Map(db.prepare('SELECT id,lon,lat FROM nodes').all().map(row => [row.id, [row.lon, row.lat]]));
  const edges = db.prepare(`SELECT e.id,e.from_node,e.to_node,p.stable_physical_id,e.length_m,e.gain_m,e.access_state
    FROM edges e JOIN physical_edges p USING(physical_edge_key) ORDER BY e.id`).all().map(row => ({
    id: row.id, from: row.from_node, to: row.to_node, trail: row.stable_physical_id,
    distance: row.length_m, gain: row.gain_m, access: row.access_state,
  })).filter(edge => edge.access === 'public' || edge.access === 'unknown');
  const starts = db.prepare('SELECT id,node_id,name,access_state FROM access_points ORDER BY id').all()
    .map(row => ({ id: row.id, node: row.node_id, name: row.name, access: row.access_state }));
  const adjacency = new Map();
  const physical = new Map();
  for (const edge of edges) {
    if (!adjacency.has(edge.from)) adjacency.set(edge.from, []);
    adjacency.get(edge.from).push(edge);
    if (!physical.has(edge.trail)) physical.set(edge.trail, edge);
  }
  return { positions, edges, starts, adjacency, physical, edgeById: new Map(edges.map(edge => [edge.id, edge])) };
}

function cycles(source) {
  const adjacent = new Map();
  for (const edge of source.physical.values()) {
    for (const [from, to] of [[edge.from, edge.to], [edge.to, edge.from]]) {
      if (!adjacent.has(from)) adjacent.set(from, []);
      adjacent.get(from).push({ from, to, trail: edge.trail });
    }
  }
  const parent = new Map();
  const tree = new Set();
  for (const root of adjacent.keys()) {
    if (parent.has(root)) continue;
    parent.set(root, null);
    const queue = [root];
    for (let i = 0; i < queue.length; i++) {
      for (const edge of adjacent.get(queue[i]) ?? []) {
        if (parent.has(edge.to)) continue;
        parent.set(edge.to, edge);
        tree.add(edge.trail);
        queue.push(edge.to);
      }
    }
  }
  const found = [];
  for (const edge of source.physical.values()) {
    if (tree.has(edge.trail)) continue;
    const ancestry = new Map([[edge.from, 0]]);
    const left = [];
    let node = edge.from;
    while (parent.get(node)) {
      const step = parent.get(node);
      left.push({ from: step.to, to: step.from, trail: step.trail });
      node = step.from;
      ancestry.set(node, left.length);
    }
    const right = [];
    node = edge.to;
    while (!ancestry.has(node)) {
      const step = parent.get(node);
      right.push(step);
      node = step.from;
    }
    const cycle = [...left.slice(0, ancestry.get(node)), ...right.reverse(),
      { from: edge.to, to: edge.from, trail: edge.trail }];
    if (cycle.length > 1) found.push(cycle);
  }
  return found;
}

function distances(source, start, query) {
  const best = new Map([[start, 0]]);
  const parent = new Map();
  const heap = [[0, start]];
  function push(item) {
    let index = heap.length;
    heap.push(item);
    while (index > 0) {
      const above = (index - 1) >> 1;
      if (heap[above][0] <= item[0]) break;
      heap[index] = heap[above];
      index = above;
    }
    heap[index] = item;
  }
  while (heap.length) {
    const [distance, node] = heap[0];
    const end = heap.pop();
    if (heap.length) {
      let index = 0;
      while (index * 2 + 1 < heap.length) {
        let child = index * 2 + 1;
        if (child + 1 < heap.length && heap[child + 1][0] < heap[child][0]) child++;
        if (heap[child][0] >= end[0]) break;
        heap[index] = heap[child];
        index = child;
      }
      heap[index] = end;
    }
    if (distance !== best.get(node)) continue;
    for (const edge of source.adjacency.get(node) ?? []) {
      if (!acceptable(edge.access, query)) continue;
      const next = distance + edge.distance;
      if (next > query.distance[1] || next >= (best.get(edge.to) ?? Infinity)) continue;
      best.set(edge.to, next);
      parent.set(edge.to, edge);
      push([next, edge.to]);
    }
  }
  return { best, parent };
}

function direction(source, step, query) {
  return source.adjacency.get(step.from)?.find(edge => edge.to === step.to
    && edge.trail === step.trail && acceptable(edge.access, query));
}

function findWitness(source, test, basis) {
  for (const start of source.starts) {
    if (!acceptable(start.access, test.query) || !inside(source.positions.get(start.node), test.query.area)) continue;
    const { best, parent } = distances(source, start.node, test.query);
    for (const original of basis) {
      let at = -1;
      let nearest = Infinity;
      for (let i = 0; i < original.length; i++) {
        const distance = best.get(original[i].from) ?? Infinity;
        if (distance < nearest) { nearest = distance; at = i; }
      }
      if (at < 0) continue;
      const stem = [];
      let node = original[at].from;
      while (node !== start.node) {
        const edge = parent.get(node);
        if (!edge) break;
        stem.push(edge);
        node = edge.from;
      }
      if (node !== start.node) continue;
      stem.reverse();
      const returning = [...stem].reverse().map(edge => direction(source, { ...edge, from: edge.to, to: edge.from }, test.query));
      if (returning.some(edge => !edge)) continue;
      const rotated = [...original.slice(at), ...original.slice(0, at)];
      for (const steps of [rotated, [...rotated].reverse().map(edge => ({ ...edge, from: edge.to, to: edge.from }))]) {
        const cycle = steps.map(step => direction(source, step, test.query));
        if (cycle.some(edge => !edge)) continue;
        const witness = { startId: start.id, startName: start.name,
          edgeIds: [...stem, ...cycle, ...returning].map(edge => edge.id) };
        try { return { ...witness, metrics: verifyWitness(source, test, witness) }; }
        catch { /* A basis cycle is only a proposal. Independent validation decides. */ }
      }
    }
  }
  return null;
}

/** A simple loop/lollipop uses each directed edge at most once. Sum gain over
 * every edge that could fit between shortest outward/return paths. This is an
 * intentionally loose upper bound, not route enumeration or a solver verdict.
 */
function noMatchCertificate(source, test) {
  const reverse = { adjacency: new Map() };
  for (const edge of source.edges) {
    if (!reverse.adjacency.has(edge.to)) reverse.adjacency.set(edge.to, []);
    reverse.adjacency.get(edge.to).push({ ...edge, from: edge.to, to: edge.from });
  }
  let eligibleStarts = 0;
  let maximumGainBound = 0;
  for (const start of source.starts) {
    if (!acceptable(start.access, test.query) || !inside(source.positions.get(start.node), test.query.area)) continue;
    eligibleStarts++;
    const outward = distances(source, start.node, test.query).best;
    const returning = distances(reverse, start.node, test.query).best;
    let bound = 0;
    for (const edge of source.edges) {
      if (!acceptable(edge.access, test.query)) continue;
      const minimumDistance = (outward.get(edge.from) ?? Infinity) + edge.distance
        + (returning.get(edge.to) ?? Infinity);
      if (minimumDistance <= test.query.distance[1] + 0.0001) bound += edge.gain;
    }
    maximumGainBound = Math.max(maximumGainBound, bound);
    if (bound + Math.max(0.0001, bound * 1e-8) >= test.query.gain[0]) return null;
  }
  return { method: 'sum of potentially usable directed-edge gains bounds every simple loop/lollipop',
    eligibleStarts, maximumGainBound, requestedMinimumGain: test.query.gain[0] };
}

async function run(mode, releaseRoot) {
  const frozen = await readFile(new URL('./queries.json', import.meta.url));
  const tests = JSON.parse(frozen).queries;
  const provenance = JSON.parse(await readFile(new URL('./pilot-provenance.json', import.meta.url))).artifacts;
  const prior = mode === 'verify' ? JSON.parse(await readFile(new URL('./witnesses.json', import.meta.url))) : null;
  const records = [];
  for (const evidence of provenance) {
    const input = await readFile(path.join(releaseRoot, 'objects', `${evidence.artifact.id}.sqlite.gz`));
    assert.equal(sha(input), evidence.artifact.compressedHash);
    const raw = gunzipSync(input);
    assert.equal(sha(raw), evidence.artifact.id);
    assert.equal(raw[18], 1, 'Only sealed DELETE-mode artifacts may be inspected');
    assert.equal(raw[19], 1);
    const temporary = await mkdtemp(path.join(tmpdir(), 'alpine-witness-'));
    let db;
    try {
      const file = path.join(temporary, 'source.sqlite');
      await writeFile(file, raw);
      db = new DatabaseSync(file, { readOnly: true });
      const source = sourceGraph(db);
      const basis = mode === 'mine' ? cycles(source) : [];
      for (const test of tests.filter(test => test.regionId === evidence.regionId)) {
        const witness = mode === 'mine' ? findWitness(source, test, basis)
          : prior.records.find(record => record.queryId === test.id)?.witness;
        if (witness) assert.deepEqual(verifyWitness(source, test, witness), witness.metrics);
        const certificate = !witness && test.query.gain[0] > 2000 ? noMatchCertificate(source, test) : null;
        if (mode === 'verify') assert.deepEqual(certificate,
          prior.records.find(record => record.queryId === test.id)?.certificate);
        records.push({ queryId: test.id, existence: witness ? 'proven' : certificate ? 'none' : 'unknown',
          method: witness ? 'physical-source spanning-tree cycle plus independently validated approach'
            : certificate ? 'independent gain upper-bound certificate'
              : 'No basis-cycle witness found; this is not an emptiness proof.',
          artifactId: evidence.artifact.id, witness, certificate });
        console.log(`${test.id}: ${witness ? `${witness.metrics.kind}, ${witness.metrics.distance.toFixed(0)} m` : certificate ? 'proven no match' : 'unknown'}`);
      }
    } finally {
      db?.close();
      await rm(temporary, { recursive: true, force: true });
    }
  }
  const result = { version: 1, querySha256: sha(frozen), records };
  if (mode === 'mine') await writeFile(new URL('./witnesses.json', import.meta.url), `${JSON.stringify(result, null, 2)}\n`);
  else assert.equal(prior.querySha256, result.querySha256, 'Frozen queries changed');
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  const [mode, releaseRoot] = process.argv.slice(2);
  assert(['mine', 'verify'].includes(mode) && releaseRoot, 'Usage: source-witnesses.mjs mine|verify RELEASE_ROOT');
  await run(mode, releaseRoot);
}
