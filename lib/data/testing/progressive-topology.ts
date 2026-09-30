import { createHash } from "node:crypto";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { CLOSED_ROUTE_TOPOLOGY_ALGORITHM_VERSION, CLOSED_ROUTE_TOPOLOGY_FORMAT_VERSION } from "@/lib/graph/closed-route-topology";
import { canonicalTopologyJson, topologySha256 } from "@/lib/graph/topology-hash";
import type { PackManifest } from "@/lib/contracts";

type Row = Record<string, string | number | null>;
// Fixed SQL only; each invocation owns its cache. Iterators remain uncached.
const statementCaches = new WeakMap<DatabaseSync, Map<string, StatementSync>>();
function statement(db: DatabaseSync, sql: string): StatementSync {
  const cache = statementCaches.get(db)!;
  let prepared = cache.get(sql);
  if (!prepared) { prepared = db.prepare(sql); cache.set(sql, prepared); }
  return prepared;
}

const one = (db: DatabaseSync, sql: string, ...args: Array<string | number>) => statement(db, sql).get(...args) as Row | undefined;
const rows = (db: DatabaseSync, sql: string, ...args: Array<string | number>) => db.prepare(sql).iterate(...args) as Iterable<Row>;
const run = (db: DatabaseSync, sql: string, ...args: Array<string | number | null>) => statement(db, sql).run(...args);
const number = (row: Row | undefined, key: string) => Number(row?.[key] ?? 0);

async function scc(db: DatabaseSync, checkpoint: () => Promise<void>): Promise<void> {
  let work = 0;
  await checkpoint();
  let finish = 0;
  db.exec("CREATE TEMP TABLE dfs(depth INTEGER PRIMARY KEY,k INTEGER NOT NULL,last_edge INTEGER NOT NULL, parent INTEGER NOT NULL, parent_phy INTEGER NOT NULL) STRICT;");
  for (const start of rows(db, "SELECT node_key AS k FROM nodes ORDER BY node_key")) {
    if (++work % 1000 === 0) await checkpoint();
    const key = Number(start.k);
    if (number(one(db, "SELECT seen FROM work_nodes WHERE k=?", key), "seen")) continue;
    run(db, "UPDATE work_nodes SET seen=1 WHERE k=?", key);
    run(db, "INSERT INTO dfs VALUES (1,?,0,0,0)", key);
    let depth = 1;
    while (depth) {
      if (++work % 1000 === 0) await checkpoint();
      const frame = one(db, "SELECT k,last_edge FROM dfs WHERE depth=?", depth)!;
      const node = Number(frame.k);
      const next = one(db, "SELECT edge_key AS e,to_key AS k FROM work_edges WHERE from_key=? AND edge_key>? ORDER BY edge_key LIMIT 1", node, Number(frame.last_edge));
      if (next) {
        run(db, "UPDATE dfs SET last_edge=? WHERE depth=?", Number(next.e), depth);
        if (!number(one(db, "SELECT seen FROM work_nodes WHERE k=?", Number(next.k)), "seen")) {
          run(db, "UPDATE work_nodes SET seen=1 WHERE k=?", Number(next.k));
          run(db, "INSERT INTO dfs VALUES (?,?,0,0,0)", ++depth, Number(next.k));
        }
      } else {
        run(db, "UPDATE work_nodes SET finish=? WHERE k=?", ++finish, node);
        run(db, "DELETE FROM dfs WHERE depth=?", depth--);
      }
    }
  }
  db.exec("CREATE TEMP TABLE todo(seq INTEGER PRIMARY KEY,k INTEGER NOT NULL) STRICT;");
  let component = 0, sequence = 0;
  for (const item of rows(db, "SELECT k FROM work_nodes ORDER BY finish DESC")) {
    if (++work % 1000 === 0) await checkpoint();
    const start = Number(item.k);
    if (number(one(db, "SELECT scc FROM work_nodes WHERE k=?", start), "scc")) continue;
    component += 1;
    run(db, "UPDATE work_nodes SET scc=? WHERE k=?", component, start);
    run(db, "INSERT INTO todo VALUES (?,?)", ++sequence, start);
    for (;;) {
      if (++work % 1000 === 0) await checkpoint();
      const top = one(db, "SELECT seq,k FROM todo ORDER BY seq DESC LIMIT 1");
      if (!top) break;
      run(db, "DELETE FROM todo WHERE seq=?", Number(top.seq));
      for (const edge of rows(db, "SELECT from_key AS k FROM work_edges WHERE to_key=? ORDER BY edge_key", Number(top.k))) {
        if (++work % 1000 === 0) await checkpoint();
        const key = Number(edge.k);
        if (number(one(db, "SELECT scc FROM work_nodes WHERE k=?", key), "scc")) continue;
        run(db, "UPDATE work_nodes SET scc=? WHERE k=?", component, key);
        run(db, "INSERT INTO todo VALUES (?,?)", ++sequence, key);
      }
    }
  }
  db.exec("DROP TABLE todo; DELETE FROM dfs;");
}

