import { describe, expect, it } from "vitest";
import tinyFixture from "@/data/fixtures/graph/solver-shapes.json";
import {
  FixtureGraphRepository,
  type AreaGeometry,
  type FixtureGraphData,
} from "@/lib/graph";
import { runV2ScenarioSuite, type V2ScenarioSuite } from "./v2-scenario-runner";

const coverage: AreaGeometry = {
  type: "Polygon",
  coordinates: [[
    [-122.19, 37.15], [-122.13, 37.15], [-122.13, 37.18],
    [-122.19, 37.18], [-122.19, 37.15],
  ]],
};
const filter: AreaGeometry = {
  type: "Polygon",
  coordinates: [[
    [-122.161, 37.159], [-122.159, 37.159], [-122.159, 37.161],
    [-122.161, 37.161], [-122.161, 37.159],
  ]],
};

const suite: V2ScenarioSuite = {
  schemaVersion: 2,
  name: "V2 fixture acceptance",
  pack: {
    id: "fixture-pack",
    schemaVersion: "2",
    dataVersion: "fixture-v2",
    builtAt: "2026-08-04T00:00:00Z",
    coverage,
  },
  performanceBudgetMs: 3_000,
  scenarios: [{
    id: "drawn-filter-does-not-clip",
    tags: ["drawn-area"],
    typical: true,
    request: {
      version: 2,
      packId: "fixture-pack",
      accessFilter: { mode: "drawn-area", bbox: [-122.161, 37.159, -122.159, 37.161] },
      routeTypes: ["out-and-back"],
      pointToPoint: { finishMustMatchAccessFilter: true },
      distanceMiles: { min: 0, max: 30 },
      includeUncertainAccess: true,
      limit: 1,
    },
    expect: { minimumExact: 1, routesMayLeaveFilter: true },
  }],
};

describe("V2 scenario runner", () => {
  it("validates the response contract, filter semantics, coverage, and budget evidence", async () => {
    let clock = 0;
    const report = await runV2ScenarioSuite({
      suite,
      repositoryFactory: () => new FixtureGraphRepository(tinyFixture as unknown as FixtureGraphData),
      resolveFilter: () => ({
        summary: { mode: "drawn-area", label: "Drawn area" },
        predicates: [filter],
        coverage,
      }),
      measureNow: () => clock++,
    });

    expect(report.passed).toBe(true);
    expect(report.summary).toEqual({ runs: 1, passed: 1, failed: 0, slowestTypicalDurationMs: 1 });
    expect(report.scenarios[0].assertions.every(({ passed }) => passed)).toBe(true);
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  });
});
