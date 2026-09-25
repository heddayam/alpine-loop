import type { SearchIntent, SearchRequest, SearchResult } from "@/lib/contracts";
import { loadInstallation, withInstallationPins } from "@/lib/coverage-install";
import { areaBounds } from "@/lib/graph";
import { defaultReachabilityService } from "@/lib/reachability/default-service";
import { namespacedId, namespaceRoute, splitNamespacedId } from "@/lib/search/identity";
import { combineRoutes } from "@/lib/search/routes";
import { CLOSED_ROUTE_EFFORT_BUDGETS } from "@/lib/solver";
import { ServerApiError } from "./api-error";
import { boundsOverlap, eligibleAreaBounds, executableInstallationId, resolveSearchPlan, restorePlanArea } from "./search-area";
import type { SearchPlan } from "./search-plan";
import { RouteSolverProcess } from "./route-solver-process";
import { solverWorkerCount } from "./solver-concurrency";

async function openInstallation(request: SearchIntent, plan: SearchPlan, signal: AbortSignal) {
  const installationId = executableInstallationId(plan);
  const installed = await loadInstallation(undefined, installationId);
  if (!installed) throw new ServerApiError("DATA_UNAVAILABLE", "The saved installation is unavailable. Install coverage and start a new search.", 503);
  const { filterGeometry, refinementGeometry } = plan.area;
  if (!filterGeometry) throw new Error("The search area has not been resolved");
  const predicates = [filterGeometry, ...(refinementGeometry ? [refinementGeometry] : [])];
  const namedRegionPredicateIndex = request.area.mode === "named-regions" ? 0 : refinementGeometry ? 1 : undefined;
  if (predicates.some((geometry, index) => !boundsOverlap(areaBounds(installed.installation.geometry), eligibleAreaBounds(geometry, index === namedRegionPredicateIndex)))) return undefined;
  return RouteSolverProcess.open({
    installationId, criteria: request.criteria,
    accessFilter: { predicates, namedRegionPredicateIndex, coverage: installed.installation.geometry },
  }, signal);
}

export async function generateSearch(request: SearchRequest, signal: AbortSignal): Promise<SearchResult> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const plan = await resolveSearchPlan(request, signal);
    try {
      return await withInstallationPins([executableInstallationId(plan)], () => generateWithPlan(request, signal, plan));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || attempt) throw error;
    }
  }
  throw new Error("Installed coverage changed during search planning.");
}

async function generateWithPlan(request: SearchRequest, signal: AbortSignal, plan: SearchPlan): Promise<SearchResult> {
  if (request.area.mode === "drive-time") {
    const resolved = await defaultReachabilityService().resolveArea(request.area, signal);
    plan.area.filterGeometry = resolved.geometry;
  }
  signal.throwIfAborted();
  const installationId = executableInstallationId(plan);
  const budget = CLOSED_ROUTE_EFFORT_BUDGETS.quick;
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(budget.deadlineMs + 5_000)]);
  let session: RouteSolverProcess | undefined;
  let routes: Pick<SearchResult, "exact" | "nearMisses"> = { exact: [], nearMisses: [] };
  let incomplete = false;
  const messages = ["Search is limited to installed coverage. Source-data uncertainty is separate from installation completeness."];
  try {
    session = await openInstallation(request, plan, deadline);
    if (session) {
      const result = await session.generate({ searchEffort: "quick", limit: request.limit }, budget, deadline);
      routes = combineRoutes([{
        exact: result.exact.map(route => namespaceRoute(route, installationId, "Installed coverage")),
        nearMisses: result.nearMisses.map(route => namespaceRoute(route, installationId, "Installed coverage")),
      }], request.limit);
      incomplete = result.diagnostics.hardTruncationReasons.length > 0;
      if (result.diagnostics.noCycleAccessPointCount > 0) messages.push("Some starts have no reachable cycle in this data release.");
      if (incomplete) messages.push("The computation limit stopped part of the search early.");
    }
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    if (error instanceof ServerApiError) throw error;
    throw new ServerApiError("SEARCH_UNAVAILABLE", "The installed graph could not be searched. Check coverage and start a new search.", 503);
  } finally { await session?.close().catch(() => undefined); }
  if (!routes.exact.length) messages.push("No routes matched all criteria. Close matches, when available, are listed separately.");
  return { request, area: plan.area, ...routes, incomplete, messages };
}

/** Lazy bounded workers share the same immutable installation across starts. */
export async function openSearchSession({ request, plan: originalPlan, signal }: {
  request: SearchIntent; plan: SearchPlan; signal: AbortSignal;
}) {
  const plan = await restorePlanArea(request.area, originalPlan);
  const installationId = executableInstallationId(plan);
  const controller = new AbortController();
  const lifetime = AbortSignal.any([signal, controller.signal]);
  const concurrency = solverWorkerCount();
  const slots = Array.from({ length: concurrency }, () => ({
    session: undefined as RouteSolverProcess | undefined, tail: Promise.resolve(),
  }));
  let nextSlot = 0;
  return {
    concurrency,
    async enumerateEligibleAccessPointIds(signal: AbortSignal) {
      const combined = AbortSignal.any([lifetime, signal]);
      combined.throwIfAborted();
      const session = await openInstallation(request, plan, combined);
      try {
        return session
          ? (await session.enumerateEligibleAccessPointIds(combined)).map(id => namespacedId(installationId, id))
          : [];
      } finally { await session?.close(); }
    },
    async searchAccessPoint(id: string, signal: AbortSignal) {
      const slot = slots[nextSlot++ % slots.length]!;
      const combined = AbortSignal.any([lifetime, signal]);
      const operation = slot.tail.then(async () => {
        combined.throwIfAborted();
        const [owner, localId] = splitNamespacedId(id);
        if (owner !== installationId) throw new Error("The starting point belongs to a different installation.");
        try {
          slot.session ??= await openInstallation(request, plan, combined);
          if (!slot.session) throw new Error("The starting point's data is unavailable");
          const result = await slot.session.searchAccessPoint(localId, combined);
          return {
            ...result,
            exact: result.exact.map(route => namespaceRoute(route, installationId, "Installed coverage")),
            nearMisses: result.nearMisses.map(route => namespaceRoute(route, installationId, "Installed coverage")),
          };
        } catch (error) {
          await slot.session?.close().catch(() => undefined);
          slot.session = undefined;
          throw error;
        }
      });
      slot.tail = operation.then(() => undefined, () => undefined);
      return operation;
    },
    async close() {
      controller.abort(new DOMException("Search session closed", "AbortError"));
      await Promise.all(slots.map(async slot => {
        await slot.tail;
        await slot.session?.close().catch(() => undefined);
        slot.session = undefined;
      }));
    },
  };
}
