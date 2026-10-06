export type CircuitBoundEdge = { from: number; to: number; trailDistanceUpper: number };
type Edge = CircuitBoundEdge & { id: number; valid: boolean };
type Incident = { id: number; weight: number };
type Vertex = { incident: Incident[]; first: number; second: number; mass: bigint };
const maximum = BigInt(Number.MAX_SAFE_INTEGER);
const numeric = (value: bigint) => value <= maximum ? Number(value) : Infinity;
const bound = (trail: bigint, degree: bigint, invalid: number) => invalid ? Infinity
  : Math.min(numeric(trail), numeric((degree + 1n) / 2n));

/** A circuit uses each physical corridor at most once and has degree two at
 * every vertex. Its trail length is therefore bounded by both all trail
 * weights and half the sum of the two largest incident trail weights. A
 * self-loop consumes both slots. Roads have weight zero.
 *
 * Weights must already be whole-meter upper bounds for every legal direction.
 * Exact integer accumulation prevents a floating-point underestimate. A bound
 * beyond safe numeric integers is disabled. Canonical roots normally increase;
 * removing lower vertices updates each corridor and sorted incident slot once. */
export function createCircuitBounds(physical: readonly CircuitBoundEdge[], block: readonly number[]): {
  roots: readonly number[]; upper(root?: number): number;
} {
  const edges: Edge[] = [];
  let uncertainTopology = false;
  for (const id of new Set(block)) {
    const edge = physical[id];
    if (!Number.isSafeInteger(id) || id < 0 || !edge || !Number.isSafeInteger(edge.from) || edge.from < 0
      || !Number.isSafeInteger(edge.to) || edge.to < 0) { uncertainTopology = true; continue; }
    edges.push({ ...edge, id, valid: Number.isSafeInteger(edge.trailDistanceUpper) && edge.trailDistanceUpper >= 0 });
  }
  const roots = [...new Set(edges.flatMap(edge => [edge.from, edge.to]))].sort((a, b) => a - b);
  if (uncertainTopology) return { roots, upper: () => Infinity };
  const incident = new Map<number, Edge[]>();
  const vertices = new Map<number, Vertex>();
  const active = new Set(edges.map(edge => edge.id));
  let trailMass = 0n, degreeMass = 0n, invalid = 0;
  for (const edge of edges) {
    if (!edge.valid) invalid++;
    else trailMass += BigInt(edge.trailDistanceUpper);
    for (const node of new Set([edge.from, edge.to])) {
      const list = incident.get(node) ?? []; list.push(edge); incident.set(node, list);
    }
    if (edge.valid && edge.trailDistanceUpper) for (const node of [edge.from, edge.to]) {
      let vertex = vertices.get(node);
      if (!vertex) { vertex = { incident: [], first: 0, second: 1, mass: 0n }; vertices.set(node, vertex); }
      vertex.incident.push({ id: edge.id, weight: edge.trailDistanceUpper });
    }
  }
  for (const vertex of vertices.values()) {
    vertex.incident.sort((a, b) => b.weight - a.weight || a.id - b.id);
    vertex.mass = BigInt(vertex.incident[0]?.weight ?? 0) + BigInt(vertex.incident[1]?.weight ?? 0);
    degreeMass += vertex.mass;
  }
  const initial = bound(trailMass, degreeMass, invalid);
  let removedRoots = 0, currentRoot = -1;
  function recompute(root: number): number {
    let trail = 0n, degree = 0n;
    const top = new Map<number, [number, number]>();
    for (const edge of edges) if (edge.from >= root && edge.to >= root) {
      if (!edge.valid) return Infinity;
      trail += BigInt(edge.trailDistanceUpper);
      for (const node of [edge.from, edge.to]) {
        const pair = top.get(node) ?? [0, 0];
        if (edge.trailDistanceUpper > pair[0]) { pair[1] = pair[0]; pair[0] = edge.trailDistanceUpper; }
        else if (edge.trailDistanceUpper > pair[1]) pair[1] = edge.trailDistanceUpper;
        top.set(node, pair);
      }
    }
    for (const pair of top.values()) degree += BigInt(pair[0]) + BigInt(pair[1]);
    return bound(trail, degree, 0);
  }
  return {
    roots,
    upper(root?: number): number {
      if (root === undefined) return initial;
      if (!Number.isSafeInteger(root) || root < 0) return Infinity;
      if (root < currentRoot) return recompute(root);
      currentRoot = root;
      while (removedRoots < roots.length && roots[removedRoots]! < root) {
        const removed = roots[removedRoots++]!;
        for (const edge of incident.get(removed) ?? []) {
          if (!active.delete(edge.id)) continue;
          if (!edge.valid) { invalid--; continue; }
          trailMass -= BigInt(edge.trailDistanceUpper);
          for (const node of new Set([edge.from, edge.to])) {
            const vertex = vertices.get(node);
            if (!vertex) continue;
            degreeMass -= vertex.mass;
            while (vertex.first < vertex.incident.length && !active.has(vertex.incident[vertex.first]!.id)) vertex.first++;
            vertex.second = Math.max(vertex.second, vertex.first + 1);
            while (vertex.second < vertex.incident.length && !active.has(vertex.incident[vertex.second]!.id)) vertex.second++;
            vertex.mass = BigInt(vertex.incident[vertex.first]?.weight ?? 0) + BigInt(vertex.incident[vertex.second]?.weight ?? 0);
            degreeMass += vertex.mass;
          }
        }
      }
      return bound(trailMass, degreeMass, invalid);
    },
  };
}
