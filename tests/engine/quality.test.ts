import { expect, it } from 'vitest';
import { canonical } from '../../src/engine/quality.js';

it('gives a physical circuit the same numeric identity at every start and in either direction', () => {
  const trails = [10, 3, 2];
  for (let at = 0; at < trails.length; at++) {
    const rotated = [...trails.slice(at), ...trails.slice(0, at)];
    expect(canonical(rotated)).toEqual([2, 3, 10]);
    expect(canonical(rotated.toReversed())).toEqual([2, 3, 10]);
  }
  expect(trails).toEqual([10, 3, 2]);
  expect(canonical([])).toEqual([]);
  expect(canonical([10])).toEqual([10]);
  expect(canonical([10, 2])).toEqual([2, 10]);
});

it('keeps circuits with different trail order distinct even when they use the same trails', () => {
  expect(canonical([2, 3, 10, 20])).not.toEqual(canonical([2, 10, 3, 20]));
});
