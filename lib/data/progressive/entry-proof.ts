import { DatabaseSync, type StatementSync } from "node:sqlite";
import { prepareAreaGeometry } from "@/lib/graph/geometry";
import type { EntryWitness } from "@/lib/contracts/access-policy";
import type { AccessState } from "@/lib/graph/types";
import type { AreaGeometry } from "../area-geometry";
import { footSegmentAccessState, footWayDirectionAccessState } from "../compiled-edges";
import type { CompiledEdge, NormalizedNode, NormalizedPortalEvidence, NormalizedWay } from "../types";

type Row = Record<string, string | number | null>;
type Role = "road" | "track" | "hike" | "walk" | "none";
type LinkSource = Pick<NormalizedWay, "flags" | "edgeClass" | "accessState" | "sourceRefs"> & {name?: string | null};
const usable = (state: string) => state === "public" || state === "unknown";
const restricted = (state: string | null) => state !== null && !usable(state);
const flag = (flags: readonly string[], prefix: string) => flags.find(value => value.startsWith(prefix))?.slice(prefix.length) ?? null;
const references = (...sets: string[][]) => [...new Set(sets.flat())].sort();

/** Physical function is independent of whether an adapter makes a road routable on foot. */
function role(source: LinkSource): Role {
  const highway = flag(source.flags, "osm-highway:");
  if (source.flags.includes("area:yes")) return "none";
  if (highway === "track") return "track";
  if (["path", "footway", "pedestrian", "steps", "bridleway"].includes(highway ?? ""))
    return source.edgeClass === "sidewalk" ? "walk" : "hike";
  if (source.edgeClass === "street" || source.edgeClass === "service-road" || ["residential", "unclassified", "service", "living_street"].includes(highway ?? "")) return "road";
  if (highway) return "none";
  // Non-OSM adapters and committed abstract graph fixtures use their typed role.
  if (source.edgeClass === "sidewalk") return "walk";
  return source.edgeClass === "trail" || source.edgeClass === undefined ? "hike" : "none";
}

export type PreparedEntry = EntryWitness & { roadClass: "street" | "service-road"; sourceRefs: string[]; name?: string; approachKnown: boolean; requiresRoleChange: boolean };

/** One finite-context proof. Scratch topology, frontier and queues remain SQLite-backed.
 * Known and inclusive passes each visit a node once; no per-place graph walks occur.
 */
export class ConnectedEntryProof {
  private readonly statements = new Map<string, StatementSync>();
  private work = 0;
  constructor(private readonly db: DatabaseSync, private readonly checkpoint: () => Promise<void>) {}
  private get(sql: string, ...args: Array<string | number>) { return this.sql(sql).get(...args) as Row | undefined; }
  private sql(sql: string) { let value = this.statements.get(sql); if (!value) { value = this.db.prepare(sql); this.statements.set(sql, value); } return value; }
  private run(sql: string, ...args: Array<string | number | null>) { return this.sql(sql).run(...args); }
  private rows(sql: string, ...args: Array<string | number>) { return this.db.prepare(sql).iterate(...args) as Iterable<Row>; }
  private async step() { if (++this.work % 1000 === 0) await this.checkpoint(); }

  private passage(wayState: AccessState, from: string, to: string) {
    const nodes=[from,to].map(node=>this.get("SELECT foot,source_refs FROM entry_nodes WHERE id=?",node));
    const flags=nodes.map(node=>node?.foot ? [`foot-access:${node.foot}`] : []);
    return {access:footSegmentAccessState(wayState,flags),sourceRefs:references(...nodes.map(node=>node ? JSON.parse(String(node.source_refs)) as string[] : []))};
  }

  private addLink(id: string, from: string, to: string, source: LinkSource, direction?: "forward" | "backward") {
    const kind = role(source);
    if (!["track", "hike", "walk"].includes(kind) || source.flags.includes("foot-direction:none")) return;
    const wayAccess=direction ? footWayDirectionAccessState(source.accessState,source.flags,direction) : source.accessState;
    const {access,sourceRefs}=this.passage(wayAccess,from,to);
    if (!usable(access)) return;
    this.run("INSERT OR IGNORE INTO entry_links VALUES (?,?,?,?,?,?)", id, from, to, Number(access === "public"), kind, JSON.stringify({ name: source.name ?? flag(source.flags, "trail-name:") ?? undefined, sourceRefs: references(source.sourceRefs,sourceRefs) }));
  }

