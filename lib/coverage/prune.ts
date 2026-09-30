import type { DatabaseSync } from "node:sqlite";

export const PRUNING_ALGORITHM_VERSION = "mountain-approach-undirected-distance-v4";

type DistanceGraph = {
  from: Uint32Array; to: Uint32Array; length: Float64Array; best: Float64Array;
  nodes: number; segments: number; seeds: number; estimatedBytes: number;
  radius: number; tolerance: number;
};

/** Each pass owns disposable CSR arrays and an indexed heap. The consumer writes
 * only its small result and SQLite membership tables; no graph state escapes.
 * Ignoring direction produces an admissible lower bound for closed routes.
 */
async function withGraphDistances<T>(db: DatabaseSync, maximumMeters: number,
  checkpoint: () => Promise<void>, memoryBudgetBytes: number, qualification: boolean,
  consume: (graph: DistanceGraph) => Promise<T>): Promise<T> {
  await checkpoint();
  const selected = qualification ? "WHERE approach_link=1" : "";
  db.exec(`CREATE TEMP TABLE pruning_nodes(id TEXT PRIMARY KEY,k INTEGER UNIQUE);
    INSERT INTO pruning_nodes(id) SELECT from_node FROM eligible_segments ${selected}
      UNION SELECT to_node FROM eligible_segments ${selected};
    UPDATE pruning_nodes SET k=rowid-1;`);
  try {
    const nodes = Number(db.prepare("SELECT count(*) AS n FROM pruning_nodes").get()!.n);
    const segments = Number(db.prepare(`SELECT count(*) AS n FROM eligible_segments ${selected}`).get()!.n);
    const estimatedBytes = nodes * 40 + segments * 32 + 8 * 1024 ** 2;
    if (estimatedBytes > memoryBudgetBytes || nodes >= 2 ** 31 || segments >= 2 ** 31)
      throw new Error(`Region graph exceeds pruning memory budget: ${nodes} nodes, ${segments} segments need about ${estimatedBytes} bytes; budget ${memoryBudgetBytes}`);
    if (!segments && !qualification) throw new Error("No eligible walking links occur inside this route buffer");
    let work = 0;
    const from = new Uint32Array(segments), to = new Uint32Array(segments), length = new Float64Array(segments);
    const offsets = new Uint32Array(nodes + 1), best = new Float64Array(nodes).fill(Infinity);
    const heap = new Uint32Array(nodes), position = new Int32Array(nodes).fill(-1);
    let size = 0;
    const less = (a: number, b: number) => best[a]! < best[b]! || (best[a] === best[b] && a < b);
    const swap = (a: number, b: number) => { const value = heap[a]!; heap[a] = heap[b]!; heap[b] = value; position[heap[a]!] = a; position[value] = b; };
    const offer = (node: number) => {
      let at = position[node]!;
      if (at < 0) { at = size++; heap[at] = node; position[node] = at; }
      while (at > 0) { const parent = (at - 1) >>> 1; if (!less(heap[at]!, heap[parent]!)) break; swap(at, parent); at = parent; }
    };
    const pop = () => {
      const value = heap[0]!; position[value] = -1; size--;
      if (size) {
        heap[0] = heap[size]!; position[heap[0]!] = 0;
        for (let at = 0;;) {
          let next = at * 2 + 1; if (next >= size) break;
          if (next + 1 < size && less(heap[next + 1]!, heap[next]!)) next++;
          if (!less(heap[next]!, heap[at]!)) break; swap(at, next); at = next;
        }
      }
      return value;
    };
    let index = 0;
    for (const row of db.prepare(`SELECT a.k AS a,b.k AS b,e.length_m FROM eligible_segments e
      JOIN pruning_nodes a ON a.id=e.from_node JOIN pruning_nodes b ON b.id=e.to_node ${selected} ORDER BY e.id`).iterate()) {
      if (++work % 1000 === 0) await checkpoint();
      const a = Number(row.a), b = Number(row.b), meters = Number(row.length_m);
      if (!Number.isFinite(meters) || meters < 0) throw new Error("Invalid segment distance bound");
      from[index] = a; to[index] = b; length[index++] = meters;
      offsets[a + 1]++; offsets[b + 1]++;
    }
    for (let node = 1; node <= nodes; node++) offsets[node] += offsets[node - 1]!;
    const adjacency = new Uint32Array(segments * 2), cursor = offsets.slice(0, nodes);
    for (let edge = 0; edge < segments; edge++) { adjacency[cursor[from[edge]!]++] = edge; adjacency[cursor[to[edge]!]++] = edge; }
    const seedQuery = qualification
      ? `SELECT p.k FROM pruning_nodes p WHERE p.id IN (
          SELECT from_node FROM eligible_segments WHERE approach_link=1 AND core_hiking=1
          UNION SELECT to_node FROM eligible_segments WHERE approach_link=1 AND core_hiking=1) ORDER BY p.k`
      : "SELECT p.k FROM pruning_nodes p JOIN sparse_start_nodes s ON s.node_id=p.id ORDER BY p.k";
    let seeds = 0;
    for (const row of db.prepare(seedQuery).iterate()) {
      if (++work % 1000 === 0) await checkpoint();
      const k = Number(row.k); best[k] = 0; offer(k); seeds++;
    }
    const tolerance = Math.max(0.01, maximumMeters * 1e-9), radius = maximumMeters / 2 + tolerance;
    while (size) {
      if (++work % 1000 === 0) await checkpoint();
      const node = pop(), distance = best[node]!;
      for (let at = offsets[node]!; at < offsets[node + 1]!; at++) {
        const edge = adjacency[at]!, next = from[edge] === node ? to[edge]! : from[edge]!, candidate = distance + length[edge]!;
        if (candidate <= radius && candidate < best[next]!) { best[next] = candidate; offer(next); }
      }
    }
    return await consume({from, to, length, best, nodes, segments, seeds, estimatedBytes, radius, tolerance});
  } finally { db.exec("DROP TABLE pruning_nodes"); }
}

