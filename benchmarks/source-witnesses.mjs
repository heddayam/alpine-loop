/** Independent verification of a directed source walk; no solver imports. */
import assert from 'node:assert/strict';
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
