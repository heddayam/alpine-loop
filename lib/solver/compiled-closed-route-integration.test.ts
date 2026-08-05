import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { generateClosedRoutesResponseV3Schema, packManifestV3Schema } from "@/lib/contracts";
import { compilePack, fixtureCompileOptionsV3 } from "@/lib/data";
import { SQLiteClosedRouteTopologyRepository, SQLiteGraphRepository } from "@/lib/graph";
import { CLOSED_ROUTE_EFFORT_BUDGETS } from "./budget";
import { createClosedRouteSolver } from "./closed-route-solver";
import { DeterministicClosedRoutePrimitiveCatalog } from "./primitive-catalog";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("compiled schema-3 closed-route integration", () => {
  it("builds, loads, reconstructs, and solves through the public topology boundaries", async () => {
    const outputRoot = await mkdtemp(path.join(os.tmpdir(), "alpine-closed-route-integration-"));
    temporaryDirectories.push(outputRoot);
    const built = await compilePack(await fixtureCompileOptionsV3(outputRoot));
    const manifest = packManifestV3Schema.parse(JSON.parse(await readFile(built.manifestPath, "utf8")));
    const graphRepository = new SQLiteGraphRepository(built.databasePath, manifest.id);
    const topologyRepository = new SQLiteClosedRouteTopologyRepository({
      databasePath: built.databasePath,
      manifest,
      maximumCacheBytes: 1_000_000,
    });
    try {
      const access = await topologyRepository.getAccessTopology("known", ["access-n-a"]);
      expect(access).toHaveLength(1);
      expect(access[0]?.canReachCycle).toBe(true);
      const network = await topologyRepository.loadDecisionNetwork("known", access[0]!.cycleNetworkId!);
      const reconstructed = await topologyRepository.reconstructDirectedEdges([network.edges[0]!.id]);
      expect(reconstructed).not.toHaveLength(0);
      expect(reconstructed.every(({ minimumElevationMeters }) => minimumElevationMeters !== null)).toBe(true);

      const solver = createClosedRouteSolver({
        pack: {
          id: manifest.id,
          schemaVersion: "3",
          dataVersion: manifest.dataVersion,
          builtAt: manifest.builtAt,
        },
      });
      const response = await solver.generate({
        version: 3,
        packId: manifest.id,
        accessFilter: { mode: "drawn-area", bbox: manifest.coverage.bbox },
        startAccessPointId: "access-n-a",
        routeFamily: "closed",
        closedRoute: { maximumRepeatedTrailPct: 100, allowMultiCycle: true },
        distanceMiles: { min: 0, max: 30 },
        includeUncertainAccess: false,
        searchEffort: "quick",
        limit: 5,
      }, {
        repository: graphRepository,
        topologyRepository,
        primitiveCatalog: new DeterministicClosedRoutePrimitiveCatalog({ dataVersion: manifest.dataVersion }),
        budget: { ...CLOSED_ROUTE_EFFORT_BUDGETS.quick },
        now: () => 0,
        accessFilter: {
          summary: { mode: "drawn-area", label: "Fixture coverage" },
          predicates: [manifest.coverage.boundary],
          coverage: manifest.coverage.boundary,
        },
      });
      expect(generateClosedRoutesResponseV3Schema.parse(response).version).toBe(3);
      expect(response.exact.length).toBeGreaterThan(0);
      expect(response.exact.every(({ topology }) => topology.cycleCount > 0)).toBe(true);
      expect(response.diagnostics.directedValidationRejectionCount).toBe(0);
    } finally {
      await graphRepository.close();
      await topologyRepository.close();
    }
  });
});
