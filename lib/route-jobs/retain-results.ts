import type { RouteCriteria } from "@/lib/contracts";
import { rankRouteMetrics } from "@/lib/solver/route-quality";
import type { RouteJobResult } from "./types";

/** Each set already passed the solver's physical diversity check. Without its
 * edge identities, mixing the sets cannot preserve that check, so retain the
 * better complete set. Later attempts may improve routes but cannot reduce the
 * number of distinct exact loops or replace them with a worse aggregate score.
 */
export function retainBetterResults(
  previous: RouteJobResult[],
  incoming: RouteJobResult[],
  criteria: RouteCriteria,
): RouteJobResult[] {
  if (!previous.length) return incoming;
  if (!incoming.length) return previous;
  const quality = (results: readonly RouteJobResult[]) => {
    const exact = results.filter(result => result.matchType === "exact");
    const count = new Set(exact.map(({ route }) => route.physicalLoopId ?? route.id)).size;
    const scored = (count > 0 ? exact : results).map(result => {
      const score = rankRouteMetrics(result.route, { ...criteria, limit: 10 }).score;
      const violations = result.matchType === "near-miss" ? result.route.violations : [];
      return { score, violations: violations.length, delta: violations.reduce((sum, item) => sum + item.normalizedDelta, 0) };
    });
    return {
      count,
      violations: scored.reduce((sum, value) => sum + value.violations, 0),
      delta: scored.reduce((sum, value) => sum + value.delta, 0),
      score: scored.reduce((sum, value) => sum + value.score, 0),
      tie: results.map(result => result.route.id).sort().join("\n"),
    };
  };
  const current = quality(previous), next = quality(incoming);
  const comparison = current.count - next.count
    || next.violations - current.violations
    || next.delta - current.delta
    || next.score - current.score
    || next.tie.localeCompare(current.tie);
  return comparison < 0 ? incoming : previous;
}
