import { describe, expect, it } from "vitest";
import fixture from "@/data/fixtures/graph/solver-shapes.json";

const connections = new Set(
  fixture.undirectedTrails.flatMap(([from, to]) => [`${from}:${to}`, `${to}:${from}`]),
);

const hasPath = (nodes: string[]) =>
  nodes.slice(1).every((node, index) => connections.has(`${nodes[index]}:${node}`));

describe("solver shape fixture graph", () => {
  it("contains a simple loop", () => {
    expect(hasPath(["a", "b", "c", "d", "a"])).toBe(true);
  });

  it("contains a stem and compatible cycle for a lollipop", () => {
    expect(hasPath(["a", "e", "f", "g", "e", "a"])).toBe(true);
  });

  it("contains a reversible path for an out-and-back", () => {
    expect(hasPath(["a", "b", "a"])).toBe(true);
  });

  it("connects distinct public access points for point-to-point", () => {
    expect(hasPath(["a", "b", "h"])).toBe(true);
    expect(fixture.accessPoints.map(({ nodeId }) => nodeId)).toEqual(["a", "h"]);
  });
});
