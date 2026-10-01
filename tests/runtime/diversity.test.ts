import { expect, it } from 'vitest';
import { createDiversityFilter } from '../../src/diversity.js';
import type { RouteCandidate, SearchQuery } from '../../src/model.js';
import { enumerate, fixture } from '../engine/oracle.js';

it('keeps diverse cycles and approaches while grouping reversals and alternative starts', () => {
  const graph = fixture([
    [0, 1, 3500], // Shared approach.
    [1, 2, 650], [2, 1, 350], [2, 1, 350], // Two different cycle branches.
    [0, 3, 1750], [3, 1, 1750], // A physically separate approach of equal length.
    ...Array.from({ length: 11 }, (): [number, number, number] => [4, 4, 1000]), // Separate physical rings at one start.
    [5, 6, 975], [6, 5, 25], [6, 5, 25], // A small substitution within the same cycle.
  ], [0, 1, 4, 5, 2]);
  const query: SearchQuery = { area: [-1, -1, 1, 1], distance: [1, 10000], gain: [0, 0], repetition: 0.45, includeUnknown: true };
  const valid = enumerate(graph, query);
  function route(start: number, edges: number[]): RouteCandidate {
    const found = valid.find(candidate => candidate.start === start && candidate.edges.join(',') === edges.join(','));
    if (!found) throw new Error(`Fixture route must independently satisfy constraints: ${start}/${edges}`);
    return { ...found, id: `${start}/${edges}`, kind: found.repetition ? 'lollipop' : 'loop', uncertain: false };
  }
  const choose = createDiversityFilter(graph);
  const first = route(0, [0, 2, 4, 1]);
  expect(first).toMatchObject({ distance: 8000, repetition: 0.4375 });
  expect(choose(first)).toBe(true);
  expect(choose(route(0, [0, 5, 3, 1]))).toBe(false); // Same route, reverse cycle.
  expect(choose(route(0, [0, 2, 6, 1]))).toBe(true); // Shared approach must not hide the other cycle.
  expect(choose(route(0, [0, 7, 3, 1]))).toBe(false);
  expect(choose(route(0, [8, 10, 2, 4, 11, 9]))).toBe(true); // Same cycle, different approach.
  expect(choose(route(0, [8, 10, 5, 3, 11, 9]))).toBe(false);
  expect(choose(route(1, [2, 4]))).toBe(true); // No approach to peel off.
  expect(choose(route(1, [5, 3]))).toBe(false);
  expect(choose(route(4, [4, 2]))).toBe(false); // Same physical circuit, another entrance.
  expect(choose(route(2, [12]))).toBe(true); // A one-edge ring is still a cycle.
  expect(choose(route(2, [13]))).toBe(false);

  for (let ring = 1; ring < 10; ring++) expect(choose(route(2, [12 + ring * 2]))).toBe(true);
  expect(choose(route(2, [32]))).toBe(true); // An eleventh physically distinct route remains browsable.
  expect(choose(route(2, [33]))).toBe(false); // Its reverse still adds no physical choice.
  expect(choose(route(3, [34, 36]))).toBe(true);
  expect(choose(route(3, [34, 38]))).toBe(false); // Both footprints overlap by 975 / 1025 (>85%).
});
