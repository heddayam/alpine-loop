import { expect, it } from "vitest";
import { coverageTouches, intersectCoverage, rectangle, unionCoverage } from "./geometry";
import { coordinateIsInsideArea } from "@/lib/graph/geometry";

it("distinguishes provider contact from positive-area intersection and disjoint envelopes", () => {
  const a = rectangle([0, 0, 1, 1]);
  for (const b of [rectangle([1, 0, 2, 1]), rectangle([1, 1, 2, 2])]) {
    expect(intersectCoverage(a, b)).toBeNull();
    expect(coverageTouches(a, b)).toBe(true);
    expect(coverageTouches(b, a)).toBe(true);
  }
  expect(coverageTouches(a, rectangle([1.01, 0, 2, 1]))).toBe(false);
  expect(coverageTouches(a, rectangle([0.5, 0.5, 2, 2]))).toBe(true);
});

it("preserves holes and does not treat a provider inside a hole as touching", () => {
  const outer = rectangle([0, 0, 4, 4]);
  if (outer.type !== "Polygon") throw new Error("Expected polygon");
  outer.coordinates.push([[1, 1], [1, 3], [3, 3], [3, 1], [1, 1]]);
  const inner = rectangle([1.5, 1.5, 2.5, 2.5]);
  expect(coverageTouches(outer, inner)).toBe(false);
  expect(coverageTouches(inner, outer)).toBe(false);
  expect(coverageTouches(outer, rectangle([1, 1.5, 2, 2.5]))).toBe(true);
  const union = unionCoverage([outer, rectangle([5, 5, 6, 6])]);
  expect(coordinateIsInsideArea([2, 2], union)).toBe(false);
  expect(coordinateIsInsideArea([5.5, 5.5], union)).toBe(true);
});
