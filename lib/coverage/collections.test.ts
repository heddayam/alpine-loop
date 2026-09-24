import { describe, expect, it } from "vitest";
import { collections, coverageExclusions, coverageSources, planCoverageGeometry } from "./collections";
import { rectangle, unionCoverage } from "./geometry";
import { coordinateIsInsideArea } from "@/lib/graph/geometry";

describe("coverage source geography", () => {
  it("uses provider geometry independently from collection envelopes", async () => {
    const sources = await coverageSources();
    expect(sources).toHaveLength(2);
    const washington = sources.find((source) => source.config.id === "geofabrik-washington-osm")!;
    expect(coordinateIsInsideArea([-121.8, 48.1], washington.geometry)).toBe(true);
    expect(coordinateIsInsideArea([-121.5, 45.5], washington.geometry)).toBe(false);
    const cascades = (await collections()).find((collection) => collection.id === "washington-cascades")!;
    expect(coordinateIsInsideArea([-121.5, 45.5], cascades.geometry)).toBe(true);
    expect(cascades.sourceIds).toEqual([washington.config.id]);
  });

  it("keeps Yakama excluded from both collection and drawn installation plans", async () => {
    const exclusions = await coverageExclusions();
    const point: [number, number] = [-120.8, 46.2];
    expect(coordinateIsInsideArea(point, exclusions[0]!.geometry)).toBe(true);
    const cascades = (await collections()).find((collection) => collection.id === "washington-cascades")!;
    expect(coordinateIsInsideArea(point, cascades.geometry)).toBe(false);
    const plan = planCoverageGeometry(rectangle([-120.81, 46.19, -120.79, 46.21]), await coverageSources(), exclusions);
    expect(plan.supported).toBeNull();
    expect(plan.units.every((unit) => unit.status === "unavailable" && unit.reason === "intentionally-excluded:yakama-reservation")).toBe(true);
  });

  it("splits a cell across all source extents, preserves the request, and gives unsupported pieces a stable identity", () => {
    const requested = rectangle([0, 0, 0.25, 0.25]);
    const sources = [{ geometry: rectangle([0, 0, 0.1, 0.25]) }, { geometry: rectangle([0.15, 0, 0.25, 0.25]) }];
    const plan = planCoverageGeometry(requested, sources, []);
    expect(plan.units).toHaveLength(2);
    const available = plan.units.find((unit) => unit.status === "pending")!;
    const unavailable = plan.units.find((unit) => unit.status === "unavailable")!;
    expect(coordinateIsInsideArea([0.125, 0.1], available.geometry)).toBe(false);
    expect(coordinateIsInsideArea([0.125, 0.1], unavailable.geometry)).toBe(true);
    expect(available.id).not.toBe(unavailable.id);
    expect(planCoverageGeometry(requested, [...sources].reverse(), [])).toEqual(plan);
    const rebuilt = unionCoverage(plan.units.map((unit) => unit.geometry));
    for (const x of [0.05, 0.125, 0.2]) expect(coordinateIsInsideArea([x, 0.1], rebuilt)).toBe(true);
  });

  it("marks an unsupported request unavailable even when no providers are configured", () => {
    const plan = planCoverageGeometry(rectangle([1, 1, 1.1, 1.1]), [], []);
    expect(plan.supported).toBeNull();
    expect(plan.units[0]?.reason).toBe("outside-configured-source-coverage");
  });
});
