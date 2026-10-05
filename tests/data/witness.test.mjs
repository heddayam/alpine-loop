import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyWitness } from '../../benchmarks/source-witnesses.mjs';

test('source witness validator accepts a real stem/cycle pattern and rejects extra spurs', () => {
  const rows = [
    ['ab', 'a', 'b', 'stem', 2], ['ba', 'b', 'a', 'stem', 0],
    ['bc', 'b', 'c', 'one', 3], ['cd', 'c', 'd', 'two', 0], ['db', 'd', 'b', 'three', 0],
  ];
  const edges = rows.map(([id, from, to, trail, gain]) => ({ id, from, to, trail, gain, distance: 10, access: 'public' }));
  const source = { starts: [{ id: 's', node: 'a', access: 'public' }],
    positions: new Map([['a', [0, 0]]]), edgeById: new Map(edges.map(edge => [edge.id, edge])) };
  const query = { sections: ['fixture'], distance: [0, 100], gain: [0, 100], repetition: 0.5, includeUnknown: true };
  const valid = { startId: 's', edgeIds: ['ab', 'bc', 'cd', 'db', 'ba'] };
  assert.deepEqual(verifyWitness(source, { query }, valid),
    { distance: 50, gain: 5, repetition: 0.2, kind: 'lollipop', uncertain: false });
  assert.throws(() => verifyWitness(source, { query }, { ...valid, edgeIds: ['ab', 'ba', ...valid.edgeIds] }));
  assert.throws(() => verifyWitness(source, { query: { ...query, repetition: 0.19 } }, valid));
});
