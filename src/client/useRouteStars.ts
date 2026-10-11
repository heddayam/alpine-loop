import { useMemo, useState } from "react";
import type { JobSnapshot } from "../model.js";

type Stars = { ids: string[]; collapsed: boolean };
const emptyStars = (): Stars => ({ ids: [], collapsed: false });
export const routeStarsKey = (job: Pick<JobSnapshot, "id" | "resultsRevision">) =>
  `alpine-loop:route-stars:${job.id}:${job.resultsRevision ?? 0}`;

export function readRouteStars(key: string): Stars {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "null");
    if (value && Array.isArray(value.ids) && value.ids.every((id: unknown) => typeof id === "string")) {
      return { ids: [...new Set<string>(value.ids)], collapsed: value.collapsed === true };
    }
  } catch { /* Browser storage may be unavailable. */ }
  return emptyStars();
}

/** Personal pins belong to this browser and this immutable result publication. */
export function useRouteStars(job?: JobSnapshot) {
  const key = job ? routeStarsKey(job) : "";
  const [saved, setSaved] = useState<{ key: string; value: Stars }>();
  const value = useMemo(() => saved?.key === key ? saved.value : readRouteStars(key), [key, saved]);
  const ids = useMemo(() => new Set(value.ids), [value.ids]);
  const update = (next: Stars) => {
    if (!key) return;
    setSaved({ key, value: next });
    try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* Keep pins usable for this visit. */ }
  };
  return {
    ids,
    collapsed: value.collapsed,
    toggle: (id: string) => update({
      ...value,
      ids: ids.has(id) ? value.ids.filter(current => current !== id) : [...value.ids, id],
    }),
    toggleCollapsed: () => update({ ...value, collapsed: !value.collapsed }),
  };
}
