import { areaBounds, coordinateIsInsideArea, lineIsInsideArea, segmentIntersectsArea } from "@/lib/graph/geometry";
import type { AreaGeometry } from "@/lib/data/area-geometry";
import type { ProgressiveGraphStore } from "@/lib/data/progressive/store";
import type { CoverageSourceStore } from "./source-store";

/** Independent source-to-output reconciliation: every covered source segment must survive compilation. */
export async function reconcileInventory(raw: CoverageSourceStore, graph: ProgressiveGraphStore, coverage: AreaGeometry, checkpoint: () => Promise<void> = async () => {}) {
  await checkpoint();
  let steps = 0;
  const coverageBounds = areaBounds(coverage);
  const edge = graph.database.prepare("SELECT record FROM edges WHERE id=?");
  const record = raw.db.prepare("UPDATE inventory SET disposition=?,reason=? WHERE id=?");
  raw.db.exec("CREATE TABLE IF NOT EXISTS coverage_frontiers(node TEXT NOT NULL,way TEXT NOT NULL,lon REAL NOT NULL,lat REAL NOT NULL,PRIMARY KEY(node,way)); DELETE FROM coverage_frontiers");
  raw.db.exec("CREATE TABLE IF NOT EXISTS coverage_crossing_segments(way TEXT NOT NULL,segment INTEGER NOT NULL,from_lon REAL NOT NULL,from_lat REAL NOT NULL,to_lon REAL NOT NULL,to_lat REAL NOT NULL,PRIMARY KEY(way,segment)); DELETE FROM coverage_crossing_segments");
  const frontier = raw.db.prepare("INSERT OR IGNORE INTO coverage_frontiers VALUES(?,?,?,?)");
  const crossing = raw.db.prepare("INSERT OR IGNORE INTO coverage_crossing_segments VALUES(?,?,?,?,?,?)");
  let coveredSegments = 0;
  for (const { way } of raw.ways(coverage, 0)) {
    if (++steps % 1000 === 0) await checkpoint();
    if (way.edgeClass !== "trail") continue;
    let installed = 0;
    for (let segment = 0; segment < way.coordinates.length - 1; segment++) {
      if (++steps % 1000 === 0) await checkpoint();
      if (!lineIsInsideArea(way.coordinates.slice(segment, segment + 2), coverage)) {
        const from = way.coordinates[segment]!, to = way.coordinates[segment + 1]!;
        if (Math.max(from[0], to[0]) >= coverageBounds[0] && Math.min(from[0], to[0]) <= coverageBounds[2] &&
          Math.max(from[1], to[1]) >= coverageBounds[1] && Math.min(from[1], to[1]) <= coverageBounds[3] &&
          segmentIntersectsArea(from, to, coverage)) crossing.run(way.externalId, segment, ...from, ...to);
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
  const grouped = new Map<string, { disposition: string; reason: string; count: number }>();
  for (const row of raw.db.prepare("SELECT disposition,reason FROM inventory").iterate()) {
    if (++steps % 1000 === 0) await checkpoint();
    const disposition = String(row.disposition), reason = String(row.reason), key = JSON.stringify([disposition, reason]);
    const prior = grouped.get(key);
    if (prior) prior.count++;
    else grouped.set(key, { disposition, reason, count: 1 });
  }
  const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
  return { sourceId: raw.source.id, coveredSegments,
    frontierCount: Number(raw.db.prepare("SELECT count(*) AS count FROM coverage_frontiers").get()!.count),
    frontierPreview: raw.db.prepare("SELECT * FROM coverage_frontiers ORDER BY node,way LIMIT 100").all(),
    crossingSegmentCount: Number(raw.db.prepare("SELECT count(*) AS count FROM coverage_crossing_segments").get()!.count),
    crossingSegmentPreview: raw.db.prepare("SELECT way,segment,from_lon AS fromLon,from_lat AS fromLat,to_lon AS toLon,to_lat AS toLat FROM coverage_crossing_segments ORDER BY way,segment LIMIT 100").all(),
    dispositions: [...grouped.values()].sort((a, b) => compare(a.disposition, b.disposition) || compare(a.reason, b.reason)) };
}
