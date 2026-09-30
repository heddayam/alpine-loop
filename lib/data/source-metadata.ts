import { packSourceSchema } from "@/lib/contracts/manifest";
import type { DataRelease } from "@/lib/contracts/releases";

type Source = DataRelease["sources"][number];

function sourceContent(source: Source): string {
  // Schema parsing gives every field a stable order and validates provenance,
  // including the retrieval date that is omitted only from content equality.
  return JSON.stringify(Object.fromEntries(
    Object.entries(packSourceSchema.parse(source)).filter(([field]) => field !== "retrievedAt"),
  ));
}

/** Retrieval dates describe individual acquisitions of otherwise identical bytes. */
export function sameSourceContent(left: Source, right: Source): boolean {
  return sourceContent(left) === sourceContent(right);
}

/** A catalog retains one deterministic receipt per source without rewriting artifacts. */
export function mergeCatalogSources(sources: readonly Source[]): DataRelease["sources"] {
  const merged = new Map<string, Source>();
  for (const input of sources) {
    const source = packSourceSchema.parse(input), prior = merged.get(source.id);
    if (prior && !sameSourceContent(prior, source)) throw new Error(`Conflicting source metadata ${source.id}`);
    if (!prior || Date.parse(source.retrievedAt) < Date.parse(prior.retrievedAt) ||
      (Date.parse(source.retrievedAt) === Date.parse(prior.retrievedAt) && source.retrievedAt < prior.retrievedAt)) {
      merged.set(source.id, source);
    }
  }
  return [...merged.values()].sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}
