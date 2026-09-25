import type { SearchIntent } from "@/lib/contracts";
import { loadInstallation } from "@/lib/coverage-install";
import { areaBounds } from "@/lib/graph";
import { namespacedId, namespaceRoute, splitNamespacedId } from "@/lib/search/identity";
import { ServerApiError } from "./api-error";
import { boundsOverlap, eligibleAreaBounds, executableInstallationId, restorePlanArea } from "./search-area";
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