  async prepare(stage: "sparse" | "measured"): Promise<void> {
    await this.checkpoint();
    this.db.exec(`CREATE TEMP TABLE entry_nodes(id TEXT PRIMARY KEY,foot TEXT,motor TEXT,barrier TEXT,source_refs TEXT NOT NULL) STRICT;
      CREATE TEMP TABLE entry_arrivals(node_id TEXT NOT NULL,role TEXT NOT NULL,road_class TEXT NOT NULL,source_refs TEXT NOT NULL,PRIMARY KEY(node_id,role,road_class)) WITHOUT ROWID;
      CREATE TEMP TABLE entry_links(physical_id TEXT NOT NULL,from_node TEXT NOT NULL,to_node TEXT NOT NULL,known INTEGER NOT NULL,role TEXT NOT NULL,record TEXT NOT NULL,PRIMARY KEY(physical_id,from_node,to_node)) WITHOUT ROWID;
      CREATE TEMP TABLE portal_candidates(node_id TEXT PRIMARY KEY,road_class TEXT NOT NULL,witness TEXT NOT NULL) STRICT;
      CREATE TEMP TABLE portal_evidence(node_id TEXT NOT NULL,evidence_id TEXT NOT NULL,PRIMARY KEY(node_id,evidence_id)) WITHOUT ROWID;`);
    for (const row of this.rows("SELECT record FROM nodes ORDER BY id")) {
      await this.step();
      const node = JSON.parse(String(row.record)) as NormalizedNode;
      this.run("INSERT INTO entry_nodes VALUES (?,?,?,?,?)", node.id, flag(node.flags, "foot-access:") ? footSegmentAccessState("public",[node.flags]) : null, flag(node.flags, "motor-access:"), flag(node.flags, "barrier:"),JSON.stringify(node.sourceRefs));
    }
    for (const row of this.rows("SELECT record FROM ways ORDER BY id")) {
      await this.step();
      const way = JSON.parse(String(row.record)) as NormalizedWay, kind = role(way);
      if ((kind === "road" || kind === "track") && (usable(way.accessState) || flag(way.flags, "motor-access:") === "public")) {
        const roadClass = way.edgeClass === "street" || (kind === "road" && flag(way.flags, "osm-highway:") !== "service" && way.edgeClass !== "service-road") ? "street" : "service-road";
        for (const node of new Set(way.nodeIds)) {
          await this.step();
          const prior = this.get("SELECT source_refs FROM entry_arrivals WHERE node_id=? AND role=? AND road_class=?", node, kind, roadClass);
          const refs = references(way.sourceRefs, prior ? JSON.parse(String(prior.source_refs)) : []);
          this.run("INSERT OR REPLACE INTO entry_arrivals VALUES (?,?,?,?)", node, kind, roadClass, JSON.stringify(refs));
        }
      }
      // Mapped pedestrian approach context is not a hiking departure or invented connector.
      if (kind === "walk") for (let index = 0; index < way.nodeIds.length - 1; index++) {
        await this.step();
        this.addLink(`${way.id}:${index}`, way.nodeIds[index]!, way.nodeIds[index + 1]!, way,"forward");
        if (way.bidirectional) this.addLink(`${way.id}:${index}`, way.nodeIds[index + 1]!, way.nodeIds[index]!, way,"backward");
      }
    }
    if (stage === "sparse") {
      let previous = "", way: NormalizedWay | undefined;
      for (const row of this.rows("SELECT id,from_node,to_node FROM eligible_segments ORDER BY id")) {
        await this.step();
        const id = String(row.id), wayId = id.slice(0, id.lastIndexOf(":"));
        if (wayId !== previous) {
          const source = this.get("SELECT record FROM ways WHERE id=?", wayId);
          if (!source) throw new Error(`Unknown source way for candidate segment: ${id}`);
          way = JSON.parse(String(source.record)) as NormalizedWay; previous = wayId;
        }
        this.addLink(id, String(row.from_node), String(row.to_node), way!,"forward");
        if (way!.bidirectional) this.addLink(id, String(row.to_node), String(row.from_node), way!,"backward");
      }
    } else for (const row of this.rows("SELECT e.record FROM edges e JOIN selected_edges s ON s.id=e.id ORDER BY e.id")) {
      await this.step();
      const edge = JSON.parse(String(row.record)) as CompiledEdge;
      this.addLink(edge.stablePhysicalId, edge.fromNode, edge.toNode, edge);
    }
    this.db.exec("CREATE INDEX entry_links_from ON entry_links(from_node,known,role); CREATE INDEX entry_arrivals_node ON entry_arrivals(node_id);");
    await this.reach("entry_approach", true);
    await this.reach("entry_reach", false);
    await this.checkpoint();
  }

