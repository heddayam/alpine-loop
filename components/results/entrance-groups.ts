import type { GeneratedClosedRouteV3 } from "@/lib/contracts";

export type EntranceRouteGroup<T> = { entries: Array<{ route: T; index: number }> };

/** Collapse only proven alternate entrances to the identical physical loop.
 * Call separately for exact and close matches. Every original route survives;
 * repeated candidates at one entrance get their own representative row. */
export function entranceRouteGroups<T extends Pick<GeneratedClosedRouteV3, "startAccessPoint" | "physicalLoopId">>(
  routes: readonly T[],
  indexOffset = 0,
): EntranceRouteGroup<T>[] {
  const groups: EntranceRouteGroup<T>[] = [];
  const candidates = new Map<string, EntranceRouteGroup<T>[]>();
  routes.forEach((route, index) => {
    const family = route.startAccessPoint.entranceFamilyId;
    const key = family && route.physicalLoopId ? JSON.stringify([family, route.physicalLoopId]) : undefined;
    const matching = key ? candidates.get(key) ?? [] : [];
    const group = matching.find(({ entries }) => entries.every(({ route: member }) => member.startAccessPoint.id !== route.startAccessPoint.id));
    const entry = { route, index: indexOffset + index };
    if (group) group.entries.push(entry);
    else {
      const created = { entries: [entry] };
      groups.push(created);
      if (key) candidates.set(key, [...matching, created]);
    }
  });
  return groups;
}
