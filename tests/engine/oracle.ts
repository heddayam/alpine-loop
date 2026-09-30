import type { SearchQuery, TrailEdge, TrailGraph } from '../../src/model.js';

export type OracleRoute = { start: number; edges: number[]; distance: number; gain: number; repetition: number };

/** Tiny-graph reference: choose every simple reversible stem, then every
 * disjoint simple cycle. No production traversal, pruning or metric helpers. */
export function enumerate(graph: TrailGraph, query: SearchQuery): OracleRoute[] {
  const results: OracleRoute[] = [];
  const allowed = (edge: TrailEdge) => edge.access === 'public' || query.includeUnknown !== false;
  const outward = (node: number) => graph.edges.flatMap((edge, index) => edge.from === node && allowed(edge) ? [index] : []);
  for (const [start, entrance] of graph.starts.entries()) {
    const [x, y] = graph.nodes[entrance.node]!;
    if ((!query.includeUnknown && entrance.access === 'unknown')
      || x < query.area[0] || y < query.area[1] || x > query.area[2] || y > query.area[3]) continue;
    const stems = (node: number, stem: number[], back: number[], stemNodes: number[], stemTrails: number[]) => {
      const cycles = (current: number, cycle: number[], cycleNodes: number[], trails: number[]) => {
        for (const index of outward(current)) {
          const edge = graph.edges[index]!;
          if (trails.includes(edge.trail)) continue;
          if (edge.to === node) {
            const edges = [...stem, ...cycle, index, ...back];
            const distance = edges.reduce((total, id) => total + graph.edges[id]!.distance, 0);
            const gain = edges.reduce((total, id) => total + graph.edges[id]!.gain, 0);
            const repetition = back.reduce((total, id) => total + graph.edges[id]!.distance, 0) / distance;
            if (distance >= query.distance[0] && distance <= query.distance[1]
              && gain >= query.gain[0] && gain <= query.gain[1] && repetition <= query.repetition) {
              results.push({ start, edges, distance, gain, repetition });
            }
          } else if (!stemNodes.includes(edge.to) && !cycleNodes.includes(edge.to)) {
            cycles(edge.to, [...cycle, index], [...cycleNodes, edge.to], [...trails, edge.trail]);
          }
        }
      };
      cycles(node, [], [node], stemTrails);
      for (const index of outward(node)) {
        const edge = graph.edges[index]!;
        if (stemNodes.includes(edge.to) || stemTrails.includes(edge.trail)) continue;
        for (const backIndex of outward(edge.to)) {
          const reverse = graph.edges[backIndex]!;
          if (reverse.trail !== edge.trail || reverse.to !== node || reverse.reverse === edge.reverse) continue;
          stems(edge.to, [...stem, index], [backIndex, ...back], [...stemNodes, edge.to], [...stemTrails, edge.trail]);
        }
      }
    };
    stems(entrance.node, [], [], [entrance.node], []);
  }
  return results;
}

type Trail = [from: number, to: number, distance: number, options?: {
  oneWay?: boolean; gain?: number; backGain?: number; backDistance?: number; unknown?: boolean;
}];

export function fixture(trails: Trail[], starts = [0]): TrailGraph {
  const count = Math.max(...trails.flatMap(([from, to]) => [from, to]), ...starts) + 1;
  return {
    version: 1,
    info: { id: 'oracle', name: 'Oracle', bounds: [-1, -1, 1, 1], sourceDate: '2026-01-01',
      attribution: [], limitations: [], places: [], startCount: starts.length },
    nodes: Array.from({ length: count }, (_, index) => [index / 100, 0]),
    starts: starts.map(node => ({ id: `start-${node}`, node, name: `Start ${node}`, access: 'public' })),
    edges: trails.flatMap(([from, to, distance, options = {}], trail): TrailEdge[] => {
      const access = options.unknown ? 'unknown' : 'public';
      const forward: TrailEdge = { from, to, distance, trail, reverse: false, gain: options.gain ?? 0, access };
      return options.oneWay ? [forward] : [forward, {
        from: to, to: from, distance: options.backDistance ?? distance, trail, reverse: true,
        gain: options.backGain ?? 0, access,
      }];
    }),
  };
}
