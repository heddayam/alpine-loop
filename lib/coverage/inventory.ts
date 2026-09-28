import type { AreaGeometry } from "@/lib/data/area-geometry";
import type { ProgressiveGraphStore } from "@/lib/data/progressive/store";
import { applyRestriction, type CuratedAccessFile } from "@/lib/data/curated-access";
import type { CoverageSourceStore } from "./source-store";

/** Reconcile exact discovered membership with compiled directed edges.
 * Envelopes bound the source query only; old source-wide dispositions cannot
 * exclude members or make unrelated networks part of this audit.
 */
export async function reconcileInventory(
  raw: CoverageSourceStore, graph: ProgressiveGraphStore, envelope: AreaGeometry,
  checkpoint: () => Promise<void>, segmentIncluded: (id: string) => boolean,
  restrictions: readonly CuratedAccessFile[],
) {
  await checkpoint();
  let steps = 0, coveredSegments = 0;
  const edge = graph.database.prepare("SELECT 1 FROM edges WHERE id=?");
  for (const {way} of raw.ways(envelope, 0)) {
    if (++steps % 1000 === 0) await checkpoint();
    if (way.edgeClass !== "trail") continue;
    let reviewed = way;
    for (const source of restrictions) {
      const restriction = source.restrictions.find(item => item.externalId === way.externalId);
      if (restriction) reviewed = applyRestriction(reviewed, restriction, source.snapshot.id);
    }
    for (let segment = 0; segment < way.coordinates.length - 1; segment++) {
      if (++steps % 1000 === 0) await checkpoint();
      const prefix = `${way.id}:${segment}`;
      if (!segmentIncluded(prefix)) continue;
      if (!["public", "unknown"].includes(reviewed.accessState))
        throw new Error(`Forbidden source segment in network membership: ${prefix}`);
      for (const suffix of way.bidirectional ? ["forward", "reverse"] : ["forward"]) {
        if (!edge.get(`${prefix}:${suffix}`)) throw new Error(`Unexplained compiler loss: ${prefix}:${suffix}`);
      }
      coveredSegments++;
    }
  }
  return {sourceId: raw.source.id, coveredSegments};
}
