import type { SearchAreaSnapshot } from "@/lib/contracts";

/** Immutable data versions and area resolved for one search. */
export type SearchPlan = {
  packs: Array<{ id: string; dataVersion: string; builtAt: string }>;
  area: SearchAreaSnapshot;
};
