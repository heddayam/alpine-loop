import assert from 'node:assert/strict';
import test from 'node:test';
import { witnessMatcher } from './run-engine.mjs';

test('witness recovery requires the original start and ordered source edges, with reverse reported separately', () => {
  const graph = { starts: [{ id: 'A' }, { id: 'B' }], edges: [
    { trail: 0, reverse: false }, { trail: 0, reverse: true },
    { trail: 1, reverse: false }, { trail: 1, reverse: true },
    { trail: 2, reverse: false }, { trail: 2, reverse: true },
    { trail: 3, reverse: false }, { trail: 3, reverse: true },
  ] };
  const sourceIndex = { edgeIds: ['af', 'ar', 'bf', 'br', 'cf', 'cr', 'df', 'dr'] };
  const match = witnessMatcher(graph, sourceIndex, { startId: 'A', edgeIds: ['af', 'bf', 'cf', 'df', 'ar'] });
  assert.deepEqual(match({ start: 0, edges: [0, 2, 4, 6, 1] }), { directed: true, reversed: false });
  assert.deepEqual(match({ start: 0, edges: [0, 7, 5, 3, 1] }), { directed: false, reversed: true });
  assert.deepEqual(match({ start: 1, edges: [0, 2, 4, 6, 1] }), { directed: false, reversed: false });
  assert.deepEqual(match({ start: 0, edges: [0, 4, 2, 6, 1] }), { directed: false, reversed: false });
  assert.deepEqual(match({ start: 0, edges: [0, 2, 4, 1] }), { directed: false, reversed: false });
  assert.throws(() => witnessMatcher(graph, sourceIndex, { startId: 'A', edgeIds: ['missing'] }));
});
