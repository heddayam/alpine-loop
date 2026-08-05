import type { GenerateRoutesRequestV2, GenerateRoutesResponseV2 } from "@/lib/contracts";
import {
  DEFAULT_SOLVER_BUDGET,
  type RouteGenerationV2Context,
  type RouteSolverV2,
} from "@/lib/solver";
import { defaultReachabilityResolver } from "./default-reachability-resolution";
import { loadRoutePacks, type RegisteredRoutePack } from "./pack-registry";
import { createGenerateRoutesHandler } from "./route-generation";

type SolverModule = {
  createMultiStartRouteSolver?: (options: {
    pack: Pick<RegisteredRoutePack, "id" | "schemaVersion" | "dataVersion" | "builtAt">;
    sourceFreshness: string;
    sourceConfidence: "high" | "medium" | "low";
    fallbackSourceIds: string[];
  }) => RouteSolverV2;
};

class LazyPackRouteSolver implements RouteSolverV2 {
  readonly #packs: ReadonlyMap<string, RegisteredRoutePack>;
  readonly #solvers = new Map<string, RouteSolverV2>();

  constructor(packs: ReadonlyMap<string, RegisteredRoutePack>) {
    this.#packs = packs;
  }

  async generate(
    request: GenerateRoutesRequestV2,
    context: RouteGenerationV2Context,
  ): Promise<GenerateRoutesResponseV2> {
    let solver = this.#solvers.get(request.packId);
    if (!solver) {
      const pack = this.#packs.get(request.packId);
      if (!pack) throw new Error(`Pack ${request.packId} is not registered`);
      const solverModule = (await import("@/lib/solver")) as SolverModule;
      if (!solverModule.createMultiStartRouteSolver) throw new Error("The multi-start route solver is not installed");
      solver = solverModule.createMultiStartRouteSolver({
        pack: { id: pack.id, schemaVersion: pack.schemaVersion, dataVersion: pack.dataVersion, builtAt: pack.builtAt },
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
    resolveReachability: defaultReachabilityResolver,
    budget: { ...DEFAULT_SOLVER_BUDGET },
  })(request);
}
