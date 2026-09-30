import { describe, expect, it } from "vitest";

import { RouteSearchCancelledError } from "./control";
import { decomposeCycleBlocks, type CycleBlockGraph } from "./cycle-blocks";

type Edge = readonly [from: number, to: number, physical: string];

function graph(nodeCount: number, edges: readonly Edge[]): CycleBlockGraph {
  return {
    nodeCount, from: Int32Array.from(edges.map(([from]) => from)),
    to: Int32Array.from(edges.map(([, to]) => to)), physical: edges.map(([, , physical]) => physical),
  };
}

function physicalBlocks(input: CycleBlockGraph): string[][] {
  return decomposeCycleBlocks(input).blocks
    .map(({ edges }) => [...new Set(edges.map((index) => input.physical[index]!))].sort())
    .sort((left, right) => left.join(",").localeCompare(right.join(",")));
}

/** Brute-force cycles on tiny undirected multigraphs, with no low-link logic. */
function naiveCycles(input: CycleBlockGraph): number[][] {
  const first = new Map<string, number>();
  for (let index = 0; index < input.physical.length; index += 1) {
    if (!first.has(input.physical[index]!)) first.set(input.physical[index]!, index);
  }
  const edges = [...first.values()];
  const cycles = new Map<string, number[]>();
  for (let start = 0; start < input.nodeCount; start += 1) {
    const visit = (node: number, path: number[], visited: Set<number>): void => {
      for (const edge of edges) {
        if (path.includes(edge) || (input.from[edge] !== node && input.to[edge] !== node)) continue;
        const next = input.from[edge] === node ? input.to[edge]! : input.from[edge]!;
        if (next === start) {
          const cycle = [...path, edge].sort((left, right) => left - right);
          cycles.set(cycle.join(","), cycle);
        } else if (!visited.has(next)) {
          visit(next, [...path, edge], new Set([...visited, next]));
        }
      }
    };
    visit(start, [], new Set([start]));
  }
  return [...cycles.values()];
}

function assertCompletePartition(input: CycleBlockGraph): void {
  const { edgeBlock, blocks } = decomposeCycleBlocks(input);
  const originalIndexes = blocks.flatMap(({ edges }) => edges).sort((left, right) => left - right);
  expect(originalIndexes).toEqual(Array.from({ length: input.from.length }, (_, index) => index));
  for (const [blockIndex, block] of blocks.entries()) {
    expect(new Set(block.nodes)).toEqual(new Set(block.edges.flatMap((edge) => [input.from[edge]!, input.to[edge]!])));
    expect(block.edges.every((edge) => edgeBlock[edge] === blockIndex)).toBe(true);
  }

  const cycles = naiveCycles(input);
  for (const cycle of cycles) {
    expect(new Set(cycle.map((edge) => edgeBlock[edge]))).toHaveLength(1);
    expect(blocks[edgeBlock[cycle[0]!]!]!.cyclic).toBe(true);
  }
  const edgesOnCycles = new Set(cycles.flat());
  const representative = new Map<string, number>();
  for (let index = 0; index < input.physical.length; index += 1) {
    if (!representative.has(input.physical[index]!)) representative.set(input.physical[index]!, index);
  }
  // Two edges belong to the same block exactly when a chain of simple cycles
  // connects them through shared edges. Bridges and self-loops stay singletons.
  const component = new Map([...representative.values()].map((edge) => [edge, edge]));
  for (const cycle of cycles) {
    const labels = new Set(cycle.map((edge) => component.get(edge)!));
    const merged = Math.min(...labels);
    for (const [edge, label] of component) if (labels.has(label)) component.set(edge, merged);
  }
  for (const [edge, expected] of component) {
    const physical = input.physical[edge]!;
    const block = blocks[edgeBlock[edge]!]!;
    expect(block.cyclic).toBe(edgesOnCycles.has(edge));
    for (let other = 0; other < input.physical.length; other += 1) {
      if (input.physical[other] === physical) expect(edgeBlock[other]).toBe(edgeBlock[edge]);
    }
    for (const [other, otherExpected] of component) {
      expect(edgeBlock[edge] === edgeBlock[other]).toBe(expected === otherExpected);
    }
  }
}

