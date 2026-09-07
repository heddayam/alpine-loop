import type { EdgeTraversal } from "@/lib/graph";

export function physicalKeyOf(edge: EdgeTraversal["edge"]): string {
  if (edge.physicalEdgeKey !== undefined) return `physical:${edge.physicalEdgeKey}`;
  const forward = edge.coordinates.map(([lon, lat]) => `${lon},${lat}`).join(";");
  const reverse = [...edge.coordinates].reverse().map(([lon, lat]) => `${lon},${lat}`).join(";");
  return `legacy:${forward < reverse ? forward : reverse}:${edge.lengthMeters}`;
}

/** Keep choices and the start; retain every original directed edge for reconstruction. */
export function contractCorridors(traversals: readonly EdgeTraversal[], startNodeId: string): EdgeTraversal[][] {
  const outgoing = new Map<string, number[]>();
  const incoming = new Map<string, number[]>();
  const physical = traversals.map(({ edge }) => physicalKeyOf(edge));
  for (const [index, { from, to }] of traversals.entries()) {
    const out = outgoing.get(from.id) ?? [];
    out.push(index);
    outgoing.set(from.id, out);
    const back = incoming.get(to.id) ?? [];
    back.push(index);
    incoming.set(to.id, back);
  }
  const continuation = new Int32Array(traversals.length).fill(-1);
  for (const [node, ins] of incoming) {
    if (node === startNodeId) continue;
    const outs = outgoing.get(node) ?? [];
    const incident = new Set([...ins, ...outs].map((index) => physical[index]!));
    if (incident.size !== 2 || ins.some((index) => traversals[index]!.from.id === node)) continue;
    const other = (edges: readonly number[], index: number) => edges.filter((edge) => physical[edge] !== physical[index]);
    // A one-way transition is a choice: never merge it into a reversible corridor.
    if (!ins.every((index) => other(outs, index).length === 1)
      || !outs.every((index) => other(ins, index).length === 1)) continue;
    for (const index of ins) continuation[index] = other(outs, index)[0]!;
  }
  const internal = new Uint8Array(traversals.length);
  for (const next of continuation) if (next >= 0) internal[next] = 1;
  const used = new Uint8Array(traversals.length);
  const chains: EdgeTraversal[][] = [];
  const walk = (first: number): void => {
    if (used[first]) return;
    const chain: EdgeTraversal[] = [];
    for (let edge = first; edge >= 0 && !used[edge]; edge = continuation[edge]!) {
      used[edge] = 1;
      chain.push(traversals[edge]!);
    }
    chains.push(chain);
  };
  for (let edge = 0; edge < traversals.length; edge += 1) if (!internal[edge]) walk(edge);
  // Disconnected rings have no junction. Anchor both directions at the same node.
  for (let edge = 0; edge < traversals.length; edge += 1) {
    if (used[edge]) continue;
    for (const incomingEdge of incoming.get(traversals[edge]!.from.id) ?? []) continuation[incomingEdge] = -1;
    for (const outgoingEdge of outgoing.get(traversals[edge]!.from.id) ?? []) walk(outgoingEdge);
  }
  return chains;
}
