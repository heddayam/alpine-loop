import type { SearchQuery, TrailEdge, TrailGraph } from '../../src/model.js';
import { createHash } from 'node:crypto';

export type OracleRoute = { start: number; edges: number[]; distance: number; gain: number; roadDistance: number; repetition: number };

/** Linear independent witness validation for graphs too large to enumerate.
 * Locate the first repeated vertex, then require the exact reversed stem. */
export function measure(graph: TrailGraph, query: SearchQuery, start: number, edges: number[]): OracleRoute | undefined {
  const entrance = graph.starts[start];
  if (!entrance || (!query.includeUnknown && entrance.access !== 'public') || !edges.length) return;
  const walk = edges.map(id => graph.edges[id]);
  if (walk.some(edge => !edge || (!query.includeUnknown && edge.access !== 'public'))) return;
  if (!walk.some(edge => !edge!.connector)) return;
  const nodes = [entrance.node];
  for (const edge of walk) { if (edge!.from !== nodes.at(-1)) return; nodes.push(edge!.to); }
  if (nodes.at(-1) !== entrance.node) return;
  let attachment = -1, closure = -1;
  const firstVisit = new Map([[entrance.node, 0]]);
  for (let at = 1; at < nodes.length; at++) {
    const prior = firstVisit.get(nodes[at]!);
    if (prior !== undefined) { attachment = prior; closure = at; break; }
    firstVisit.set(nodes[at]!, at);
  }
  if (closure <= attachment || closure + attachment !== edges.length) return;
  const circuit = walk.slice(attachment, closure);
  if (new Set(circuit.map(edge => edge!.trail)).size !== circuit.length) return;
  for (let at = 0; at < attachment; at++) {
    const outward = walk[attachment - 1 - at]!, back = walk[closure + at]!;
    if (outward.trail !== back.trail || outward.from !== back.to || outward.to !== back.from || outward.reverse === back.reverse) return;
  }
  const distance = walk.reduce((sum, edge) => sum + edge!.distance, 0);
  const gain = walk.reduce((sum, edge) => sum + edge!.gain, 0);
  const roadDistance = walk.reduce((sum, edge) => sum + (edge!.connector ? edge!.distance : 0), 0);
  const repetition = walk.slice(closure).reduce((sum, edge) => sum + edge!.distance, 0) / distance;
  const roads = query.roads ?? { distance: 1609.344, fraction: 0.1 };
  if (distance < query.distance[0] || distance > query.distance[1] || gain < query.gain[0] || gain > query.gain[1]
    || repetition > query.repetition || roadDistance > roads.distance || roadDistance / distance > roads.fraction) return;
  return { start, edges, distance, gain, roadDistance, repetition };
}

/** Tiny-graph reference: choose every simple reversible stem, then every
 * disjoint simple cycle. No production traversal, pruning or metric helpers. */
