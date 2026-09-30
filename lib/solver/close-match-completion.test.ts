import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PreparedGraphRepository, type AccessPointCandidate } from "@/lib/graph";
import { GRAPH_FIXTURE_IDENTITY, writePreparedGraphFixture } from "@/lib/graph/test-helpers";
import { oracleGraph, type PhysicalTrail } from "@/tests/solver/helpers/simple-route-oracle";
import { CLOSED_ROUTE_BUDGET } from "./budget";
import { ReachableGraphClosedRouteSolver } from "./reachable-graph-closed-route-solver";

const fixtures: Array<{ directory: string; repository: PreparedGraphRepository }> = [];
afterEach(async () => {
  for (const { directory, repository } of fixtures.splice(0)) {
    await repository.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a bounded close fallback does not reopen an exhausted exact search through the prepared solver", async () => {
  const trails: PhysicalTrail[] = [];
  const node = (row: number, column: number) => row === 0 && column === 0 ? "s" : `${row}-${column}`;
  const add = (from: string, to: string) => trails.push({
    id: trails.length + 1, from, to, length: 100, gain: 1, reverseGain: 1,
  });
  for (let row = 0; row < 6; row += 1) for (let column = 0; column < 6; column += 1) {
    if (row < 5) add(node(row, column), node(row + 1, column));
    if (column < 5) add(node(row, column), node(row, column + 1));
  }
  const graph = oracleGraph(trails);
  // Every directed edge exceeds the total allowed gain, independently proving
  // that no nonempty exact route exists. Close-route enumeration is still large.
  expect(graph.edges.every(edge => edge.gainMeters > 0.5)).toBe(true);
  const start = graph.nodes.get("s")!;
  const point: AccessPointCandidate = {
    id: "start", nodeId: start.id, lon: start.lon, lat: start.lat,
    name: "Grid start", kind: "trailhead", accessState: "public", confidence: "high",
    parkingEvidence: "fixture", sourceIds: ["oracle"], nearbyBuildingCount: 0,
    knownConnectivity: 2, inclusiveConnectivity: 2, knownOutDegree: 2, inclusiveOutDegree: 2,
  };
  const directory = mkdtempSync(join(tmpdir(), "close-completion-"));
  const descriptor = writePreparedGraphFixture(join(directory, "graph.sqlite"), graph, [point]);
  const repository = new PreparedGraphRepository(descriptor);
  fixtures.push({ directory, repository });
  const solver = new ReachableGraphClosedRouteSolver({ pack: GRAPH_FIXTURE_IDENTITY });
  const result = await solver.generate({
    distanceMiles: { min: 500 / 1609.344, max: 2000 / 1609.344 },
    elevationGainFeet: { min: 0, max: 0.5 / 0.3048 },
    closedRoute: { maximumRepeatedTrailPct: 0 }, includeUncertainAccess: true, limit: 10,
  }, {
    repository, now: () => 0,
    budget: { ...CLOSED_ROUTE_BUDGET, maximumExpandedStates: 200_000 },
    accessFilter: { predicates: [], coverage: descriptor.coverage },
  });
  expect(result.exact).toEqual([]);
  expect(result.nearMisses.length).toBeGreaterThan(0);
  expect(result.completion).toBe("exhausted");
  expect(result.diagnostics.hardTruncationReasons).toEqual([]);
  expect(result.diagnostics.closeMatchTruncationReasons).toContain("maximum-expanded-states");
  expect(result.diagnostics.expandedStates).toBeLessThan(51_000);
});
