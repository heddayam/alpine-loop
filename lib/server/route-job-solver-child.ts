import { getSearchRegion } from "@/lib/data/named-area-catalog";
import {
  SQLiteClosedRouteFeasibilityRepository,
  SQLiteGraphRepository,
} from "@/lib/graph";
import { loadInstalledPackVersion } from "@/lib/packs/installed-pack";
import type { AccessPointSearchResult } from "@/lib/route-jobs";
import {
  CLOSED_ROUTE_EFFORT_BUDGETS,
  listEligibleAccessPointCandidates,
  ReachableGraphClosedRouteSolver,
} from "@/lib/solver";
import { resolvedDriveTimeAccessFilter } from "./access-filter";
import type {
  RouteJobSolverRequest,
  RouteJobSolverResponse,
  RouteJobSolverWorkerInput,
} from "./route-job-solver-protocol";

type Session = {
  input: RouteJobSolverWorkerInput;
  manifest: NonNullable<Awaited<ReturnType<typeof loadInstalledPackVersion>>>["manifest"];
  region: NonNullable<ReturnType<typeof getSearchRegion>>;
  accessFilter: ReturnType<typeof resolvedDriveTimeAccessFilter>;
  repository: SQLiteGraphRepository;
  topologyRepository: SQLiteClosedRouteFeasibilityRepository;
  solver: ReachableGraphClosedRouteSolver;
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
  if (manifest.schemaVersion !== "4" && manifest.schemaVersion !== "5" && manifest.schemaVersion !== "6") throw new Error("The pinned pack does not support batch search.");
  const region = getSearchRegion(installed.databasePath, input.searchRegionId);
  if (!region) throw new Error("The job's reviewed search region is unavailable.");
  const accessFilter = resolvedDriveTimeAccessFilter({ coverage: manifest.coverage.boundary }, {
    geometry: input.driveTimeGeometry,
    durationMinutes: input.request.durationMinutes,
    resolvedAt: new Date().toISOString(),
    originLabel: input.request.origin.label,
  }, region);
  const repository = new SQLiteGraphRepository(installed.databasePath, manifest.id);
  const topologyRepository = new SQLiteClosedRouteFeasibilityRepository({
    databasePath: installed.databasePath,
    manifest,
  });
  session = {
    input,
    manifest,
    region,
    accessFilter,
    repository,
    topologyRepository,
    solver: new ReachableGraphClosedRouteSolver({
      pack: {
        id: manifest.id,
        schemaVersion: manifest.schemaVersion,
        dataVersion: manifest.dataVersion,
        builtAt: manifest.builtAt,
      },
      sourceFreshness: manifest.sources.map(({ retrievedAt }) => retrievedAt).sort()[0] ?? manifest.builtAt,
      sourceConfidence: manifest.fieldConfidence.access ?? "low",
      fallbackSourceIds: manifest.sources.map(({ id }) => id),
    }),
  };
}

async function enumerate(): Promise<readonly string[]> {
  if (!session) throw new Error("Route solver process was not initialized.");
  const { eligible } = await listEligibleAccessPointCandidates({
    repository: session.repository,
    accessFilter: session.accessFilter,
    includeUncertainAccess: session.input.request.criteria.includeUncertainAccess,
    accessPointRemoteness: session.input.request.criteria.accessPointRemoteness,
    signal: new AbortController().signal,
  });
  return eligible.map(({ id }) => id);
}

async function search(accessPointId: string): Promise<AccessPointSearchResult> {
  if (!session) throw new Error("Route solver process was not initialized.");
  const { input, manifest, region, repository, topologyRepository, accessFilter, solver } = session;
  const signal = new AbortController().signal;
  const run = (searchEffort: "quick" | "thorough") => solver.generate({
    version: 3,
    packId: manifest.id,
    accessFilter: {
      mode: "drive-time",
      reachabilityId: "00000000-0000-4000-8000-000000000000",
      regionId: region.id,
    },
    startAccessPointId: accessPointId,
    routeFamily: "closed",
    ...input.request.criteria,
    searchEffort,
    limit: input.request.routesPerAccessPoint,
  }, {
    repository,
    topologyRepository,
    accessFilter,
    budget: { ...CLOSED_ROUTE_EFFORT_BUDGETS[searchEffort] },
    signal,
  });
  const quick = await run("quick");
  await new Promise<void>((resolveYield) => setImmediate(resolveYield));
  const thorough = await run("thorough");
  const unique = <T extends { id: string }>(values: readonly T[]): T[] => {
    const seen = new Set<string>();
    return values.filter(({ id }) => !seen.has(id) && Boolean(seen.add(id)));
  };
  return {
    exact: unique([...quick.exact, ...thorough.exact]).slice(0, input.request.routesPerAccessPoint),
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