  private async reach(table: "entry_approach" | "entry_reach", approachOnly: boolean) {
    this.db.exec(`CREATE TEMP TABLE ${table}(node_id TEXT NOT NULL,profile INTEGER NOT NULL,root_node TEXT NOT NULL,root_role TEXT NOT NULL,road_class TEXT NOT NULL,source_refs TEXT NOT NULL,PRIMARY KEY(node_id,profile)) WITHOUT ROWID;
      CREATE TEMP TABLE entry_queue(seq INTEGER PRIMARY KEY,node_id TEXT NOT NULL,root_node TEXT NOT NULL,root_role TEXT NOT NULL,road_class TEXT NOT NULL,source_refs TEXT NOT NULL) STRICT;`);
    for (const profile of [1, 0]) {
      this.db.exec("DELETE FROM entry_queue");
      for (const root of this.rows("SELECT * FROM entry_arrivals ORDER BY node_id,road_class DESC,role")) {
        await this.step();
        if (restricted(this.get("SELECT foot FROM entry_nodes WHERE id=?", String(root.node_id))?.foot as string | null)) continue;
        const values = [String(root.node_id), String(root.node_id), String(root.role), String(root.road_class), String(root.source_refs)] as const;
        if (this.run(`INSERT OR IGNORE INTO ${table} VALUES (?,?,?,?,?,?)`, values[0], profile, ...values.slice(1)).changes)
          this.run("INSERT INTO entry_queue(node_id,root_node,root_role,road_class,source_refs) VALUES (?,?,?,?,?)", ...values);
      }
      for (;;) {
        const current = this.get("SELECT * FROM entry_queue ORDER BY seq LIMIT 1");
        if (!current) break;
        this.run("DELETE FROM entry_queue WHERE seq=?", Number(current.seq));
        await this.step();
        for (const link of this.rows(`SELECT * FROM entry_links WHERE from_node=? ${profile ? "AND known=1" : ""} ${approachOnly ? "AND role='walk'" : ""} ORDER BY physical_id,to_node`, String(current.node_id))) {
          await this.step();
          const source = JSON.parse(String(link.record)) as { sourceRefs: string[] };
          const refs = JSON.stringify(references(JSON.parse(String(current.source_refs)), source.sourceRefs));
          const values = [String(link.to_node), String(current.root_node), String(current.root_role), String(current.road_class), refs] as const;
          if (this.run(`INSERT OR IGNORE INTO ${table} VALUES (?,?,?,?,?,?)`, values[0], profile, ...values.slice(1)).changes)
            this.run("INSERT INTO entry_queue(node_id,root_node,root_role,road_class,source_refs) VALUES (?,?,?,?,?)", ...values);
        }
      }
    }
    this.db.exec("DROP TABLE entry_queue");
  }

  /** Choose a directed first segment. An unused arrival road is not walked and cannot taint its foot certainty. */
  private departure(node: string, arrival: Row, kind: EntryWitness["kind"], knownApproach: boolean, interfaceOnly: boolean, requiredDepartureKnown?: boolean): PreparedEntry | undefined {
    for (const link of this.rows("SELECT * FROM entry_links WHERE from_node=? AND role!='walk' ORDER BY known DESC,physical_id,to_node", node)) {
      if (requiredDepartureKnown !== undefined && Boolean(link.known) !== requiredDepartureKnown) continue;
      if (interfaceOnly && arrival.root_role === "track" && link.role === "track") continue;
      const source = JSON.parse(String(link.record)) as { name?: string; sourceRefs: string[] };
      return { kind, rootNodeId: String(arrival.root_node), departurePhysicalId: String(link.physical_id), known: knownApproach && Boolean(link.known), approachKnown: knownApproach, requiresRoleChange: interfaceOnly, roadClass: String(arrival.road_class) as PreparedEntry["roadClass"], sourceRefs: references(JSON.parse(String(arrival.source_refs)), source.sourceRefs), name: source.name };
    }
  }
  private offer(node: string, witness: PreparedEntry, boundary: ReturnType<typeof prepareAreaGeometry>) {
    const location = this.get("SELECT lon,lat FROM nodes WHERE id=?", node);
    if (!location || !boundary.containsPoint([Number(location.lon), Number(location.lat)])) return;
    const prior = this.get("SELECT witness FROM portal_candidates WHERE node_id=?", node);
    if (prior) {
      const value = JSON.parse(String(prior.witness)) as PreparedEntry;
      const rank = (item: PreparedEntry) => `${Number(!item.known)}:${{ trailhead: 0, parking: 1, interface: 2 }[item.kind]}:${item.rootNodeId}:${item.departurePhysicalId}`;
      if (rank(value) <= rank(witness)) return;
    }
    this.run("INSERT OR REPLACE INTO portal_candidates VALUES (?,?,?)", node, witness.roadClass, JSON.stringify(witness));
  }
  private best(node: string, table: "entry_reach" | "entry_approach", kind: EntryWitness["kind"], boundary: ReturnType<typeof prepareAreaGeometry>, interfaceOnly = false) {
    for (const arrival of this.rows(`SELECT *,profile AS known FROM ${table} WHERE node_id=? ORDER BY profile DESC`, node)) {
      const witness = this.departure(node, arrival, kind, Boolean(arrival.known), interfaceOnly);
      if (witness) this.offer(node, witness, boundary);
    }
  }

