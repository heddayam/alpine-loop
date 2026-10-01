import { expect, it } from 'vitest';
import { createRouteGroups } from '../../src/diversity.js';
import type { RouteCandidate, SearchQuery } from '../../src/model.js';
import { enumerate, fixture } from '../engine/oracle.js';

it('keeps every route option within stable groups and gives emitted reversals one option identity', () => {
  const graph = fixture([
    [0, 1, 3500], // Shared approach.
    [1, 2, 650], [2, 1, 350], [2, 1, 350], // Two different cycle branches.
    [0, 3, 1750], [3, 1, 1750], // A physically separate approach of equal length.
    ...Array.from({ length: 11 }, (): [number, number, number] => [4, 4, 1000]), // Separate physical rings at one start.
    [5, 6, 975], [6, 5, 25], [6, 5, 25], // A small substitution within the same cycle.
  ], [0, 1, 4, 5, 2]);
  graph.starts.push({ ...graph.starts[1]!, id: 'another-source-at-the-same-node' });
  const query: SearchQuery = { area: [-1, -1, 1, 1], distance: [1, 10000], gain: [0, 0], repetition: 0.45, includeUnknown: true };
  const valid = enumerate(graph, query);
  function route(start: number, edges: number[], candidates = valid): RouteCandidate {
    const found = candidates.find(candidate => candidate.start === start && candidate.edges.join(',') === edges.join(','));
    if (!found) throw new Error(`Fixture route must independently satisfy constraints: ${start}/${edges}`);
    return { ...found, id: `${start}/${edges}`, kind: found.repetition ? 'lollipop' : 'loop', uncertain: false };
  }
  const group = createRouteGroups(graph);
  const first = route(0, [0, 2, 4, 1]);
  expect(first).toMatchObject({ distance: 8000, repetition: 0.4375 });
  const firstIdentity = group(first);
  expect(firstIdentity.groupId).toBe(first.id);
  expect(group(route(0, [0, 5, 3, 1]))).toEqual(firstIdentity); // Full reversed walk, same original start.
  expect(group({ ...first, id: 'repeated-emission' })).toEqual(firstIdentity);

  const otherCycle = route(0, [0, 2, 6, 1]);
  const otherCycleIdentity = group(otherCycle);
  expect(otherCycleIdentity.groupId).toBe(otherCycle.id); // Shared long approach must not hide another cycle.
  expect(group(route(0, [0, 7, 3, 1]))).toEqual(otherCycleIdentity);
  const otherApproach = route(0, [8, 10, 2, 4, 11, 9]);
  const otherApproachIdentity = group(otherApproach);
  expect(otherApproachIdentity.groupId).toBe(otherApproach.id);
  expect(group(route(0, [8, 10, 5, 3, 11, 9]))).toEqual(otherApproachIdentity);

  const pureCycle = route(1, [2, 4]);
  const cycleIdentity = group(pureCycle);
  expect(cycleIdentity.groupId).toBe(pureCycle.id); // No approach to peel off.
  expect(group(route(1, [5, 3]))).toEqual(cycleIdentity);
  const otherEntrance = route(4, [4, 2]);
  const entranceIdentity = group(otherEntrance);
  expect(entranceIdentity.groupId).toBe(pureCycle.id);
  expect(entranceIdentity.optionId).not.toBe(cycleIdentity.optionId);
  const sameNodeEntrance = route(5, [2, 4]);
  const sameNodeIdentity = group(sameNodeEntrance);
  expect(sameNodeIdentity.groupId).toBe(pureCycle.id);
  expect(new Set([cycleIdentity.optionId, entranceIdentity.optionId, sameNodeIdentity.optionId]).size).toBe(3);

  // The same option identity is recovered when either direction arrives first.
  const reverseRing = route(2, [13]);
  const ringIdentity = group(reverseRing);
  expect(ringIdentity.groupId).toBe(reverseRing.id);
  expect(group(route(2, [12]))).toEqual(ringIdentity);
  const rings = [ringIdentity.optionId];
  for (let ring = 1; ring < 11; ring++) {
    const next = route(2, [12 + ring * 2]);
    const identity = group(next);
    expect(identity.groupId).toBe(next.id);
    expect(group(route(2, [13 + ring * 2]))).toEqual(identity);
    rings.push(identity.optionId);
  }
  expect(new Set(rings).size).toBe(11);

  const nearFirst = route(3, [34, 36]);
  const nearOther = route(3, [34, 38]);
  const nearIdentity = group(nearFirst);
  expect(nearIdentity.groupId).toBe(nearFirst.id);
  // Both footprints overlap by975/1025 (>85%); the25m substitution remains available.
  const nearOtherIdentity = group(nearOther);
  expect(nearOtherIdentity.groupId).toBe(nearFirst.id);
  expect(nearOtherIdentity.optionId).not.toBe(nearIdentity.optionId);
  expect(group(route(3, [39, 35]))).toEqual(nearOtherIdentity);
  expect(group(first)).toEqual(firstIdentity); // Later options never replace the representative.
  expect(group(otherEntrance)).toEqual(entranceIdentity);

  // This stem puts the square/lollipop overlap at the floating-point 85% boundary.
  // Summing trails in walk order assigned the two lollipop directions to different groups.
  const boundaryGraph = fixture([
    [0, 1, 100.1], [1, 2, 200.2], [2, 3, 300.3], [3, 0, 400.4], [4, 0, 176.64705882352962],
  ], [0, 4]);
  const boundaryRoutes = enumerate(boundaryGraph, query);
  const boundaryGroup = createRouteGroups(boundaryGraph);
  boundaryGroup(route(0, [0, 2, 4, 6], boundaryRoutes));
  const boundaryIdentity = boundaryGroup(route(1, [8, 0, 2, 4, 6, 9], boundaryRoutes));
  expect(boundaryGroup(route(1, [8, 7, 5, 3, 1, 9], boundaryRoutes))).toEqual(boundaryIdentity);
});
