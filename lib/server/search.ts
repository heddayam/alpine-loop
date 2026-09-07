import type { SearchIntent, SearchRequest, SearchResult } from "@/lib/contracts";
import { loadInstalledPackVersion } from "@/lib/packs/installed-pack";
import { defaultReachabilityService } from "@/lib/reachability/default-service";
import { namespacedId, namespaceRoute, splitNamespacedId } from "@/lib/search/identity";
import { combineRoutes } from "@/lib/search/routes";
import { CLOSED_ROUTE_EFFORT_BUDGETS } from "@/lib/solver";
import { ServerApiError } from "./api-error";
import { boundsOverlap, eligibleAreaBounds, resolveSearchPlan, restorePlanArea } from "./search-area";
import type { SearchPlan } from "./search-plan";
import { RouteSolverProcess } from "./route-solver-process";

async function openPack(request: SearchIntent, plan: SearchPlan, pack: SearchPlan["packs"][number], signal: AbortSignal) {
  const installed = await loadInstalledPackVersion(pack.id, pack.dataVersion);
  if (!installed) throw new ServerApiError("DATA_UNAVAILABLE", "The search's pinned data is no longer installed.", 503);
  const { filterGeometry, refinementGeometry } = plan.area;
  if (!filterGeometry) throw new Error("The search area has not been resolved");
  const predicates = [filterGeometry, ...(refinementGeometry ? [refinementGeometry] : [])];
  const namedRegionPredicateIndex = request.area.mode === "named-regions" ? 0 : refinementGeometry ? 1 : undefined;
  if (predicates.some((geometry, index) => !boundsOverlap(installed.manifest.coverage.bbox, eligibleAreaBounds(geometry, index === namedRegionPredicateIndex)))) return undefined;
  return {
    label: installed.manifest.name,
    session: await RouteSolverProcess.open({
      pack,
      criteria: request.criteria,
      accessFilter: {
        predicates,
        namedRegionPredicateIndex,
        coverage: installed.manifest.coverage.boundary,
      },
    }, signal),
  };
}

export async function generateSearch(request: SearchRequest, signal: AbortSignal): Promise<SearchResult> {
  const plan = await resolveSearchPlan(request, signal);
  if (request.area.mode === "drive-time") {
    const resolved = await defaultReachabilityService().resolveArea(request.area, signal);
    plan.area.filterGeometry = resolved.geometry;
  }
  const groups: Array<Pick<SearchResult, "exact" | "nearMisses">> = [];
  const messages = new Set<string>();
  let incomplete = false;
  let completed = 0;
  // A global requested count combines independent areas deterministically.
  // Bound concurrency to one solver so foreground requests do not multiply CPU load.
  for (const pack of plan.packs) {
    if (signal.aborted) throw signal.reason;
    const budget = CLOSED_ROUTE_EFFORT_BUDGETS.quick;
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(budget.deadlineMs + 5_000)]);
    let opened: Awaited<ReturnType<typeof openPack>>;
    try {
      opened = await openPack(request, plan, pack, deadline);
      if (!opened) continue;
      const result = await opened.session.generate({ searchEffort: "quick", limit: request.limit }, budget, deadline);
      completed += 1;
      groups.push({
        exact: result.exact.map((route) => namespaceRoute(route, pack.id, opened!.label)),
        nearMisses: result.nearMisses.map((route) => namespaceRoute(route, pack.id, opened!.label)),
      });
      if (result.diagnostics.hardTruncationReasons.length) {
        incomplete = true;
        messages.add("The computation limit stopped part of the search early.");
      }
    } catch {
      if (signal.aborted) throw signal.reason;
      incomplete = true;
      messages.add("Some eligible data could not be searched.");
    } finally {
      await opened?.session.close().catch(() => undefined);
    }
  }
  if (!completed && incomplete) throw new ServerApiError("SEARCH_UNAVAILABLE", "No eligible area could be searched. Check the selected area and installed data.", 503);
  const routes = combineRoutes(groups, request.limit);
  if (!routes.exact.length) messages.add("No routes matched all criteria. Close matches, when available, are listed separately.");
  return { request, area: plan.area, ...routes, incomplete, messages: [...messages] };
}

/** One retained search session owns the internal data sessions and their identities. */
export async function openSearchSession({ request, plan: originalPlan, signal }: {
  request: SearchIntent; plan: SearchPlan; signal: AbortSignal;
}) {
  const plan = await restorePlanArea(request.area, originalPlan);
  const sessions = new Map<string, NonNullable<Awaited<ReturnType<typeof openPack>>>>();
  const close = async () => {
    await Promise.allSettled([...sessions.values()].map(({ session }) => session.close()));
    sessions.clear();
  };
  try {
    for (const pack of plan.packs) {
      const opened = await openPack(request, plan, pack, signal);
      if (opened) sessions.set(pack.id, opened);
    }
  } catch (error) {
    await close();
    throw error;
  }
  return {
    async enumerateEligibleAccessPointIds(signal: AbortSignal) {
      const ids: string[] = [];
      for (const [packId, { session }] of sessions) {
        for (const id of await session.enumerateEligibleAccessPointIds(signal)) ids.push(namespacedId(packId, id));
      }
      return ids;
    },
    async searchAccessPoint(id: string, signal: AbortSignal) {
      const [packId, localId] = splitNamespacedId(id);
      const opened = sessions.get(packId);
      if (!opened) throw new Error("The starting point's data is unavailable");
      const result = await opened.session.searchAccessPoint(localId, signal);
      return {
        ...result,
        exact: result.exact.map((route) => namespaceRoute(route, packId, opened.label)),
        nearMisses: result.nearMisses.map((route) => namespaceRoute(route, packId, opened.label)),
      };
    },
    close,
  };
}
