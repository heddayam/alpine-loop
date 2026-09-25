import { PreparedGraphRepository } from "@/lib/graph";
import { loadInstallation } from "@/lib/coverage-install";
import {
  CLOSED_ROUTE_EFFORT_BUDGETS,
  type PreparedRouteSearch,
  type RouteGraphContext,
  AccessFilterResolutionError,
  ReachableGraphClosedRouteSolver,
} from "@/lib/solver";
import { ServerApiError } from "./api-error";
import type {
  StartSearchResult,
  RouteSolverRequest,
  RouteSolverResponse,
  RouteSolverWorkerInput,
} from "./route-solver-protocol";

type Session = {
  input: RouteSolverWorkerInput;
  solver: ReachableGraphClosedRouteSolver;
  context: RouteGraphContext;
  repository: PreparedGraphRepository;
  search?: PreparedRouteSearch;
};

let session: Session | undefined;
let chain = Promise.resolve();

function send(response: RouteSolverResponse): void {
  if (process.connected) process.send?.(response);
}

function serializedError(error: unknown): Extract<RouteSolverResponse, { ok: false }>["error"] {
  if (error instanceof Error) return { name: error.name, message: error.message,
    ...(error instanceof AccessFilterResolutionError || error instanceof ServerApiError ? { code: error.code } : {}),
    ...(error instanceof ServerApiError ? { status: error.status } : {}),
    ...(error.stack ? { stack: error.stack } : {}) };
  return { name: "Error", message: String(error) };
}

async function initialize(input: RouteSolverWorkerInput): Promise<void> {
  let repository: PreparedGraphRepository | undefined;
  try {
    const installed = await loadInstallation(undefined, input.installationId);
    if (!installed) throw new Error("The pinned installation is unavailable. Install prepared coverage and start a new search.");
    const { installation, release, artifacts } = installed;
    repository = new PreparedGraphRepository({
      installationId: installation.id, releaseId: release.id, artifacts, coverage: installation.geometry,
    });
    const solver = new ReachableGraphClosedRouteSolver({
      pack: { id: installation.id, dataVersion: release.id, builtAt: release.builtAt },
      sourceFreshness: release.sources.map(({ retrievedAt }) => retrievedAt).sort()[0] ?? release.builtAt,
      sourceConfidence: "low",
      fallbackSourceIds: release.sources.map(({ id }) => id),
    });
    session = { input, solver, context: { repository, accessFilter: input.accessFilter }, repository };
  } catch (error) {
    await repository?.close();
    throw new ServerApiError("DATA_UNAVAILABLE", `The pinned installation could not be opened. Install prepared coverage and start a new search. ${error instanceof Error ? error.message : ""}`, 503);
  }
}

async function preparedSearch(): Promise<PreparedRouteSearch> {
  if (!session) throw new Error("Route solver process was not initialized.");
  session.search ??= await session.solver.prepare(session.input.criteria, session.context);
  return session.search;
}

async function search(accessPointId: string): Promise<StartSearchResult> {
  const prepared = await preparedSearch();
  const routesPerAccessPoint = 10;
  const run = (searchEffort: "quick" | "thorough") => prepared.generate({
    startAccessPointId: accessPointId,
    searchEffort,
    limit: routesPerAccessPoint,
  }, { ...CLOSED_ROUTE_EFFORT_BUDGETS[searchEffort] });
  const quick = await run("quick");
  await new Promise<void>((resolveYield) => setImmediate(resolveYield));
  const thorough = await run("thorough");
  const unique = <T extends { id: string }>(values: readonly T[]): T[] => {
    const seen = new Set<string>();
    return values.filter(({ id }) => !seen.has(id) && Boolean(seen.add(id)));
  };
  return {
    exact: unique([...quick.exact, ...thorough.exact]).slice(0, routesPerAccessPoint),
    nearMisses: unique([...thorough.nearMisses, ...quick.nearMisses]),
    truncated: quick.diagnostics.hardTruncationReasons.length > 0
      || thorough.diagnostics.hardTruncationReasons.length > 0,
    diagnostics: { quick: quick.diagnostics, thorough: thorough.diagnostics },
  };
}

async function close(): Promise<void> {
  if (!session) return;
  await session.repository.close();
  session = undefined;
}

async function handle(request: RouteSolverRequest): Promise<void> {
  try {
    let value: Extract<RouteSolverResponse, { ok: true }>["value"];
    if (request.type === "initialize") await initialize(request.input);
    else if (request.type === "enumerate") value = (await preparedSearch()).eligibleAccessPointIds;
    else if (request.type === "search") value = await search(request.accessPointId);
    else if (request.type === "generate") {
      if (!session) throw new Error("Route solver process was not initialized.");
      value = await session.solver.generate({ ...session.input.criteria, ...request.policy }, {
        ...session.context, budget: request.budget,
      });
    } else await close();
    send({ id: request.id, ok: true, ...(value === undefined ? {} : { value }) });
  } catch (error) {
    send({ id: request.id, ok: false, error: serializedError(error) });
  }
}

process.on("message", (message: RouteSolverRequest) => {
  chain = chain.then(() => handle(message));
});

process.on("disconnect", () => {
  void close().finally(() => process.exit());
});