async function seedCycles(db: DatabaseSync, checkpoint: () => Promise<void>): Promise<void> {
  let work = 0;
  await checkpoint();
  let time = 0;
  db.exec(`CREATE TEMP TABLE bridges(physical_edge_key INTEGER PRIMARY KEY) STRICT;
    CREATE INDEX work_physical_from ON work_physical(from_key,physical_edge_key);
    CREATE INDEX work_physical_to ON work_physical(to_key,physical_edge_key);`);
  for (const item of rows(db, "SELECT k FROM work_nodes ORDER BY k")) {
    if (++work % 1000 === 0) await checkpoint();
    const root = Number(item.k);
    if (number(one(db, "SELECT disc FROM work_nodes WHERE k=?", root), "disc")) continue;
    run(db, "UPDATE work_nodes SET disc=?,low=? WHERE k=?", ++time, time, root);
    run(db, "INSERT INTO dfs VALUES (?,?,0,0,0)", 1, root);
    let depth = 1;
    while (depth) {
      if (++work % 1000 === 0) await checkpoint();
      const frame = one(db, "SELECT k,last_edge,parent,parent_phy FROM dfs WHERE depth=?", depth)!;
      const node = Number(frame.k);
      const next = one(db, `SELECT physical_edge_key AS e, CASE WHEN from_key=? THEN to_key ELSE from_key END AS k
        FROM work_physical WHERE (from_key=? OR to_key=?) AND physical_edge_key>? ORDER BY physical_edge_key LIMIT 1`, node, node, node, Number(frame.last_edge));
      if (next) {
        const edge = Number(next.e), other = Number(next.k);
        run(db, "UPDATE dfs SET last_edge=? WHERE depth=?", edge, depth);
        if (edge === Number(frame.parent_phy)) continue;
        const state = one(db, "SELECT disc,low FROM work_nodes WHERE k=?", other)!;
        if (Number(state.disc)) {
          const own = one(db, "SELECT low FROM work_nodes WHERE k=?", node)!;
          if (Number(state.disc) < Number(own.low)) run(db, "UPDATE work_nodes SET low=? WHERE k=?", Number(state.disc), node);
        } else {
          run(db, "UPDATE work_nodes SET disc=?,low=? WHERE k=?", ++time, time, other);
          run(db, "INSERT INTO dfs VALUES (?,?,0,?,?)", ++depth, other, node, edge);
        }
      } else {
        run(db, "DELETE FROM dfs WHERE depth=?", depth--);
        const parent = Number(frame.parent);
        if (parent) {
          const childLow = number(one(db, "SELECT low FROM work_nodes WHERE k=?", node), "low");
          const parentState = one(db, "SELECT disc,low FROM work_nodes WHERE k=?", parent)!;
          if (childLow > Number(parentState.disc)) run(db, "INSERT INTO bridges VALUES (?)", Number(frame.parent_phy));
          if (childLow < Number(parentState.low)) run(db, "UPDATE work_nodes SET low=? WHERE k=?", childLow, parent);
        }
      }
    }
  }
  db.exec(`CREATE TEMP TABLE seeds(k INTEGER PRIMARY KEY) STRICT;
    INSERT OR IGNORE INTO seeds SELECT from_key FROM work_physical WHERE physical_edge_key NOT IN (SELECT physical_edge_key FROM bridges);
    INSERT OR IGNORE INTO seeds SELECT to_key FROM work_physical WHERE physical_edge_key NOT IN (SELECT physical_edge_key FROM bridges);
    DROP TABLE dfs;`);
}

