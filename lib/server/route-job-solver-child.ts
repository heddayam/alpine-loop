import { getSearchRegion } from "@/lib/data/named-area-catalog";
import {
  SQLiteClosedRouteFeasibilityRepository,
  SQLiteGraphRepository,
} from "@/lib/graph";
import { loadInstalledPackVersion } from "@/lib/packs/installed-pack";
import type { AccessPointSearchResult } from "@/lib/route-jobs";
import {
  CLOSED_ROUTE_EFFORT_BUDGETS,
  type PreparedRouteSearch,
  ReachableGraphClosedRouteSolver,
} from "@/lib/solver";
import {
  resolvedDrawnAreaAccessFilter,
  resolvedDriveTimeAccessFilter,
  resolvedNamedRegionAccessFilter,
} from "./access-filter";
import type {
  RouteJobSolverRequest,
  RouteJobSolverResponse,
  RouteJobSolverWorkerInput,
} from "./route-job-solver-protocol";

type Session = {
  routesPerAccessPoint: number;
  repository: SQLiteGraphRepository;
  topologyRepository: SQLiteClosedRouteFeasibilityRepository;
  search: PreparedRouteSearch;
};

let session: Session | undefined;
let chain = Promise.resolve();

function send(response: RouteJobSolverResponse): void {
  if (process.connected) process.send?.(response);
}

function serializedError(error: unknown): Extract<RouteJobSolverResponse, { ok: false }>["error"] {
  if (error instanceof Error) return { name: error.name, message: error.message, ...(error.stack ? { stack: error.stack } : {}) };
  return { name: "Error", message: String(error) };
}

async function initialize(input: RouteJobSolverWorkerInput): Promise<void> {
  const installed = await loadInstalledPackVersion(input.pack.id, input.pack.dataVersion);
  if (!installed) throw new Error("The pinned pack version is no longer installed.");
  const { manifest } = installed;
  if (manifest.schemaVersion !== "3" && manifest.schemaVersion !== "4" && manifest.schemaVersion !== "5" && manifest.schemaVersion !== "6") {
    throw new Error("The pinned pack does not support batch search.");
  }
  const region = input.request.searchRegionId
    ? getSearchRegion(installed.databasePath, input.request.searchRegionId) ?? undefined
    : undefined;
  if (input.request.searchRegionId && !region) throw new Error("The job's reviewed search region is unavailable.");
  const accessFilter = input.request.drawnAreaBbox
    ? resolvedDrawnAreaAccessFilter({ coverage: manifest.coverage.boundary }, input.request.drawnAreaBbox)
    : input.driveTimeGeometry && input.request.origin && input.request.durationMinutes !== undefined && region
      ? resolvedDriveTimeAccessFilter({ coverage: manifest.coverage.boundary }, {
        geometry: input.driveTimeGeometry,
        durationMinutes: input.request.durationMinutes,
        resolvedAt: new Date().toISOString(),
        originLabel: input.request.origin.label,
      }, region)
      : region
        ? resolvedNamedRegionAccessFilter({ coverage: manifest.coverage.boundary }, region)
        : undefined;
  if (!accessFilter) throw new Error("The job's access filter is unavailable.");
  const repository = new SQLiteGraphRepository(installed.databasePath, manifest.id);
  const topologyRepository = new SQLiteClosedRouteFeasibilityRepository({
    databasePath: installed.databasePath,
    manifest,
  });
  const solver = new ReachableGraphClosedRouteSolver({
    pack: {
      id: manifest.id,
      schemaVersion: manifest.schemaVersion,
      dataVersion: manifest.dataVersion,
      builtAt: manifest.builtAt,
    },
    sourceFreshness: manifest.sources.map(({ retrievedAt }) => retrievedAt).sort()[0] ?? manifest.builtAt,
    sourceConfidence: manifest.fieldConfidence.access ?? "low",
    fallbackSourceIds: manifest.sources.map(({ id }) => id),
  });
  try {
    session = {
      routesPerAccessPoint: input.request.routesPerAccessPoint,
      repository,
      topologyRepository,
      search: await solver.prepare(input.request.criteria, { repository, topologyRepository, accessFilter }),
    };
  } catch (error) {
    await topologyRepository.close();
    await repository.close();
    throw error;
  }
}

function enumerate(): readonly string[] {
  if (!session) throw new Error("Route solver process was not initialized.");
  return session.search.eligibleAccessPointIds;
}

async function search(accessPointId: string): Promise<AccessPointSearchResult> {
  if (!session) throw new Error("Route solver process was not initialized.");
  const { routesPerAccessPoint, search: prepared } = session;
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
  await session.topologyRepository.close();
  await session.repository.close();
  session = undefined;
}

async function handle(request: RouteJobSolverRequest): Promise<void> {
  try {
    let value: readonly string[] | AccessPointSearchResult | undefined;
    if (request.type === "initialize") await initialize(request.input);
    else if (request.type === "enumerate") value = await enumerate();
    else if (request.type === "search") value = await search(request.accessPointId);
    else await close();
    send({ id: request.id, ok: true, ...(value === undefined ? {} : { value }) });
  } catch (error) {
    send({ id: request.id, ok: false, error: serializedError(error) });
  }
}

process.on("message", (message: RouteJobSolverRequest) => {
  chain = chain.then(() => handle(message));
});

process.on("disconnect", () => {
  void close().finally(() => process.exit());
});
