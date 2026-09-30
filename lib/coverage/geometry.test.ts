import { expect, it } from "vitest";
import { rectangle, unionCoverage } from "./geometry";
import { coordinateIsInsideArea } from "@/lib/graph/geometry";

it("preserves holes when combining source coverage", () => {
  const outer = rectangle([0, 0, 4, 4]);
  if (outer.type !== "Polygon") throw new Error("Expected polygon");
  outer.coordinates.push([[1, 1], [1, 3], [3, 3], [3, 1], [1, 1]]);
  const union = unionCoverage([outer, rectangle([5, 5, 6, 6])]);
  expect(coordinateIsInsideArea([2, 2], union)).toBe(false);
  expect(coordinateIsInsideArea([5.5, 5.5], union)).toBe(true);
});
