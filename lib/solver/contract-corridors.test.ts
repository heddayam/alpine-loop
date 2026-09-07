import { describe, expect, it } from "vitest";
import { edgeIsTraversable, type EdgeTraversal, type GraphEdge, type GraphNode } from "@/lib/graph";
import { contractCorridors, physicalKeyOf } from "./contract-corridors";

type Link = {
  from: string;
  to: string;
  oneWay?: boolean;
  forward?: Partial<GraphEdge>;
  backward?: Partial<GraphEdge>;
};

function traversals(links: readonly Link[]): EdgeTraversal[] {
  const nodes = new Map<string, GraphNode>();
  for (const id of links.flatMap(({ from, to }) => [from, to])) {
    if (!nodes.has(id)) nodes.set(id, { id, lon: nodes.size, lat: 0, elevationMeters: 0, flags: [] });
  }
  return links.flatMap((link, index) => {
    const make = (fromId: string, toId: string, reverse: boolean): EdgeTraversal => {
      const from = nodes.get(fromId)!;
      const to = nodes.get(toId)!;
      return {
        from,
        to,
        edge: {
          id: `${index + 1}${reverse ? "r" : "f"}`,
          edgeKey: index * 2 + (reverse ? 2 : 1),
          physicalEdgeKey: index + 1,
          fromNodeId: fromId,
          toNodeId: toId,
          coordinates: [[from.lon, from.lat], [to.lon, to.lat]],
          lengthMeters: 100,
          gainMeters: 10,
          lossMeters: 5,
          maximumElevationMeters: 100,
          maximumSustainedGradePct: 10,
          accessState: "public",
          trailName: null,
          sourceIds: ["fixture"],
          flags: [],
          ...(reverse ? link.backward : link.forward),
        },
      };
    };
    return [make(link.from, link.to, false), ...link.oneWay ? [] : [make(link.to, link.from, true)]];
  });
}

function expectLossless(input: readonly EdgeTraversal[], chains: readonly EdgeTraversal[][]): void {
  const flattened = chains.flat();
  expect(flattened).toHaveLength(input.length);
  expect(new Set(flattened)).toEqual(new Set(input));
  for (const chain of chains) {
    expect(chain.length).toBeGreaterThan(0);
    for (let index = 1; index < chain.length; index += 1) {
      expect(chain[index]!.from.id).toBe(chain[index - 1]!.to.id);
      expect(physicalKeyOf(chain[index]!.edge)).not.toBe(physicalKeyOf(chain[index - 1]!.edge));
    }
  }
}

function ids(chains: readonly EdgeTraversal[][]): string[][] {
  return chains.map((chain) => chain.map(({ edge }) => edge.id)).sort((a, b) => a.join().localeCompare(b.join()));
}