/** Freeze candidates connected to this mountain core through hiking/possible
 * walking links. Ordinary roads remain available for the later routing pass.
 */
export async function qualifyMountainStarts(db: DatabaseSync, maximumMeters: number,
  checkpoint: () => Promise<void>, memoryBudgetBytes: number) {
  return withGraphDistances(db, maximumMeters, checkpoint, memoryBudgetBytes, true, async graph => {
    db.exec("CREATE TEMP TABLE terrain_excluded_start_nodes(node_id TEXT PRIMARY KEY) STRICT");
    const exclude = db.prepare("INSERT INTO terrain_excluded_start_nodes VALUES (?)");
    let work = 0, terrainExcludedAccessPoints = 0, seeds = 0;
    for (const row of db.prepare(`SELECT s.node_id,p.k FROM sparse_start_nodes s LEFT JOIN pruning_nodes p ON p.id=s.node_id`).iterate()) {
      if (++work % 1000 === 0) await checkpoint();
      if (row.k === null || graph.best[Number(row.k)]! > graph.radius) {
        exclude.run(row.node_id); terrainExcludedAccessPoints++;
      } else seeds++;
    }
    db.exec("DELETE FROM sparse_start_nodes WHERE node_id IN (SELECT node_id FROM terrain_excluded_start_nodes)");
    // Preserve the audit, but never resurrect an excluded candidate at ranking.
    const hasPrepared = db.prepare("SELECT 1 FROM sqlite_temp_master WHERE name='sparse_portal_candidates'").get();
    if (hasPrepared) db.exec("DELETE FROM sparse_portal_candidates WHERE node_id IN (SELECT node_id FROM terrain_excluded_start_nodes)");
    if (!seeds) throw new Error("No eligible access points connect to mountain hiking trails within the route distance");
    return {candidateNodes: graph.nodes, candidateSegments: graph.segments, seedNodes: seeds,
      terrainExcludedAccessPoints, pruningArrayBudgetBytes: graph.estimatedBytes};
  });
}

/** Remove only segments that cannot belong to a bounded closed route from the
 * frozen starts, including ordinary roads and routes heading away from the core.
 */
export async function pruneWalkingGraph(db: DatabaseSync, maximumMeters: number,
  checkpoint: () => Promise<void>, memoryBudgetBytes: number) {
  return withGraphDistances(db, maximumMeters, checkpoint, memoryBudgetBytes, false, async graph => {
    if (!graph.seeds) throw new Error("No eligible access points connect to the selected region");
    // Do not modify the table driving the iterator.
    db.exec("CREATE TEMP TABLE retained_segments(id TEXT PRIMARY KEY) STRICT");
    let retained = 0;
    try {
      const insert = db.prepare("INSERT INTO retained_segments VALUES (?)");
      let index = 0;
      for (const row of db.prepare("SELECT id FROM eligible_segments ORDER BY id").iterate()) {
        if (index % 1000 === 0) await checkpoint();
        const a = graph.from[index]!, b = graph.to[index]!;
        if (graph.best[a]! <= graph.radius && graph.best[b]! <= graph.radius &&
          graph.best[a]! + graph.length[index]! + graph.best[b]! <= maximumMeters + graph.tolerance) { insert.run(row.id); retained++; }
        index++;
      }
      db.exec("DELETE FROM eligible_segments WHERE id NOT IN (SELECT id FROM retained_segments)");
    } finally { db.exec("DROP TABLE retained_segments"); }
    if (!retained) throw new Error("No eligible walking links connect to the selected region");
    return {candidateNodes: graph.nodes, candidateSegments: graph.segments, seedNodes: graph.seeds,
      retainedSegments: retained, pruningArrayBudgetBytes: graph.estimatedBytes};
  });
}
