import assert from 'node:assert/strict';
import test from 'node:test';
import { witnessMatcher } from './run-engine.mjs';

test('witness recovery requires original start and physical section order, with full reverse separate', () => {
  const graph = { starts: [{ id: 'A' }, { id: 'B' }], edges: [
    { trail: 90, reverse: false }, { trail: 90, reverse: true },
    { trail: 12, reverse: false }, { trail: 12, reverse: true },
    { trail: 63, reverse: false }, { trail: 63, reverse: true },
    { trail: 41, reverse: false }, { trail: 41, reverse: true },
  ] };
  const witness = { currentStart: { id: 'A' },
    currentSectionWalk: [[90, false], [12, false], [63, false], [41, false], [90, true]] };
  const match = witnessMatcher(graph, witness);
  assert.deepEqual(match({ start: 0, edges: [0, 2, 4, 6, 1] }), { directed: true, reversed: false });
  assert.deepEqual(match({ start: 0, edges: [0, 7, 5, 3, 1] }), { directed: false, reversed: true });
  assert.deepEqual(match({ start: 1, edges: [0, 2, 4, 6, 1] }), { directed: false, reversed: false });
  assert.deepEqual(match({ start: 0, edges: [0, 4, 2, 6, 1] }), { directed: false, reversed: false });
  assert.deepEqual(match({ start: 0, edges: [0, 2, 4, 1] }), { directed: false, reversed: false });
  assert.throws(() => witnessMatcher(graph, { ...witness, currentSectionWalk: [[404, false]] }));
});
