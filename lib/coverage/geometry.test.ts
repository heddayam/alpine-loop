import { describe, expect, it } from "vitest";
import { installationUnits, rectangle, unionCoverage, intersectCoverage } from "./geometry";
import { coordinateIsInsideArea, lineIsInsideArea } from "@/lib/graph/geometry";

describe("coverage installation geometry", () => {
  it("keeps a crossing line whole when adjacent units are combined", () => {
    const request = rectangle([-121.1, 47.1, -120.9, 47.4]);
    const units = installationUnits(request);
    expect(units).toHaveLength(4);
    const union = unionCoverage(units.map((unit) => unit.geometry));
    expect(lineIsInsideArea([[-121.05, 47.15], [-120.95, 47.35]], union)).toBe(true);
    expect(coordinateIsInsideArea([-121.2, 47.2], union)).toBe(false);
    expect(installationUnits(request)).toEqual(units);
  });
  it("retains holes and disconnected clipped pieces", () => {
    const area = { type: "Polygon" as const, coordinates: [rectangle([0, 0, 1, 1]).coordinates[0], [[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9], [0.1, 0.1]]] };
    const union = unionCoverage(installationUnits(area as never).map((unit) => unit.geometry));
    expect(coordinateIsInsideArea([0.5, 0.5], union)).toBe(false);
    expect(intersectCoverage(rectangle([0, 0, 1, 1]), rectangle([2, 2, 3, 3]))).toBeNull();
  });
  it("distinguishes expansion within a partially installed cell", () => {
    expect(installationUnits(rectangle([0, 0, 0.1, 0.1]))[0]!.id).not.toBe(installationUnits(rectangle([0, 0, 0.2, 0.2]))[0]!.id);
  });
});
