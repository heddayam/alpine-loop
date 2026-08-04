import fixtureGraph from "@/data/fixtures/graph/tiny.json";
import { FixtureGraphRepository, type FixtureGraphData } from "@/lib/graph";
import {
  DEFAULT_SOLVER_BUDGET,
  type RouteGenerationContext,
  type RouteSolver,
} from "@/lib/solver";
import type { GenerateRoutesRequestV1, GenerateRoutesResponseV1 } from "@/lib/contracts";
import {
  FIXTURE_PACK_COVERAGE,
  FIXTURE_PACK_MAXIMUM_AREA_SQUARE_KILOMETERS,
  FIXTURE_PACK_METADATA,
} from "@/lib/packs/fixture-pack";
import { createGenerateRoutesHandler, type RoutePack } from "./route-generation";

const FIXTURE_PACK: RoutePack = {
  ...FIXTURE_PACK_METADATA,
  coverageBbox: FIXTURE_PACK_COVERAGE,
  maximumAreaSquareKilometers: FIXTURE_PACK_MAXIMUM_AREA_SQUARE_KILOMETERS,
  loadRepository: async () =>
    new FixtureGraphRepository(fixtureGraph as unknown as FixtureGraphData),
};

type SolverModule = {
  createRouteSolver?: (options: {
    pack: Pick<RoutePack, "id" | "schemaVersion" | "dataVersion" | "builtAt">;
  }) => RouteSolver;
};

class LazyFixtureRouteSolver implements RouteSolver {
  #solver?: RouteSolver;

  async generate(
    request: GenerateRoutesRequestV1,
    context: RouteGenerationContext,
  ): Promise<GenerateRoutesResponseV1> {
    if (!this.#solver) {
      const solverModule = (await import("@/lib/solver")) as SolverModule;
      if (!solverModule.createRouteSolver) {
        throw new Error("The deterministic route solver is not installed");
      }
      this.#solver = solverModule.createRouteSolver({
        pack: {
          id: FIXTURE_PACK.id,
          schemaVersion: FIXTURE_PACK.schemaVersion,
          dataVersion: FIXTURE_PACK.dataVersion,
          builtAt: FIXTURE_PACK.builtAt,
        },
      });
    }
    return this.#solver.generate(request, context);
  }
}

export const POST = createGenerateRoutesHandler({
  packs: new Map([[FIXTURE_PACK.id, FIXTURE_PACK]]),
  solver: new LazyFixtureRouteSolver(),
  budget: { ...DEFAULT_SOLVER_BUDGET },
});