async function distances(db: DatabaseSync, checkpoint: () => Promise<void>): Promise<void> {
  let work = 0;
  await checkpoint();
  db.exec(`CREATE TEMP TABLE queue(k INTEGER PRIMARY KEY,dist REAL NOT NULL,portal INTEGER NOT NULL) STRICT;
    CREATE INDEX queue_priority ON queue(dist,portal,k);
    UPDATE work_nodes SET dist=0,portal=k WHERE k IN (SELECT k FROM seeds);
    INSERT INTO queue SELECT k,0,k FROM seeds;`);
  for (;;) {
    if (++work % 1000 === 0) await checkpoint();
    const item = one(db, "SELECT k,dist,portal FROM queue ORDER BY dist,portal,k LIMIT 1");
    if (!item) break;
    const current = Number(item.k), dist = Number(item.dist), portal = Number(item.portal);
    run(db, "DELETE FROM queue WHERE k=?", current);
    if (number(one(db, "SELECT settled FROM work_nodes WHERE k=?", current), "settled")) continue;
    run(db, "UPDATE work_nodes SET settled=1 WHERE k=?", current);
    const currentScc = number(one(db, "SELECT scc FROM work_nodes WHERE k=?", current), "scc");
    for (const edge of rows(db, "SELECT edge_key,from_key,length_m FROM work_edges WHERE to_key=? ORDER BY edge_key", current)) {
      if (++work % 1000 === 0) await checkpoint();
      const previous = Number(edge.from_key);
      const state = one(db, "SELECT dist,portal,settled,scc FROM work_nodes WHERE k=?", previous)!;
      if (Number(state.settled) || Number(state.scc) !== currentScc) continue;
      const candidate = dist + Number(edge.length_m);
      if (state.dist !== null && (candidate > Number(state.dist) || (candidate === Number(state.dist) && portal >= Number(state.portal)))) continue;
      run(db, "UPDATE work_nodes SET dist=?,portal=?,next_edge=? WHERE k=?", candidate, portal, Number(edge.edge_key), previous);
      run(db, "INSERT INTO queue VALUES (?,?,?) ON CONFLICT(k) DO UPDATE SET dist=excluded.dist,portal=excluded.portal", previous, candidate, portal);
    }
  }
  db.exec("DROP TABLE queue;");
}

async function connectorHash(db: DatabaseSync, start: number, portal: number, checkpoint: () => Promise<void>): Promise<string> {
  let work = 0;
  await checkpoint();
  const hash = createHash("sha256");
  hash.update(`{"algorithmVersion":${JSON.stringify(CLOSED_ROUTE_TOPOLOGY_ALGORITHM_VERSION)},"directedEdgeIds":[`);
  let current = start, count = 0;
  while (current !== portal) {
    if (++work % 1000 === 0) await checkpoint();
    const edge = one(db, "SELECT e.id,e.to_node FROM work_nodes w JOIN edges e ON e.edge_key=w.next_edge WHERE w.k=?", current);
    if (!edge) throw new Error(`Missing cycle connector from node ${current}`);
    if (count++) hash.update(",");
    hash.update(JSON.stringify(edge.id));
    current = number(one(db, "SELECT node_key AS k FROM nodes WHERE id=?", String(edge.to_node)), "k");
    if (count > number(one(db, "SELECT count(*) AS n FROM nodes"), "n")) throw new Error("Cycle connector repeats a node");
  }
  hash.update("]}");
  return `sha256:${hash.digest("hex")}`;
}

