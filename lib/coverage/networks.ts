import { canonicalTopologyJson } from "@/lib/graph/topology-hash";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { AreaGeometry } from "@/lib/data/area-geometry";
import type { NormalizedNode, NormalizedWay } from "@/lib/data/types";
import { lineIsInsideArea } from "@/lib/graph/geometry";
import { DiskUnion } from "@/lib/data/progressive/portals";
import { applyRestriction, type CuratedAccessFile } from "@/lib/data/curated-access";
import { intersectCoverage, rectangle } from "./geometry";
import type { CoverageSourceStore } from "./source-store";
import { distanceMeters } from "@/lib/data/metrics";
import type { TrailNetwork } from "./discovery-catalog";
export type { TrailNetwork } from "./discovery-catalog";
/** Disk-backed union-find over source identities, never proximity or request-area clipping.
 * The only cuts are unsupported source coverage, explicit exclusions and forbidden access.
 * Geometry is an envelope, not membership.
 */
export class NetworkInventory {
    readonly db: DatabaseSync;
    constructor(file: string, readOnly = false) {
        this.db = new DatabaseSync(file, {readOnly});
        if (readOnly) {
            this.db.exec("PRAGMA cache_size=-16384; PRAGMA temp_store=FILE");
            return;
        }
        this.db.exec(`PRAGMA journal_mode=OFF; PRAGMA cache_size=-16384; PRAGMA temp_store=FILE;
      CREATE TABLE nodes(id TEXT PRIMARY KEY,record TEXT NOT NULL,parent TEXT NOT NULL,rank INTEGER NOT NULL DEFAULT 0,boundary INTEGER NOT NULL DEFAULT 0) STRICT;
      CREATE TABLE ways(id TEXT PRIMARY KEY,record TEXT NOT NULL) STRICT;
      CREATE TABLE segments(id TEXT PRIMARY KEY,way TEXT NOT NULL,ordinal INTEGER NOT NULL,a TEXT NOT NULL,b TEXT NOT NULL,root TEXT) STRICT;
      CREATE INDEX segments_root ON segments(root,id);
      CREATE TABLE boundaries(id TEXT PRIMARY KEY) STRICT;`);
    }
    close() { this.db.close(); }
    async discover(raws: readonly Pick<CoverageSourceStore, "ways">[], supported: AreaGeometry, restrictions: readonly CuratedAccessFile[], checkpoint: () => Promise<void>): Promise<TrailNetwork[]> {
        await checkpoint();
        const db = this.db, union = new DiskUnion(db, "nodes");
        // This unpublished scratch inventory is discarded on failure; one disk-backed
        // transaction avoids a filesystem commit for every source segment.
        db.exec("BEGIN");
        try {
            const getNode = db.prepare("SELECT record FROM nodes WHERE id=?"), getWay = db.prepare("SELECT record FROM ways WHERE id=?");
            const node = db.prepare("INSERT INTO nodes(id,record,parent) VALUES (?,?,?)"), way = db.prepare("INSERT INTO ways VALUES (?,?)");
            const segment = db.prepare("INSERT OR IGNORE INTO segments VALUES (?,?,?,?,?,NULL)");
            const boundary = db.prepare("INSERT OR IGNORE INTO boundaries VALUES (?)");
            let work = 0;
            const merge = (table: "nodes" | "ways", value: NormalizedNode | NormalizedWay, prior: Record<string, unknown> | undefined) => {
                if (!prior)
                    return canonicalTopologyJson({...value,sourceRefs:[...new Set(value.sourceRefs)].sort()});
                const old = JSON.parse(String(prior.record)) as typeof value;
                const { sourceRefs: a, ...before } = old, { sourceRefs: b, ...after } = value;
                if (canonicalTopologyJson(before) !== canonicalTopologyJson(after))
                    throw new Error(`Conflicting overlapping source ${table}: ${value.id}`);
                const merged = canonicalTopologyJson({ ...old, sourceRefs: [...new Set([...a, ...b])].sort() });
                db.prepare(`UPDATE ${table} SET record=? WHERE id=?`).run(merged, value.id);
                return null;
            };
            for (const raw of raws)
                for (const item of raw.ways(supported, 0)) {
                    if (++work % 1000 === 0)
                        await checkpoint();
                    let current = item.way;
                    for (const file of restrictions) {
                        const rule = file.restrictions.find(rule => rule.externalId === current.externalId);
                        if (rule)
                            current = applyRestriction(current, rule, file.snapshot.id);
                    }
                    if (current.edgeClass !== "trail" || !["public", "unknown"].includes(current.accessState))
                        continue;
                    const record = merge("ways", current, getWay.get(current.id));
                    if (record)
                        way.run(current.id, record);
                    for (const value of item.nodes) {
                        const record = merge("nodes", value, getNode.get(value.id));
                        if (record) node.run(value.id, record, value.id);
                    }
                    for (let i = 0; i < current.nodeIds.length - 1; i++) {
                        if (++work % 1000 === 0)
                            await checkpoint();
                        const line = current.coordinates.slice(i, i + 2);
                        if (!lineIsInsideArea(line, supported)) {
                            boundary.run(current.nodeIds[i]!);
                            boundary.run(current.nodeIds[i + 1]!);
                            continue;
                        }
                        for (const value of item.nodes.slice(i, i + 2)) {
                            const record = merge("nodes", value, getNode.get(value.id));
                            if (record)
                                node.run(value.id, record, value.id);
                            // A segment ending at a source boundary need not have an outside segment in the extract.
                            const d = 1e-8, { lon: x, lat: y } = value;
                            if (!lineIsInsideArea([[x - d, y], [x + d, y]], supported) || !lineIsInsideArea([[x, y - d], [x, y + d]], supported))
                                boundary.run(value.id);
                        }
                        segment.run(`${current.id}:${i}`, current.id, i, current.nodeIds[i]!, current.nodeIds[i + 1]!);
                        union.union(current.nodeIds[i]!, current.nodeIds[i + 1]!);
                    }
                }
            const assign = db.prepare("UPDATE segments SET root=? WHERE id=?");
            for (const row of db.prepare("SELECT id,a FROM segments ORDER BY id").iterate()) {
                if (++work % 1000 === 0)
                    await checkpoint();
                assign.run(union.find(String(row.a)), row.id);
            }
            db.exec("UPDATE nodes SET boundary=1 WHERE id IN (SELECT id FROM boundaries)");
            const result: TrailNetwork[] = [];
            db.exec("CREATE TEMP TABLE members(id TEXT PRIMARY KEY) STRICT");
            for (const row of db.prepare("SELECT root FROM segments GROUP BY root ORDER BY root").iterate()) {
                const root = String(row.root), hash = createHash("sha256");
                let count = 0, lengthMeters = 0, w = Infinity, s = Infinity, e = -Infinity, n = -Infinity, limited = false;
                db.exec("DELETE FROM members");
                const add = db.prepare("INSERT OR IGNORE INTO members VALUES (?)");
                for (const part of db.prepare("SELECT s.*,w.record FROM segments s JOIN ways w ON w.id=s.way WHERE s.root=? ORDER BY s.id").iterate(root)) {
                    if (++work % 1000 === 0)
                        await checkpoint();
                    // Component identity depends on local source records, not unrelated networks or selection geometry.
                    const current = JSON.parse(String(part.record)) as NormalizedWay, i = Number(part.ordinal);
                    hash.update(JSON.stringify([part.id, current.nodeIds.slice(i, i + 2), current.coordinates.slice(i, i + 2), current.accessState, current.bidirectional, current.flags, current.name, current.sourceRefs]));
                    count++;
                    lengthMeters += distanceMeters(current.coordinates[i]!, current.coordinates[i + 1]!);
                    add.run(part.a);
                    add.run(part.b);
                }
                let nodeCount = 0;
                for (const member of db.prepare("SELECT n.record,n.boundary FROM nodes n JOIN members m ON m.id=n.id ORDER BY n.id").iterate()) {
                    if (++work % 1000 === 0)
                        await checkpoint();
                    const node = JSON.parse(String(member.record)) as NormalizedNode;
                    nodeCount++;
                    limited ||= Boolean(member.boundary);
                    w = Math.min(w, node.lon);
                    s = Math.min(s, node.lat);
                    e = Math.max(e, node.lon);
                    n = Math.max(n, node.lat);
                }
                // A non-zero envelope supports point/line networks while respecting source exclusions.
                const geometry = intersectCoverage(rectangle([w - 1e-7, s - 1e-7, e + 1e-7, n + 1e-7]), supported)!;
                result.push({ id: `network-${hash.digest("hex").slice(0, 32)}`, root, geometry, nodeCount, physicalEdgeCount: count, lengthMeters, cycleRank: count - nodeCount + 1, sourceBoundaryLimited: limited });
            }
            await checkpoint();
            db.exec("COMMIT");
            return result.sort((a, b) => a.id.localeCompare(b.id));
        } catch (error) {
            if (db.isTransaction) db.exec("ROLLBACK");
            throw error;
        }
    }
    *segments(network: TrailNetwork) {
        for (const row of this.db.prepare("SELECT s.id,s.ordinal,w.record FROM segments s JOIN ways w ON w.id=s.way WHERE s.root=? ORDER BY s.id").iterate(network.root))
            yield { id: String(row.id), segment: Number(row.ordinal), way: JSON.parse(String(row.record)) as NormalizedWay };
    }
    *ways(network: TrailNetwork) {
        for (const row of this.db.prepare("SELECT record FROM ways WHERE id IN (SELECT way FROM segments WHERE root=?) ORDER BY id").iterate(network.root))
            yield JSON.parse(String(row.record)) as NormalizedWay;
    }
    node(id: string): NormalizedNode { return JSON.parse(String(this.db.prepare("SELECT record FROM nodes WHERE id=?").get(id)!.record)); }
}