  async discover(coverage: AreaGeometry): Promise<void> {
    const boundary = prepareAreaGeometry(coverage);
    for (const row of this.rows("SELECT DISTINCT node_id FROM entry_approach ORDER BY node_id")) { await this.step(); this.best(String(row.node_id), "entry_approach", "interface", boundary, true); }
    for (const row of this.rows("SELECT id,record FROM evidence ORDER BY id")) {
      await this.step();
      const item = JSON.parse(String(row.record)) as NormalizedPortalEvidence;
      if (!usable(item.accessState)) continue;
      if (item.kind !== "parking") {
        if (item.nodeIds.length !== 1 || !item.externalId.startsWith("node/")) continue;
        const node = item.nodeIds[0]!, actual = this.get("SELECT record FROM nodes WHERE id=?", node);
        if (!actual || (JSON.parse(String(actual.record)) as NormalizedNode).externalId !== item.externalId) continue;
        this.run("INSERT OR IGNORE INTO portal_evidence VALUES (?,?)", node, String(row.id));
        if (item.kind === "trailhead") this.best(node, "entry_reach", "trailhead", boundary);
        // A generic gate only constrains crossing. A source motor frontier must have an actual physical approach.
        const passage = this.get("SELECT * FROM entry_nodes WHERE id=?", node);
        if (item.kind === "gate" && passage?.barrier && restricted(passage.motor as string | null) && this.get("SELECT 1 FROM entry_arrivals WHERE node_id=? LIMIT 1",node)) this.best(node, "entry_approach", "interface", boundary);
        continue;
      }
      let arrival: Row | undefined;
      for (const node of new Set(item.nodeIds)) {
        await this.step();
        const root = this.get("SELECT *,node_id AS root_node,role AS root_role FROM entry_arrivals WHERE node_id=? ORDER BY road_class DESC,role LIMIT 1", node);
        if (root && !restricted(this.get("SELECT foot FROM entry_nodes WHERE id=?", node)?.foot as string | null) && (!arrival || String(root.root_node) < String(arrival.root_node))) arrival = root;
      }
      if (!arrival) continue;
      for (const node of new Set(item.nodeIds)) {
        await this.step();
        const witness = this.departure(node, arrival, "parking", true, true);
        if (!witness) continue;
        witness.sourceRefs = references(witness.sourceRefs, item.sourceRefs);
        this.offer(node, witness, boundary);
        this.run("INSERT OR IGNORE INTO portal_evidence VALUES (?,?)", node, String(row.id));
      }
    }
    await this.checkpoint();
  }

  /** Revalidate frozen locations only; final support cannot nominate another place. */
  refresh(node: string, prior: PreparedEntry): PreparedEntry | undefined {
    const root = this.get("SELECT *,node_id AS root_node,role AS root_role FROM entry_arrivals WHERE node_id=? ORDER BY road_class DESC,role LIMIT 1", prior.rootNodeId);
    if (!root) return undefined;
    const witness=this.departure(node, root, prior.kind, prior.approachKnown, prior.requiresRoleChange, prior.approachKnown ? prior.known : undefined);
    if (!witness || (prior.known && !witness.known)) return undefined;
    // Admission context, original arrival assertion and access profile are frozen.
    return {...witness,rootNodeId:prior.rootNodeId,known:prior.known};
  }

  clear(): void {
    this.statements.clear();
    for (const table of ["entry_queue", "entry_reach", "entry_approach", "entry_links", "entry_arrivals", "entry_nodes", "portal_evidence", "portal_candidates"]) this.db.exec(`DROP TABLE IF EXISTS temp.${table}`);
  }
}