export function enumerate(graph: TrailGraph, query: SearchQuery): OracleRoute[] {
  const results: OracleRoute[] = [];
  const roads = query.roads ?? { distance: 1609.344, fraction: 0.1 };
  const allowed = (edge: TrailEdge) => edge.access === 'public' || query.includeUnknown !== false;
  const outward = (node: number) => graph.edges.flatMap((edge, index) => edge.from === node && allowed(edge) ? [index] : []);
  for (const [start, entrance] of graph.starts.entries()) {
    if (!query.includeUnknown && entrance.access === 'unknown') continue;
    const stems = (node: number, stem: number[], back: number[], stemNodes: number[], stemTrails: number[]) => {
      const cycles = (current: number, cycle: number[], cycleNodes: number[], trails: number[]) => {
        for (const index of outward(current)) {
          const edge = graph.edges[index]!;
          if (trails.includes(edge.trail)) continue;
          if (edge.to === node) {
            const edges = [...stem, ...cycle, index, ...back];
            const distance = edges.reduce((total, id) => total + graph.edges[id]!.distance, 0);
            const gain = edges.reduce((total, id) => total + graph.edges[id]!.gain, 0);
            const roadDistance = edges.filter(id => graph.edges[id]!.connector).reduce((total, id) => total + graph.edges[id]!.distance, 0);
            const repetition = back.reduce((total, id) => total + graph.edges[id]!.distance, 0) / distance;
            if (distance >= query.distance[0] && distance <= query.distance[1]
              && gain >= query.gain[0] && gain <= query.gain[1] && repetition <= query.repetition
              && roadDistance <= roads.distance && roadDistance / distance <= roads.fraction) {
              results.push({ start, edges, distance, gain, roadDistance, repetition });
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
  oneWay?: boolean; gain?: number; backGain?: number; backDistance?: number; unknown?: boolean; connector?: boolean;
}];

export function fixture(trails: Trail[], starts = [0]): TrailGraph {
  const count = Math.max(...trails.flatMap(([from, to]) => [from, to]), ...starts) + 1;
  return {
    version: 1,
    info: { id: 'oracle', name: 'Oracle', bounds: [-1, -1, 1, 1], sourceDate: '2026-01-01',
      attribution: [], limitations: [], startCount: starts.length },
    nodes: Array.from({ length: count }, (_, index) => [index / 100, 0]),
    starts: starts.map(node => ({ id: `start-${node}`, node, name: `Start ${node}`, access: 'public', kind: 'trailhead' })),
    edges: trails.flatMap(([from, to, distance, options = {}], trail): TrailEdge[] => {
      const access = options.unknown ? 'unknown' : 'public';
      const connector = options.connector ?? false;
      const forward: TrailEdge = { from, to, distance, trail, reverse: false, gain: options.gain ?? 0, access, connector };
      return options.oneWay ? [forward] : [forward, {
        from: to, to: from, distance: options.backDistance ?? distance, trail, reverse: true,
        gain: options.backGain ?? 0, access, connector,
      }];
    }),
  };
}

/** Deliberately quadratic reference for road normalization on tiny graphs. The
 * shorter witness is checked before lower limits, independently of the solver. */
export function normalized(graph: TrailGraph, query: SearchQuery): OracleRoute[] {
  const upperFeasible = enumerate(graph, { ...query, distance: [0, query.distance[1]], gain: [0, query.gain[1]] })
    .filter(route => route.edges.some(id => !graph.edges[id]!.connector));
  const itinerary = (route: OracleRoute) => JSON.stringify([route.start, route.edges.filter(id => !graph.edges[id]!.connector)
    .map(id => [graph.edges[id]!.trail, graph.edges[id]!.reverse])]);
  const uncertain = (route: OracleRoute) => graph.starts[route.start]!.access === 'unknown'
    || route.edges.some(id => graph.edges[id]!.access === 'unknown');
  return upperFeasible.filter(route => route.distance >= query.distance[0] && route.gain >= query.gain[0]
    && !upperFeasible.some(other => itinerary(other) === itinerary(route) && other.roadDistance < route.roadDistance
      && (!uncertain(other) || uncertain(route))));
}

export type OracleFamily = { seed: number[]; route: OracleRoute };

/** Exhaustive output reference. Select each circuit's route first, then assign
 * it to the most similar fixed displayed route. No production grouping helpers. */
export function distinct(graph: TrailGraph, query: SearchQuery): OracleFamily[] {
  return groupPool(graph, normalized(graph, query));
}

/** Group only an explicitly supplied, independently validated discovery pool.
 * Missing candidates affect recall, rather than the legality of kept hikes. */
export function groupPool(graph: TrailGraph, paths: OracleRoute[]): OracleFamily[] {
  const compare = (a: number[], b: number[]) => {
    for (let at = 0; at < Math.min(a.length, b.length); at++) if (a[at] !== b[at]) return a[at]! - b[at]!;
    return a.length - b.length;
  };
  const cyclic = (values: number[]) => {
    const rotations = values.flatMap((_, at) => {
      const order = [...values.slice(at), ...values.slice(0, at)];
      return [order, order.toReversed()];
    });
    return rotations.sort(compare)[0] ?? [];
  };
  const core = (route: OracleRoute) => {
    let lo = 0, hi = route.edges.length - 1;
    while (lo < hi && graph.edges[route.edges[lo]!]!.trail === graph.edges[route.edges[hi]!]!.trail) { lo++; hi--; }
    const edges = route.edges.slice(lo, hi + 1).map(id => graph.edges[id]!);
    return { edges, key: cyclic(edges.map(edge => edge.trail)) };
  };
  type Member = ReturnType<typeof core>;
  const circuits = paths.map(core).filter((item, at, all) => all.findIndex(other => !compare(item.key, other.key)) === at).sort((a, b) => compare(a.key, b.key));
  const physical = (trail: number) => graph.edges.find(edge => edge.trail === trail && !edge.reverse)
    ?? graph.edges.find(edge => edge.trail === trail)!;
  const length = (trails: number[]) => [...new Set(trails)].sort((a, b) => a - b).reduce((sum, trail) => sum + physical(trail).distance, 0);
  const similarity = (a: Member, b: Member) => {
    const common = a.key.filter(trail => b.key.includes(trail));
    if (compare(cyclic(common), cyclic(b.key.filter(trail => common.includes(trail))))) return 0;
    return length(common) / Math.max(length(a.key), length(b.key));
  };
  const walk = (route: OracleRoute, reverse = false) => JSON.stringify([graph.starts[route.start]!.id,
    (reverse ? route.edges.toReversed() : route.edges).map(id => [graph.edges[id]!.trail, reverse ? !graph.edges[id]!.reverse : graph.edges[id]!.reverse])]);
  const uncertain = (route: OracleRoute) => graph.starts[route.start]!.access === 'unknown'
    || route.edges.some(id => graph.edges[id]!.access === 'unknown');
  const quality = (a: OracleRoute, b: OracleRoute) => {
    for (const delta of [Number(uncertain(a)) - Number(uncertain(b)), a.roadDistance - b.roadDistance,
      a.repetition - b.repetition, a.distance - b.distance]) if (delta) return delta;
    const pair = (route: OracleRoute) => [walk(route), walk(route, true)].sort()[0]!;
    const id = (route: OracleRoute) => createHash('sha256').update(walk(route)).digest('hex');
    return pair(a).localeCompare(pair(b)) || id(a).localeCompare(id(b));
  };
  const rank = { trailhead: 0, parking: 1, 'road-contact': 2 };
  const preference = (a: { route: OracleRoute }, b: { route: OracleRoute }) => rank[graph.starts[a.route.start]!.kind] - rank[graph.starts[b.route.start]!.kind]
    || quality(a.route, b.route) || graph.starts[a.route.start]!.id.localeCompare(graph.starts[b.route.start]!.id);
  const versions = circuits.map(member => {
    const choices = paths.filter(route => !compare(core(route).key, member.key)).map(route => ({ route }));
    choices.sort(preference);
    return { member, route: choices[0]!.route };
  }).sort((a, b) => preference(a, b) || compare(a.member.key, b.member.key));
  const groups: { representative: Member; route: OracleRoute }[] = [];
  for (const version of versions) {
    if (!groups.some(group => similarity(version.member, group.representative) >= 0.6)) groups.push({ representative: version.member, route: version.route });
  }
  return groups.map(group => ({ seed: group.representative.key, route: group.route }));
}
