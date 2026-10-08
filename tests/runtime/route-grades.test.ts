import { describe, expect, it } from 'vitest';
import { routeGradeCheck } from '../../src/route-grades.js';
import type { GradeLimits, Position, RouteCandidate, TrailGraph } from '../../src/model.js';

const position = (x: number, y: number, height?: number): Position =>
  [x / 111_195, y / 111_195, ...(height === undefined ? [] : [height])] as Position;

function fixture(trails: { from: number; to: number; coordinates: Position[] }[]) {
  const graph: TrailGraph = {
    version: 1,
    info: { id: 'grades', name: 'Grade fixture', bounds: [0, 0, 1, 1], sourceDate: '2026-01-01',
      attribution: [], limitations: [], startCount: 1 },
    nodes: [], starts: [],
    edges: trails.flatMap(({ from, to }, trail) => [
      { from, to, trail, reverse: false, distance: 0, gain: 0, access: 'public' as const, connector: false },
      { from: to, to: from, trail, reverse: true, distance: 0, gain: 0, access: 'public' as const, connector: false },
    ]),
  };
  const geometry = async function* () {
    for (const [id, { coordinates }] of trails.entries()) yield { id, coordinates };
  };
  const walk = (edges: number[]) => edges.flatMap((id, index) => {
    const edge = graph.edges[id]!;
    const coordinates = [...trails[edge.trail]!.coordinates];
    if (edge.reverse) coordinates.reverse();
    return index ? coordinates.slice(1) : coordinates;
  });
  return { graph, geometry, walk };
}

const route = (edges: number[]): RouteCandidate => ({ id: 'walk', start: 0, edges, distance: 0, gain: 0,
  roadDistance: 0, repetition: 0, kind: 'lollipop', uncertain: false });
const unlimited = (): GradeLimits => ({ uphill: { above: 13, total: 1e6, longest: 1e6 },
  downhill: { above: 19, total: 1e6, longest: 1e6 } });

/** Independent numerical reference: concatenate real coordinates first, measure
 * spherical distance, then sample clipped windows without production helpers. */
function reference(walk: Position[], limits: GradeLimits) {
  const points = walk.map((point, index) => {
    let segment = 0;
    if (index) {
      const previous = walk[index - 1]!;
      const radians = Math.PI / 180;
      const latitude = (point[1] - previous[1]) * radians;
      const longitude = (point[0] - previous[0]) * radians;
      const h = Math.sin(latitude / 2) ** 2 + Math.cos(point[1] * radians)
        * Math.cos(previous[1] * radians) * Math.sin(longitude / 2) ** 2;
      segment = 6_371_008.8 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
    }
    return { segment, height: point[2]! };
  });
  let length = 0;
  const samples = points.map(point => ({ distance: length += point.segment, height: point.height }));
  const height = (distance: number) => {
    const index = samples.findIndex(sample => sample.distance >= distance);
    if (!index) return samples[0]!.height;
    const a = samples[index - 1]!, b = samples[index]!;
    return a.height + (b.height - a.height) * (distance - a.distance) / (b.distance - a.distance);
  };
  const result = { uphill: { total: 0, longest: 0 }, downhill: { total: 0, longest: 0 } };
  const run = { uphill: 0, downhill: 0 };
  const step = length / 40_000;
  for (let i = 0; i < 40_000; i++) {
    const center = (i + 0.5) * step;
    const start = Math.max(0, center - 50), end = Math.min(length, center + 50);
    const grade = 100 * (height(end) - height(start)) / (end - start);
    for (const direction of ['uphill', 'downhill'] as const) {
      if ((direction === 'uphill' ? grade : -grade) > limits[direction].above) {
        result[direction].total += step;
        run[direction] += step;
        result[direction].longest = Math.max(result[direction].longest, run[direction]);
      } else run[direction] = 0;
    }
  }
  return result;
}

describe('route grade constraints', () => {
  it('checks total and longest independently across seams, reverse trails and repeated stems', async () => {
    const a = position(0, 0, 0), b = position(135, 0, 28);
    const c = position(280, 100, 57), d = position(140, 240, 8);
    const network = fixture([
      { from: 0, to: 1, coordinates: [a, position(37, 0, 3), position(37, 0, 3), b] },
      { from: 2, to: 1, coordinates: [c, position(180, 50, 48), b] },
      { from: 2, to: 3, coordinates: [c, position(240, 140, 28), position(190, 190, 31), d] },
      { from: 1, to: 3, coordinates: [b, position(140, 130, 54), d] },
    ]);
    for (const edges of [[0, 3, 4, 7, 1], [0, 6, 5, 2, 1]]) {
      const limits = unlimited();
      const expected = reference(network.walk(edges), limits);
      expect(await routeGradeCheck(network.graph, network.geometry(), limits).then(check => check(route(edges)))).toBe(true);
      for (const direction of ['uphill', 'downhill'] as const) {
        expect(expected[direction].total).toBeGreaterThan(expected[direction].longest + 5);
        for (const field of ['total', 'longest'] as const) {
          for (const margin of [-1, 1]) {
            const constrained = unlimited();
            constrained[direction][field] = expected[direction][field] + margin;
            const check = await routeGradeCheck(network.graph, network.geometry(), constrained);
            expect(check(route(edges)), `${edges}: ${direction} ${field} ${margin}`).toBe(margin > 0);
          }
        }
      }
    }
  });

  it('clips windows to short walks and respects direction when one physical trail is reused', async () => {
    const network = fixture([{ from: 0, to: 1, coordinates: [position(0, 0, 0), position(35, 0, 14)] }]);
    for (const edges of [[0], [1], [0, 1]]) {
      const limits = unlimited();
      const expected = reference(network.walk(edges), limits);
      for (const direction of ['uphill', 'downhill'] as const) {
        const constrained = unlimited();
        constrained[direction].total = expected[direction].total + 0.2;
        const check = await routeGradeCheck(network.graph, network.geometry(), constrained);
        expect(check(route(edges))).toBe(true);
        if (expected[direction].total > 0.2) {
          constrained[direction].total -= 0.4;
          const below = await routeGradeCheck(network.graph, network.geometry(), constrained);
          expect(below(route(edges))).toBe(false);
        }
      }
    }
  });

  it('rejects unknown elevation and reports missing geometry rather than treating it as flat', async () => {
    const network = fixture([{ from: 0, to: 1, coordinates: [position(0, 0, 0), position(50, 0), position(100, 0, 0)] }]);
    const check = await routeGradeCheck(network.graph, network.geometry(), unlimited());
    expect(check(route([0]))).toBe(false);
    expect(check(route([1]))).toBe(false);
    const absent = await routeGradeCheck(network.graph, (async function* () {})(), unlimited());
    expect(() => absent(route([0]))).toThrow(/missing.*geometry/i);
  });
});
