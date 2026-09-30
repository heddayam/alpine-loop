import type { SearchAreaSnapshot } from "@/lib/contracts";

/** One immutable installed subset and the resolved area for one search. */
export type SearchPlan = {
  /** Null is reserved for archived legacy jobs; their saved geometry is readable. */
  installationId: string | null;
  area: SearchAreaSnapshot;
};