describe("contractCorridors", () => {
  it("partitions both directions into contiguous original traversals with independent metrics", () => {
    const input = traversals([
      { from: "s", to: "a", forward: { gainMeters: 70 }, backward: { gainMeters: 3, lossMeters: 70 } },
      { from: "a", to: "b", forward: { gainMeters: 20 }, backward: { gainMeters: 8, lossMeters: 20 } },
      { from: "b", to: "t", forward: { gainMeters: 40 }, backward: { gainMeters: 2, lossMeters: 40 } },
    ]);
    const chains = contractCorridors(input, "s");

    expectLossless(input, chains);
    expect(ids(chains)).toEqual([["1f", "2f", "3f"], ["3r", "2r", "1r"]]);
    const forward = chains.find((chain) => chain[0]!.from.id === "s")!;
    const reverse = chains.find((chain) => chain[0]!.from.id === "t")!;
    expect(forward.map(({ edge }) => physicalKeyOf(edge))).toEqual(reverse.map(({ edge }) => physicalKeyOf(edge)).reverse());
    expect(forward.reduce((sum, { edge }) => sum + edge.gainMeters, 0)).toBe(130);
    expect(reverse.reduce((sum, { edge }) => sum + edge.gainMeters, 0)).toBe(13);
    expect(reverse.reduce((sum, { edge }) => sum + edge.lossMeters, 0)).toBe(130);
  });

  it("anchors a ring at the chosen start even when input begins elsewhere", () => {
    const input = traversals([
      { from: "a", to: "b" },
      { from: "b", to: "s" },
      { from: "s", to: "a" },
    ]);
    const chains = contractCorridors(input, "s");

    expectLossless(input, chains);
    expect(chains).toHaveLength(2);
    for (const chain of chains) {
      expect(chain).toHaveLength(3);
      expect(chain[0]!.from.id).toBe("s");
      expect(chain.at(-1)!.to.id).toBe("s");
    }
  });

  it("keeps three distinct parallel trails as independent choices", () => {
    const input = traversals(Array.from({ length: 3 }, () => ({ from: "s", to: "a" })));
    const chains = contractCorridors(input, "s");

    expectLossless(input, chains);
    expect(chains).toHaveLength(6);
    expect(chains.every((chain) => chain.length === 1)).toBe(true);
    expect(new Set(input.map(({ edge }) => physicalKeyOf(edge))).size).toBe(3);
  });

  it("preserves a two-trail parallel loop as a real cycle in both directions", () => {
    const input = traversals([{ from: "s", to: "a" }, { from: "s", to: "a" }]);
    const chains = contractCorridors(input, "s");

    expectLossless(input, chains);
    expect(ids(chains)).toEqual([["1f", "2r"], ["2f", "1r"]]);
  });

  it("keeps a reversible-to-one-way boundary while contracting its one-way continuation", () => {
    const input = traversals([
      { from: "s", to: "a" },
      { from: "a", to: "b", oneWay: true },
      { from: "b", to: "c", oneWay: true },
      { from: "c", to: "t" },
    ]);
    const chains = contractCorridors(input, "s");

    expectLossless(input, chains);
    expect(ids(chains)).toEqual([["1f"], ["1r"], ["2f", "3f"], ["4f"], ["4r"]]);
  });

  it("anchors both directions of a disconnected ring at the same node", () => {
    const input = traversals([
      { from: "s", to: "t" },
      { from: "a", to: "b" },
      { from: "b", to: "c" },
      { from: "c", to: "a" },
    ]);
    const chains = contractCorridors(input, "s");

    expectLossless(input, chains);
    const ring = chains.filter((chain) => chain.length === 3);
    expect(ring).toHaveLength(2);
    expect(ring[0]![0]!.from.id).toBe(ring[1]![0]!.from.id);
    for (const chain of ring) expect(chain.at(-1)!.to.id).toBe(chain[0]!.from.id);
    expect(ring[0]!.map(({ edge }) => physicalKeyOf(edge))).toEqual(ring[1]!.map(({ edge }) => physicalKeyOf(edge)).reverse());
  });

  it("preserves a directed disconnected ring without inventing a reverse traversal", () => {
    const input = traversals([
      { from: "a", to: "b", oneWay: true },
      { from: "b", to: "c", oneWay: true },
      { from: "c", to: "a", oneWay: true },
    ]);
    const chains = contractCorridors(input, "s");

    expectLossless(input, chains);
    expect(ids(chains)).toEqual([["1f", "2f", "3f"]]);
  });

  it("uses only eligible edges when the caller filters unknown and prohibited branches", () => {
    const input = traversals([
      { from: "s", to: "a" },
      { from: "a", to: "t" },
      { from: "a", to: "u", forward: { accessState: "unknown" }, backward: { accessState: "unknown" } },
      { from: "a", to: "p", forward: { accessState: "prohibited" }, backward: { accessState: "prohibited" } },
    ]);
    const known = input.filter(({ edge }) => edgeIsTraversable(edge, false));
    const knownChains = contractCorridors(known, "s");
    const inclusive = input.filter(({ edge }) => edgeIsTraversable(edge, true));
    const inclusiveChains = contractCorridors(inclusive, "s");

    expectLossless(known, knownChains);
    expect(ids(knownChains)).toEqual([["1f", "2f"], ["2r", "1r"]]);
    expectLossless(inclusive, inclusiveChains);
    expect(inclusiveChains).toHaveLength(6);
    expect(inclusiveChains.every((chain) => chain.length === 1)).toBe(true);
  });

  it("retains a physical self-loop and its adjacent trail as separate choices", () => {
    const input = traversals([{ from: "s", to: "a" }, { from: "a", to: "a", oneWay: true }]);
    const chains = contractCorridors(input, "s");

    expectLossless(input, chains);
    expect(ids(chains)).toEqual([["1f"], ["1r"], ["2f"]]);
  });
});

describe("physicalKeyOf", () => {
  it("recognizes reversed fixture geometry without conflating different paths between endpoints", () => {
    const [forward, reverse] = traversals([{ from: "s", to: "a", forward: { physicalEdgeKey: undefined }, backward: { physicalEdgeKey: undefined, gainMeters: 100 } }]);
    expect(physicalKeyOf(forward!.edge)).toBe(physicalKeyOf(reverse!.edge));
    expect(physicalKeyOf({ ...forward!.edge, coordinates: [[0, 0], [0.5, 1], [1, 0]] })).not.toBe(physicalKeyOf(forward!.edge));
  });
});
