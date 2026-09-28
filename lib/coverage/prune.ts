import type { DatabaseSync } from "node:sqlite";
import { areaGeometryBounds, type AreaGeometry } from "@/lib/data/area-geometry";
import { coordinateIsInsideArea } from "@/lib/graph/geometry";

export const PRUNING_ALGORITHM_VERSION = "undirected-multi-source-distance-v1";

/** Remove only segments that cannot belong to a closed route within the bound.
 * All core trail nodes seed the lower bound, independently of portal discovery.
 * Ignoring direction/access uncertainty only admits extra segments. Indexed heap
 * and CSR arrays have fixed sizes; no graph-sized JS objects or duplicate queue.
 */
export async function pruneWalkingGraph(db: DatabaseSync, starts: AreaGeometry, maximumMeters: number,
  checkpoint: () => Promise<void>, memoryBudgetBytes: number) {
  await checkpoint();
  db.exec(`CREATE TEMP TABLE pruning_nodes(id TEXT PRIMARY KEY,k INTEGER UNIQUE);
    INSERT INTO pruning_nodes(id) SELECT from_node FROM eligible_segments UNION SELECT to_node FROM eligible_segments;
    UPDATE pruning_nodes SET k=rowid-1;`);
  const nodes = Number(db.prepare("SELECT count(*) AS n FROM pruning_nodes").get()!.n);
  const segments = Number(db.prepare("SELECT count(*) AS n FROM eligible_segments").get()!.n);
  const estimatedBytes = nodes * 40 + segments * 32 + 8 * 1024 ** 2;
  if (estimatedBytes > memoryBudgetBytes || nodes >= 2 ** 31 || segments >= 2 ** 31)
    throw new Error(`Region graph exceeds pruning memory budget: ${nodes} nodes, ${segments} segments need about ${estimatedBytes} bytes; budget ${memoryBudgetBytes}`);
  if (!segments) throw new Error("No eligible walking links occur inside this route buffer");
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
  let seeds = 0;
  const [west,south,east,north] = areaGeometryBounds(starts);
  for (const row of db.prepare(`SELECT p.k,n.lon,n.lat FROM pruning_nodes p JOIN nodes n ON n.id=p.id
    WHERE n.lon>=? AND n.lon<=? AND n.lat>=? AND n.lat<=? ORDER BY p.k`).iterate(west,east,south,north)) {
    if (++work % 1000 === 0) await checkpoint();
    if (coordinateIsInsideArea([Number(row.lon), Number(row.lat)], starts)) { const k = Number(row.k); best[k] = 0; offer(k); seeds++; }
  }
  let index = 0;
  for (const row of db.prepare(`SELECT a.k AS a,b.k AS b,e.length_m FROM eligible_segments e
    JOIN pruning_nodes a ON a.id=e.from_node JOIN pruning_nodes b ON b.id=e.to_node ORDER BY e.id`).iterate()) {
    if (++work % 1000 === 0) await checkpoint();
    const a = Number(row.a), b = Number(row.b), meters = Number(row.length_m);
    if (!Number.isFinite(meters) || meters < 0) throw new Error("Invalid segment distance bound");
    from[index] = a; to[index] = b; length[index++] = meters;
    offsets[a + 1]++; offsets[b + 1]++;
  }
  for (let node = 1; node <= nodes; node++) offsets[node] += offsets[node - 1]!;
  const adjacency = new Uint32Array(segments * 2), cursor = offsets.slice(0, nodes);
  for (let edge = 0; edge < segments; edge++) { adjacency[cursor[from[edge]!]++] = edge; adjacency[cursor[to[edge]!]++] = edge; }
  const tolerance = Math.max(0.01, maximumMeters * 1e-9), radius = maximumMeters / 2 + tolerance;
  while (size) {
    if (++work % 1000 === 0) await checkpoint();
    const node = pop(), distance = best[node]!;
    for (let at = offsets[node]!; at < offsets[node + 1]!; at++) {
      const edge = adjacency[at]!, next = from[edge] === node ? to[edge]! : from[edge]!, candidate = distance + length[edge]!;
      if (candidate <= radius && candidate < best[next]!) { best[next] = candidate; offer(next); }
    }
  }
  // Write a separate membership table: never modify the table driving the iterator.
  db.exec("CREATE TEMP TABLE retained_segments(id TEXT PRIMARY KEY) STRICT");
  const insert = db.prepare("INSERT INTO retained_segments VALUES (?)");
  index = 0; let retained = 0;
  for (const row of db.prepare("SELECT id FROM eligible_segments ORDER BY id").iterate()) {
    if (++work % 1000 === 0) await checkpoint();
    const a = from[index]!, b = to[index]!;
    if (best[a]! <= radius && best[b]! <= radius && best[a]! + length[index]! + best[b]! <= maximumMeters + tolerance) { insert.run(row.id); retained++; }
    index++;
  }
  db.exec("DELETE FROM eligible_segments WHERE id NOT IN (SELECT id FROM retained_segments); DROP TABLE retained_segments; DROP TABLE pruning_nodes");
  if (!retained) throw new Error("No eligible walking links connect to the selected region");
  return { candidateNodes: nodes, candidateSegments: segments, seedNodes: seeds, retainedSegments: retained, pruningArrayBudgetBytes: estimatedBytes };
}
