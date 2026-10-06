import { expect, it } from 'vitest';
import { createCircuitBounds, type CircuitBoundEdge } from '../../src/engine/circuit-bounds.js';

/** Independent exhaustive simple-cycle enumeration. It knows nothing about
 * degree bounds or the module's incremental root bookkeeping. */
function longestCircuit(edges: CircuitBoundEdge[], minimumNode = 0): number {
  const nodes = [...new Set(edges.flatMap(edge => [edge.from, edge.to]))].filter(node => node >= minimumNode);
  let longest = 0;
  for (const root of nodes) {
    function walk(node: number, visited: Set<number>, used: Set<number>, length: number) {
      for (const [id, edge] of edges.entries()) {
        if (used.has(id) || edge.from < minimumNode || edge.to < minimumNode || (edge.from !== node && edge.to !== node)) continue;
        const next = edge.from === node ? edge.to : edge.from;
        const total = length + edge.trailDistanceUpper;
        if (next === root) { longest = Math.max(longest, total); continue; }
        if (visited.has(next)) continue;
        walk(next, new Set([...visited, next]), new Set([...used, id]), total);
      }
    }
    walk(root, new Set([root]), new Set(), 0);
  }
  return longest;
}

it('bounds every independent circuit while canonical roots remove vertices, including parallel corridors and self-loops', () => {
  let random = 0x7153;
  const next = () => { random = (Math.imul(random, 1664525) + 1013904223) >>> 0; return random; };
  for (let sample = 0; sample < 40; sample++) {
    const edges = Array.from({ length: 9 }, (): CircuitBoundEdge => ({ from: next() % 6, to: next() % 6, trailDistanceUpper: next() % 30 }));
    const bounds = createCircuitBounds(edges, edges.map((_, id) => id));
    expect(bounds.upper()).toBeGreaterThanOrEqual(longestCircuit(edges));
    let previous = Infinity;
    for (const root of bounds.roots) {
      const value = bounds.upper(root);
      expect(value).toBeGreaterThanOrEqual(longestCircuit(edges, root));
      expect(value).toBeLessThanOrEqual(previous); previous = value;
    }
    // An out-of-order request must not reuse the smaller induced graph's bound.
    expect(bounds.upper(0)).toBeGreaterThanOrEqual(longestCircuit(edges));
  }
});

it('tightens high-degree blocks, counts self-loops twice at their vertex, and includes road-only canonical roots', () => {
  const edges = [
    { from: 0, to: 1, trailDistanceUpper: 100 },
    { from: 0, to: 1, trailDistanceUpper: 90 },
    { from: 0, to: 1, trailDistanceUpper: 80 },
    { from: 0, to: 1, trailDistanceUpper: 70 },
    { from: 2, to: 2, trailDistanceUpper: 50 },
    { from: 3, to: 4, trailDistanceUpper: 0 },
  ];
  const bounds = createCircuitBounds(edges, [0, 1, 2, 3, 4, 5]);
  expect(bounds.roots).toEqual([0, 1, 2, 3, 4]);
  expect(bounds.upper()).toBe(240); // 190 from parallel-node degree caps plus the separate ring.
  expect(bounds.upper(1)).toBe(50);
  expect(bounds.upper(2)).toBe(50);
  expect(bounds.upper(3)).toBe(0);
  expect(bounds.upper(0)).toBe(240);
  expect(bounds.upper()).toBe(240);
});

it('keeps sums exact, disables unsafe or unknown bounds, and can recover after unsafe edges leave the induced graph', () => {
  const huge = Number.MAX_SAFE_INTEGER;
  expect(createCircuitBounds([{ from: 0, to: 0, trailDistanceUpper: huge }], [0]).upper()).toBe(huge);
  expect(createCircuitBounds([{ from: 0, to: 1, trailDistanceUpper: huge },
    { from: 0, to: 1, trailDistanceUpper: huge }], [0, 1]).upper()).toBe(Infinity);
  const bounds = createCircuitBounds([{ from: 0, to: 1, trailDistanceUpper: Infinity },
    { from: 2, to: 2, trailDistanceUpper: 10 }], [0, 1]);
  expect(bounds.upper()).toBe(Infinity);
  expect(bounds.upper(2)).toBe(10);
  expect(bounds.upper(0)).toBe(Infinity);
  expect(createCircuitBounds([{ from: -1, to: 0, trailDistanceUpper: 5 }], [0]).upper()).toBe(Infinity);
  expect(createCircuitBounds([{ from: 0, to: 0, trailDistanceUpper: 1.5 }], [0]).upper()).toBe(Infinity);
});
