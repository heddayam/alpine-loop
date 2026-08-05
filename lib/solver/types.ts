import type { GenerateClosedRoutesResponseV3 } from "@/lib/contracts";
import type { AreaGeometry } from "@/lib/graph";

export type ResolvedAccessFilterContext = {
  summary: GenerateClosedRoutesResponseV3["resolvedAccessFilter"];
  predicates: readonly AreaGeometry[];
  coverage: AreaGeometry;
};
