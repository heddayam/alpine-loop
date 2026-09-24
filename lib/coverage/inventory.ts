import { coordinateIsInsideArea, lineIsInsideArea } from "@/lib/graph/geometry";
import type { AreaGeometry } from "@/lib/data/area-geometry";
import type { ProgressiveGraphStore } from "@/lib/data/progressive/store";
import type { CoverageSourceStore } from "./source-store";

/** Independent source-to-output reconciliation: every covered source segment must survive compilation. */
export function reconcileInventory(raw: CoverageSourceStore, graph: ProgressiveGraphStore, coverage: AreaGeometry) {
  const edge = graph.database.prepare("SELECT record FROM edges WHERE id=?");
  const record = raw.db.prepare("UPDATE inventory SET disposition=?,reason=? WHERE id=?");
  raw.db.exec("CREATE TABLE IF NOT EXISTS coverage_frontiers(node TEXT NOT NULL,way TEXT NOT NULL,lon REAL NOT NULL,lat REAL NOT NULL,PRIMARY KEY(node,way)); DELETE FROM coverage_frontiers");
  const frontier = raw.db.prepare("INSERT OR IGNORE INTO coverage_frontiers VALUES(?,?,?,?)");
  let coveredSegments = 0;
  for (const { way } of raw.ways(coverage, 0)) {
    if (way.edgeClass !== "trail") continue;
    let installed = 0;
    for (let segment = 0; segment < way.coordinates.length - 1; segment++) {
      if (!lineIsInsideArea(way.coordinates.slice(segment, segment + 2), coverage)) {
        for (const index of [segment, segment + 1]) {
          const position = way.coordinates[index]!;
          if (coordinateIsInsideArea(position, coverage)) frontier.run(way.nodeIds[index]!, way.externalId, ...position);
        }
        continue;
      }
      const prefix = `${way.id}:${segment}`;
      for (const suffix of way.bidirectional ? ["forward", "reverse"] : ["forward"]) {
        if (!edge.get(`${prefix}:${suffix}`)) throw new Error(`Unexplained compiler loss: ${prefix}:${suffix}`);
      }
      installed++;
    }
    coveredSegments += installed;
    const staged = graph.database.prepare("SELECT record FROM ways WHERE id=?").get(way.id);
    const access = staged ? (JSON.parse(String(staged.record)) as { accessState: string }).accessState : way.accessState;
    const restricted = !["public", "unknown"].includes(access);
    record.run(restricted ? "restricted" : installed === way.coordinates.length - 1 ? "installed" : "pending", restricted ? `access:${access}` : installed ? "covered-source-segments-reconciled" : "outside-installed-coverage", way.externalId);
  }
  return { sourceId: raw.source.id, coveredSegments,
    frontierCount: Number(raw.db.prepare("SELECT count(*) AS count FROM coverage_frontiers").get()!.count),
    frontierPreview: raw.db.prepare("SELECT * FROM coverage_frontiers ORDER BY node,way LIMIT 100").all(),
    dispositions: raw.db.prepare("SELECT disposition,reason,count(*) AS count FROM inventory GROUP BY disposition,reason ORDER BY disposition,reason").all() };
}