describe("physical cycle blocks", () => {
  it("ignores isolated nodes and retains every bridge direction without inventing a cycle", () => {
    const input = graph(5, [[0, 1, "a"], [1, 0, "a"], [1, 2, "b"], [3, 4, "c"]]);
    expect(physicalBlocks(input)).toEqual([["a"], ["b"], ["c"]]);
    expect(decomposeCycleBlocks(input).blocks.every(({ cyclic }) => !cyclic)).toBe(true);
    assertCompletePartition(input);
    expect(decomposeCycleBlocks(graph(3, []))).toEqual({ edgeBlock: new Int32Array(), blocks: [] });
    expect(decomposeCycleBlocks(graph(0, []))).toEqual({ edgeBlock: new Int32Array(), blocks: [] });
  });

  it("keeps parallel trails together but self-loops separate at their attachment", () => {
    const input = graph(3, [
      [0, 1, "a"], [1, 0, "a"], [0, 1, "b"], [1, 0, "b"],
      [1, 1, "loop"], [1, 1, "loop"], [1, 1, "other-loop"], [1, 2, "bridge"],
    ]);
    expect(physicalBlocks(input)).toEqual([["a", "b"], ["bridge"], ["loop"], ["other-loop"]]);
    const { blocks, edgeBlock } = decomposeCycleBlocks(input);
    expect(blocks[edgeBlock[0]!]!.cyclic).toBe(true);
    expect(blocks[edgeBlock[4]!]!).toMatchObject({ edges: [4, 5], nodes: [1], cyclic: true });
    expect(blocks[edgeBlock[7]!]!.cyclic).toBe(false);
    assertCompletePartition(input);
  });

  it("splits figure-eight lobes at the articulation instead of using edge connectivity", () => {
    const input = graph(5, [
      [0, 1, "a"], [1, 2, "b"], [2, 0, "c"],
      [0, 3, "d"], [3, 4, "e"], [4, 0, "f"],
    ]);
    expect(physicalBlocks(input)).toEqual([["a", "b", "c"], ["d", "e", "f"]]);
    expect(decomposeCycleBlocks(input).blocks.map(({ nodes }) => nodes.filter((node) => node === 0)))
      .toEqual([[0], [0]]);
    assertCompletePartition(input);
  });

  it("keeps chorded and disconnected rings intact regardless of legal direction", () => {
    const input = graph(9, [
      [0, 1, "a"], [1, 2, "b"], [0, 2, "c"], [2, 3, "d"], [3, 0, "e"],
      [4, 5, "f"], [5, 6, "g"], [6, 4, "h"], [7, 8, "i"],
    ]);
    expect(physicalBlocks(input)).toEqual([["a", "b", "c", "d", "e"], ["f", "g", "h"], ["i"]]);
    assertCompletePartition(input);
    // All three physical edges lie in a block even when this directed triangle
    // is acyclic. The caller must still check direction and reversible stems.
    expect(decomposeCycleBlocks(graph(3, [[0, 1, "a"], [1, 2, "b"], [0, 2, "c"]])).blocks)
      .toMatchObject([{ cyclic: true }]);
  });

  it("agrees with exhaustive cycle equivalence on 100 deterministic tiny multigraphs", () => {
    let state = 0x12345678;
    const random = () => { state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0; return state / 2 ** 32; };
    for (let example = 0; example < 100; example += 1) {
      const edges: Edge[] = [];
      for (let index = 0; index < 8; index += 1) {
        const from = Math.floor(random() * 6);
        const to = Math.floor(random() * 6);
        edges.push([from, to, String(index)]);
        if (random() < 0.5) edges.push([to, from, String(index)]);
      }
      assertCompletePartition(graph(6, edges));
    }
  });

  it("handles a 20,000-edge chain without recursion and retains its 40,000 directed records", () => {
    const edges: Edge[] = [];
    for (let index = 0; index < 20_000; index += 1) {
      edges.push([index, index + 1, String(index)], [index + 1, index, String(index)]);
    }
    const input = graph(20_001, edges);
    const result = decomposeCycleBlocks(input);
    expect(result.blocks).toHaveLength(20_000);
    expect(result.blocks.every(({ edges: blockEdges, nodes, cyclic }) => !cyclic && blockEdges.length === 2 && nodes.length === 2)).toBe(true);
    expect(result.edgeBlock.every((block) => block >= 0)).toBe(true);
    expect(new Set(result.edgeBlock).size).toBe(20_000);
  });

  it("handles a 20,000-edge ring as one block without a recursive unwind", () => {
    const edges: Edge[] = Array.from({ length: 20_000 }, (_, index) => [index, (index + 1) % 20_000, String(index)]);
    const result = decomposeCycleBlocks(graph(20_000, edges));
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0]!.cyclic).toBe(true);
    expect(result.blocks[0]!.edges).toHaveLength(20_000);
    expect(result.blocks[0]!.nodes).toHaveLength(20_000);
    expect(result.edgeBlock.every((block) => block === 0)).toBe(true);
  });

  it("rejects pre-cancelled work and checks cancellation throughout decomposition", () => {
    const cancelled = new AbortController();
    cancelled.abort("stop");
    expect(() => decomposeCycleBlocks(graph(0, []), cancelled.signal)).toThrow(RouteSearchCancelledError);
    const input = graph(20_001, Array.from({ length: 20_000 }, (_, index) => [index, index + 1, String(index)]));
    for (const stopAfter of [5, 80]) {
      const controller = new AbortController();
      let checks = 0;
      Object.defineProperty(controller.signal, "aborted", { get: () => ++checks >= stopAfter });
      expect(() => decomposeCycleBlocks(input, controller.signal)).toThrow(RouteSearchCancelledError);
      expect(checks).toBe(stopAfter);
    }
  });

  it("rejects inconsistent array lengths, node indexes, and reused physical identities", () => {
    expect(() => decomposeCycleBlocks({ ...graph(2, [[0, 1, "a"]]), to: new Int32Array() })).toThrow("matching");
    expect(() => decomposeCycleBlocks(graph(-1, []))).toThrow(RangeError);
    expect(() => decomposeCycleBlocks(graph(2, [[0, 2, "a"]]))).toThrow(RangeError);
    expect(() => decomposeCycleBlocks(graph(3, [[0, 1, "a"], [1, 2, "a"]]))).toThrow("inconsistent endpoints");
  });
});
