import {
  DEFAULT_SOLVER_BUDGET,
  type RouteGenerationContext,
  type RouteSolver,
} from "@/lib/solver";
import type { GenerateRoutesRequestV1, GenerateRoutesResponseV1 } from "@/lib/contracts";
import { createGenerateRoutesHandler } from "./route-generation";
import { loadRoutePacks, type RegisteredRoutePack } from "./pack-registry";

type SolverModule = {
  createRouteSolver?: (options: {
    pack: Pick<RegisteredRoutePack, "id" | "schemaVersion" | "dataVersion" | "builtAt">;
    sourceFreshness: string;
    sourceConfidence: "high" | "medium" | "low";
    fallbackSourceIds: string[];
  }) => RouteSolver;
};

class LazyPackRouteSolver implements RouteSolver {
  readonly #packs: ReadonlyMap<string, RegisteredRoutePack>;
  readonly #solvers = new Map<string, RouteSolver>();

  constructor(packs: ReadonlyMap<string, RegisteredRoutePack>) {
    this.#packs = packs;
  }

  async generate(
    request: GenerateRoutesRequestV1,
    context: RouteGenerationContext,
  ): Promise<GenerateRoutesResponseV1> {
    let solver = this.#solvers.get(request.packId);
    if (!solver) {
      const pack = this.#packs.get(request.packId);
      if (!pack) throw new Error(`Pack ${request.packId} is not registered`);
      const solverModule = (await import("@/lib/solver")) as SolverModule;
      if (!solverModule.createRouteSolver) {
        throw new Error("The deterministic route solver is not installed");
      }
      solver = solverModule.createRouteSolver({
        pack: {
          id: pack.id,
          schemaVersion: pack.schemaVersion,
          dataVersion: pack.dataVersion,
          builtAt: pack.builtAt,
        },
        sourceFreshness: pack.sourceFreshness,
        sourceConfidence: pack.sourceConfidence,
        fallbackSourceIds: pack.fallbackSourceIds,
      });
      this.#solvers.set(request.packId, solver);
    }
    return solver.generate(request, context);
  }
}

export async function POST(request: Request): Promise<Response> {
  const packs = await loadRoutePacks();
  return createGenerateRoutesHandler({
    packs,
    solver: new LazyPackRouteSolver(packs),
    budget: { ...DEFAULT_SOLVER_BUDGET },
  })(request);
}