/** Publish scratch work in bounded transactions, never across an async checkpoint. */
export async function writeProgressiveTopology(db: DatabaseSync, manifest: PackManifest, checkpoint: () => Promise<void> = async () => {}, compact = false): ReturnType<typeof deriveTopology> {
  if (db.isTransaction) throw new Error("Topology derivation requires no active transaction");
  if (statementCaches.has(db)) throw new Error("Topology derivation is already running");
  statementCaches.set(db, new Map());
  const nextBatch = async () => {
    if (db.isTransaction) db.exec("COMMIT");
    await checkpoint();
    db.exec("BEGIN IMMEDIATE");
  };
  try {
    const result = await deriveTopology(db, manifest, nextBatch, compact);
    db.exec("COMMIT");
    return result;
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  } finally { statementCaches.delete(db); }
}

async function deriveTopology(db: DatabaseSync, manifest: PackManifest, checkpoint: () => Promise<void>, compact: boolean): Promise<{ hash: string; profiles: Array<{ profile: "known" | "inclusive"; hash: string; feasible: number; physical: number }> }> {
  let work = 0;
  const summaries: Array<{ profile: "known" | "inclusive"; hash: string; feasible: number; physical: number }> = [];
  for (const profile of ["known", "inclusive"] as const) {
    await checkpoint();
    db.exec(`CREATE TEMP TABLE work_nodes(k INTEGER PRIMARY KEY,seen INTEGER NOT NULL DEFAULT 0,finish INTEGER,scc INTEGER NOT NULL DEFAULT 0,disc INTEGER NOT NULL DEFAULT 0,low INTEGER NOT NULL DEFAULT 0,dist REAL,portal INTEGER,settled INTEGER NOT NULL DEFAULT 0,next_edge INTEGER) STRICT;
      INSERT INTO work_nodes(k) SELECT node_key FROM nodes;
      CREATE TEMP TABLE work_edges(edge_key INTEGER PRIMARY KEY,physical_edge_key INTEGER NOT NULL,from_key INTEGER NOT NULL,to_key INTEGER NOT NULL,length_m REAL NOT NULL) STRICT;
      CREATE INDEX work_edges_from ON work_edges(from_key,edge_key);
      CREATE INDEX work_edges_to ON work_edges(to_key,edge_key);
      CREATE TEMP TABLE work_physical(physical_edge_key INTEGER PRIMARY KEY,from_key INTEGER NOT NULL,to_key INTEGER NOT NULL) STRICT;`);
    const accessClause = profile === "known" ? "e.access_state='public'" : "e.access_state IN ('public','unknown')";
    db.exec(`INSERT INTO work_edges SELECT e.edge_key,e.physical_edge_key,n1.node_key,n2.node_key,e.length_m FROM edges e JOIN nodes n1 ON n1.id=e.from_node JOIN nodes n2 ON n2.id=e.to_node WHERE e.edge_class='trail' AND ${accessClause};
      INSERT INTO work_physical SELECT p.physical_edge_key,p.from_node_key,p.to_node_key FROM physical_edges p WHERE p.physical_edge_key IN (SELECT physical_edge_key FROM work_edges);`);
    await scc(db,checkpoint);
    db.exec("CREATE INDEX work_nodes_scc ON work_nodes(scc,k);");
    const physical = number(one(db, "SELECT count(*) AS n FROM work_physical"), "n");
    db.exec(`DELETE FROM work_physical WHERE (SELECT scc FROM work_nodes WHERE k=from_key)<>(SELECT scc FROM work_nodes WHERE k=to_key);`);
    await seedCycles(db,checkpoint);
    await distances(db,checkpoint);
    if (compact) {
      let feasible=0;
      for(const access of rows(db, "SELECT a.id,w.dist FROM access_points a JOIN nodes n ON n.id=a.node_id JOIN work_nodes w ON w.k=n.node_key ORDER BY a.id")) {
        if(++work%1000===0) await checkpoint();
        if(access.dist!==null) feasible++;
        run(db, `UPDATE access_points SET ${profile}_minimum_stem_m=? WHERE id=?`, access.dist, String(access.id));
      }
      summaries.push({profile,hash:"",feasible,physical});
      db.exec("DROP TABLE seeds; DROP TABLE bridges; DROP TABLE work_physical; DROP TABLE work_edges; DROP TABLE work_nodes;");
      continue;
    }
    // The schema-6 fallback stores only access feasibility; all primitive topology tables remain empty.
    run(db, "INSERT INTO topology_profiles VALUES (?,?,?,?,?,?,?,?)", profile, CLOSED_ROUTE_TOPOLOGY_FORMAT_VERSION, 0, physical, 0, 0, manifest.builtAt, "pending");
    const hash = createHash("sha256");
    hash.update('{"accessTopology":[');
    let count = 0, feasible = 0;
    for (const access of rows(db, `SELECT a.id AS id,n.node_key AS k,w.scc,w.dist,w.portal FROM access_points a JOIN nodes n ON n.id=a.node_id JOIN work_nodes w ON w.k=n.node_key ORDER BY a.id`)) {
      if (++work % 1000 === 0) await checkpoint();
      const key = Number(access.k), canReachCycle = access.dist !== null;
      const network = canReachCycle ? number(one(db, "SELECT min(k) AS k FROM work_nodes WHERE scc=?", Number(access.scc)), "k") : null;
      const portal = canReachCycle ? Number(access.portal) : null;
      const record = {
        accessPointId: String(access.id), attachmentDecisionNodeId: key, cycleNetworkId: network,
        connectorKey: canReachCycle ? await connectorHash(db, key, portal!, checkpoint) : null,
        connectorDecisionEdgeIds: [], portalDecisionNodeId: portal,
        minimumStemDistanceM: canReachCycle ? Number(access.dist) : null, canReachCycle,
      };
      if (count++) hash.update(",");
      if (canReachCycle) feasible++;
      hash.update(canonicalTopologyJson(record));
      run(db, "INSERT INTO access_topology VALUES (?,?,?,?,?,?,?,?,?)", profile, record.accessPointId, key, network, record.connectorKey, "[]", portal, record.minimumStemDistanceM, Number(canReachCycle));
    }
    hash.update(`],"blockLinks":[],"blocks":[],"decisionEdgeCount":0,"decisionEdges":[],"decisionNodeCount":0,"formatVersion":${CLOSED_ROUTE_TOPOLOGY_FORMAT_VERSION},"networks":[],"nodeCount":0,"nodes":[],"physicalEdgeCount":${physical},"profile":${JSON.stringify(profile)}}`);
    const contentHash = `sha256:${hash.digest("hex")}`;
    run(db, "UPDATE topology_profiles SET content_hash=? WHERE profile=?", contentHash, profile);
    summaries.push({ profile, hash: contentHash, feasible, physical });
    db.exec("DROP TABLE seeds; DROP TABLE bridges; DROP TABLE work_physical; DROP TABLE work_edges; DROP TABLE work_nodes;");
  }
  if(compact) {await checkpoint(); return {hash:"",profiles:summaries};}
  const combined = topologySha256({ runtimeMode: "reachable-graph-fallback", algorithmVersion: manifest.closedRouteTopology.algorithmVersion, policyVersion: manifest.closedRouteTopology.policyVersion, profiles: summaries.map(({ profile, hash }) => ({ profile, contentHash: hash })) });
  await checkpoint();
  return { hash: combined, profiles: summaries };
}
