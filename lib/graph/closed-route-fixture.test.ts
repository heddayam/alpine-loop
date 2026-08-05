import { describe, expect, it } from "vitest";
import fixture from "@/data/fixtures/graph/closed-route-topologies.json";

describe("closed-route shared topology fixture", () => {
  it("freezes every Gate 5 structural counterexample", () => {
    expect(fixture.formatVersion).toBe(1);
    expect(fixture.cases.map(({ id }) => id)).toEqual([
      "simple-loop",
      "lollipop",
      "figure-eight",
      "chained-loops",
      "bridge-only",
      "directed-asymmetry",
      "parallel-edges",
      "degree-two-cycle",
    ]);
  });

  it("assigns stable physical IDs independently of directed traversal", () => {
    for (const testCase of fixture.cases) {
      expect(new Set(testCase.edges.map(({ id }) => id)).size).toBe(testCase.edges.length);
      expect(testCase.edges.every(({ lengthMeters }) => lengthMeters > 0)).toBe(true);
    }
  });
});
