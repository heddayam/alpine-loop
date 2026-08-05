import { describe, expect, it } from "vitest";
import graphFixture from "@/data/fixtures/scenarios/santa-cruz-wave3-graph.json";
import scenarioFixture from "@/data/fixtures/scenarios/santa-cruz-wave3.json";
import { FixtureGraphRepository, type FixtureGraphData } from "@/lib/graph";
import { runScenarioSuite, type ScenarioSuite } from "./scenario-runner";

const suite = scenarioFixture as unknown as ScenarioSuite;
const graph = graphFixture as unknown as FixtureGraphData;

function repositoryFactory() {
  return new FixtureGraphRepository(graph);
}

describe("Wave 3 scenario runner", () => {
  it("passes the complete offline Santa Cruz matrix and emits machine-readable results", async () => {
    let clock = 0;
    const report = await runScenarioSuite({
      suite,
      repositoryFactory,
      measureNow: () => clock++,
    });

    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
    expect(report.passed).toBe(true);
    expect(report.summary).toEqual({
      scenarioRuns: 31,
      passed: 31,
      failed: 0,
      typicalRuns: 2,
      slowestTypicalDurationMs: 1,
    });
  });

  it("covers all shapes, both rectangle sizes, both access policies, impossible constraints, and limits 1-20", async () => {
    const report = await runScenarioSuite({ suite, repositoryFactory });
    const tags = new Set(report.scenarios.flatMap(({ tags }) => tags));
    const shapes = new Set(report.scenarios.flatMap(({ routeShapes }) => routeShapes));
    const sweptLimits = report.scenarios
      .filter(({ sourceScenarioId }) => sourceScenarioId === "requested-count-sweep")
      .map(({ requested }) => requested);

    for (const tag of [
      "small-rectangle",
      "large-rectangle",
      "hard-boundary",
      "known-only",
      "include-uncertain",
      "impossible",
      "partial-results",
      "stale-data",
    ]) expect(tags).toContain(tag);
    expect(shapes).toEqual(new Set(["loop", "lollipop", "out-and-back", "point-to-point"]));
    expect(sweptLimits).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
    expect(report.scenarios.every(({ assertions }) =>
      assertions.find(({ assertion }) => assertion === "every coordinate stays inside the hard rectangle")?.passed,
    )).toBe(true);
  });

  it("keeps exact and near-miss results separate and discloses every impossible constraint", async () => {
    const report = await runScenarioSuite({ suite, repositoryFactory });
    const impossible = report.scenarios.find(({ id }) => id === "strict-impossible-constraints");
    expect(impossible).toMatchObject({ exactCount: 0, passed: true });
    expect(impossible?.nearMissCount).toBeGreaterThan(0);
    expect(impossible?.nearMissCount).toBeLessThanOrEqual(3);
    expect(impossible?.assertions.filter(({ assertion }) => assertion.startsWith("near miss discloses")))
      .toHaveLength(4);
  });

  it("reports deterministic budget exhaustion and freshness propagation", async () => {
    const report = await runScenarioSuite({ suite, repositoryFactory });
    const budget = report.scenarios.find(({ id }) => id === "budget-exhaustion-partial");
    const stale = report.scenarios.find(({ id }) => id === "stale-source-propagation");

    expect(budget).toMatchObject({
      passed: true,
      diagnostics: { exhausted: true },
    });
    expect(budget?.diagnostics.truncationReasons).toContain("maximum-expanded-states");
    expect(stale?.assertions).toContainEqual({ assertion: "source freshness is propagated", passed: true });
  });

  it("rejects an invalid or mismatched suite before repository work", async () => {
    const invalid = {
      ...suite,
      scenarios: [{ ...suite.scenarios[0], request: { ...suite.scenarios[0].request, limit: 21 } }],
    };
    await expect(runScenarioSuite({ suite: invalid, repositoryFactory })).rejects.toThrow();

    const mismatch = {
      ...suite,
      scenarios: [{ ...suite.scenarios[0], request: { ...suite.scenarios[0].request, packId: "another-pack" } }],
    };
    await expect(runScenarioSuite({ suite: mismatch, repositoryFactory })).rejects.toThrow(/targets another-pack/);
  });
});
