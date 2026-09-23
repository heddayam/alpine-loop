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
import { solverWorkerCount, parallelMap } from "./solver-concurrency";

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
  const outcomes = await parallelMap(plan.packs, solverWorkerCount(), async (pack) => {
    if (signal.aborted) throw signal.reason;
    const budget = CLOSED_ROUTE_EFFORT_BUDGETS.quick;
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(budget.deadlineMs + 5_000)]);
    let opened: Awaited<ReturnType<typeof openPack>>;
    try {
      opened = await openPack(request, plan, pack, deadline);
      if (!opened) return undefined;
      const result = await opened.session.generate({ searchEffort: "quick", limit: request.limit }, budget, deadline);
      return {
        routes: {
          exact: result.exact.map((route) => namespaceRoute(route, pack.id, opened!.label)),
          nearMisses: result.nearMisses.map((route) => namespaceRoute(route, pack.id, opened!.label)),
        },
        incomplete: result.diagnostics.hardTruncationReasons.length > 0,
      };
    } catch {
      if (signal.aborted) throw signal.reason;
      return { incomplete: true };
    } finally {
      await opened?.session.close().catch(() => undefined);
    }
  });
  const groups: Array<Pick<SearchResult, "exact" | "nearMisses">> = [];
  const messages = new Set<string>();
  let incomplete = false;
  for (const outcome of outcomes) {
    if (!outcome) continue;
    if (outcome.routes) groups.push(outcome.routes);
    if (outcome.incomplete) {
      incomplete = true;
      messages.add(outcome.routes
        ? "The computation limit stopped part of the search early."
        : "Some eligible data could not be searched.");
    }
  }
  if (!groups.length && incomplete) throw new ServerApiError("SEARCH_UNAVAILABLE", "No eligible area could be searched. Check the selected area and installed data.", 503);
  const routes = combineRoutes(groups, request.limit);
  if (!routes.exact.length) messages.add("No routes matched all criteria. Close matches, when available, are listed separately.");
  return { request, area: plan.area, ...routes, incomplete, messages: [...messages] };
}

/** A bounded set of lazy slots retains readers only for actively searched packs. */
export async function openSearchSession({ request, plan: originalPlan, signal }: {
  request: SearchIntent; plan: SearchPlan; signal: AbortSignal;
}) {
  const plan = await restorePlanArea(request.area, originalPlan);
  const controller = new AbortController();
  const lifetime = AbortSignal.any([signal, controller.signal]);
  const concurrency = solverWorkerCount();
  type Opened = NonNullable<Awaited<ReturnType<typeof openPack>>>;
  const slots = Array.from({ length: concurrency }, () => ({
    packId: "", opened: undefined as Opened | undefined, tail: Promise.resolve(),
  }));
  let nextSlot = 0;
  return {
    concurrency,
    async enumerateEligibleAccessPointIds(signal: AbortSignal) {
      const ids: string[] = [];
      // Discovery closes each reader immediately, so pack count never sets the
      // number of idle processes or retained graph caches.
      for (const pack of plan.packs) {
        const combined = AbortSignal.any([lifetime, signal]);
        combined.throwIfAborted();
        const opened = await openPack(request, plan, pack, combined);
        try {
          if (opened) for (const id of await opened.session.enumerateEligibleAccessPointIds(combined)) {
            ids.push(namespacedId(pack.id, id));
          }
        } finally { await opened?.session.close(); }
      }
      return ids;
    },
    async searchAccessPoint(id: string, signal: AbortSignal) {
      const slot = slots[nextSlot++ % slots.length]!;
      const combined = AbortSignal.any([lifetime, signal]);
      const operation = slot.tail.then(async () => {
        combined.throwIfAborted();
        const [packId, localId] = splitNamespacedId(id);
        try {
          if (slot.packId !== packId || !slot.opened) {
            await slot.opened?.session.close();
            slot.opened = undefined;
            const pack = plan.packs.find((pack) => pack.id === packId);
            if (!pack) throw new Error("The starting point's data is unavailable");
            slot.opened = await openPack(request, plan, pack, combined);
            slot.packId = packId;
          }
          if (!slot.opened) throw new Error("The starting point's data is unavailable");
          const opened = slot.opened;
          const result = await opened.session.searchAccessPoint(localId, combined);
          return {
            ...result,
            exact: result.exact.map((route) => namespaceRoute(route, packId, opened.label)),
            nearMisses: result.nearMisses.map((route) => namespaceRoute(route, packId, opened.label)),
          };
        } catch (error) {
          await slot.opened?.session.close().catch(() => undefined);
          slot.opened = undefined;
          throw error;
        }
      });
      slot.tail = operation.then(() => undefined, () => undefined);
      return operation;
    },
    async close() {
      controller.abort(new DOMException("Search session closed", "AbortError"));
      await Promise.all(slots.map(async (slot) => {
        await slot.tail;
        await slot.opened?.session.close().catch(() => undefined);
        slot.opened = undefined;
      }));
    },
  };
}
