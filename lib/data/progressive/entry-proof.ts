import { DatabaseSync, type StatementSync } from "node:sqlite";
import { prepareAreaGeometry } from "@/lib/graph/geometry";
import type { EntryWitness } from "@/lib/contracts/access-policy";
import type { AccessState } from "@/lib/graph/types";
import type { AreaGeometry } from "../area-geometry";
import { footSegmentAccessState, footWayDirectionAccessState } from "../compiled-edges";
import type { CompiledEdge, NormalizedNode, NormalizedPortalEvidence, NormalizedWay } from "../types";

type Row = Record<string, string | number | null>;
type Role = "road" | "limited-road" | "service" | "track" | "hike" | "walk" | "none";
type LinkSource = Pick<NormalizedWay, "flags" | "edgeClass" | "accessState" | "sourceRefs"> & {name?: string | null};
const usable = (state: string) => state === "public" || state === "unknown";
const restricted = (state: string | null) => state !== null && !usable(state);
const flag = (flags: readonly string[], prefix: string) => flags.find(value => value.startsWith(prefix))?.slice(prefix.length) ?? null;
const references = (...sets: string[][]) => [...new Set(sets.flat())].sort();

/** Physical function is independent of whether an adapter makes a road routable on foot. */
function role(source: LinkSource): Role {
  const highway = flag(source.flags, "osm-highway:");
  if (source.flags.includes("area:yes")) return "none";
  if (["motorway", "motorway_link", "trunk", "trunk_link"].includes(highway ?? "")) return "limited-road";
  if (highway === "track") return "track";
  if (highway === "service" || (!highway && source.edgeClass === "service-road")) return "service";
  if (["path", "footway", "pedestrian", "steps", "bridleway"].includes(highway ?? ""))
    return source.edgeClass === "sidewalk" ? "walk" : "hike";
  if (source.edgeClass === "street" || ["residential", "unclassified", "living_street", "primary", "primary_link", "secondary", "secondary_link", "tertiary", "tertiary_link"].includes(highway ?? "")) return "road";
  if (highway) return "none";
  if (source.edgeClass === "sidewalk") return "walk";
  return source.edgeClass === "trail" || source.edgeClass === undefined ? "hike" : "none";
}

// These facts describe a local physical arrival spine, not a global legal car route.
// Normalization has already oriented direction-specific motor facts to way.nodeIds.
function motorAccess(source: LinkSource, direction: "forward" | "backward"): string {
  return flag(source.flags, `motor-${direction}-access:`) ?? flag(source.flags, "motor-access:") ?? "unknown";
}
const contactUsable = (source: LinkSource) => usable(source.accessState) || usable(motorAccess(source,"forward")) || usable(motorAccess(source,"backward"));
const interfaceSql=(link:string,arrivalRole:string)=>`(${link}.role='hike' OR (${link}.role='track' AND (${arrivalRole}!='track' OR ${link}.frontier=1)) OR (${link}.role='service' AND ${link}.frontier=1))`;
export type PreparedEntry = EntryWitness & { roadClass: "street" | "service-road"; sourceRefs: string[]; name?: string; approachKnown: boolean; requiresRoleChange: boolean; arrivalRole: Role; rootAssertion: string };

/** One finite-context proof. Scratch topology and queues remain SQLite-backed.
 * Each profile visits each physical arrival role once, then each foot node once.
 */
export class ConnectedEntryProof {
  private readonly statements = new Map<string, StatementSync>();
  private work = 0;
  constructor(private readonly db: DatabaseSync, private readonly checkpoint: () => Promise<void>) {}
  private get(sql: string, ...args: Array<string | number>) { return this.sql(sql).get(...args) as Row | undefined; }
  private sql(sql: string) { let value = this.statements.get(sql); if (!value) { value = this.db.prepare(sql); this.statements.set(sql, value); } return value; }
  private run(sql: string, ...args: Array<string | number | null>) { return this.sql(sql).run(...args); }
  private rows(sql: string, ...args: Array<string | number>) { return this.sql(sql).iterate(...args) as Iterable<Row>; }
  private async step() { if (++this.work % 1000 === 0) await this.checkpoint(); }

  private passage(wayState: AccessState, from: string, to: string) {
    const nodes=[from,to].map(node=>this.get("SELECT foot,source_refs FROM entry_nodes WHERE id=?",node));
    const flags=nodes.map(node=>node?.foot ? [`foot-access:${node.foot}`] : []);
    return {access:footSegmentAccessState(wayState,flags),sourceRefs:references(...nodes.map(node=>node ? JSON.parse(String(node.source_refs)) as string[] : []))};
  }
  private addLink(id: string, from: string, to: string, source: LinkSource, direction: "forward" | "backward", measured = false) {
    const kind = role(source);
    if (!["service", "track", "hike", "walk"].includes(kind) || source.flags.includes("foot-direction:none")) return;
    const wayAccess=measured ? source.accessState : footWayDirectionAccessState(source.accessState,source.flags,direction);
    const {access,sourceRefs}=this.passage(wayAccess,from,to);
    if (!usable(access)) return;
    const frontier = (kind === "service" || kind === "track") && ((restricted(motorAccess(source,"forward")) && restricted(motorAccess(source,"backward"))) || restricted(this.get("SELECT motor FROM entry_nodes WHERE id=?",from)?.motor as string | null));
    this.run("INSERT OR IGNORE INTO entry_links VALUES (?,?,?,?,?,?,?)", id, from, to, Number(access === "public"), kind, Number(frontier), JSON.stringify({ name: source.name ?? flag(source.flags, "trail-name:") ?? undefined, sourceRefs: references(source.sourceRefs,sourceRefs) }));
  }
  private addContact(way: NormalizedWay, node: string, kind: Role) {
    const roadClass=kind === "road" || kind === "limited-road" ? "street" : "service-road";
    const prior=this.get("SELECT source_refs FROM entry_contacts WHERE node_id=? AND role=?",node,kind);
    this.run("INSERT OR REPLACE INTO entry_contacts VALUES (?,?,?,?)",node,kind,roadClass,JSON.stringify(references(way.sourceRefs,prior ? JSON.parse(String(prior.source_refs)) : [])));
    if(kind === "road")this.run("INSERT OR IGNORE INTO entry_roots VALUES (?,?,?,?,?,?)",node,kind,roadClass,1,JSON.stringify(way.sourceRefs),`way:${way.id}`);
  }
  private insertNode(node: NormalizedNode) {
    this.run("INSERT INTO entry_nodes VALUES (?,?,?,?,?)", node.id, flag(node.flags, "foot-access:") ? footSegmentAccessState("public",[node.flags]) : null, flag(node.flags, "motor-access:"), flag(node.flags, "arrival-place:"),JSON.stringify(node.sourceRefs));
  }
  private loadNode(id: string) {
    if(this.get("SELECT 1 FROM entry_nodes WHERE id=?",id))return;
    const row=this.get("SELECT record FROM nodes WHERE id=?",id);
    if(row)this.insertNode(JSON.parse(String(row.record)) as NormalizedNode);
  }
  private async placeRoots(nodes: Iterable<string>, known: boolean, sourceRefs: string[], assertion: string) {
    for(const node of new Set(nodes)) {
      await this.step();
      if(restricted(this.get("SELECT foot FROM entry_nodes WHERE id=?",node)?.foot as string|null))continue;
      for(const contact of this.rows("SELECT * FROM entry_contacts WHERE node_id=? ORDER BY road_class DESC,role",node))
        this.run("INSERT OR IGNORE INTO entry_roots VALUES (?,?,?,?,?,?)",node,String(contact.role),String(contact.road_class),Number(known),JSON.stringify(references(JSON.parse(String(contact.source_refs)),sourceRefs)),assertion);
    }
  }
  private async parkingRoots(item: NormalizedPortalEvidence, assertion: string, nodes: Iterable<string> = item.nodeIds) {
    const foot=footSegmentAccessState("public",[item.flags ?? []]);
    if(usable(item.accessState)&&usable(foot))await this.placeRoots(nodes,foot === "public",item.sourceRefs,assertion);
  }
  private async arrivalPlaces() {
    for(const place of this.rows("SELECT * FROM entry_nodes WHERE arrival_place='turning-circle' ORDER BY id")) {
      await this.step();
      if(restricted(place.foot as string|null))continue;
      await this.placeRoots([String(place.id)],place.foot!=="unknown",JSON.parse(String(place.source_refs)),`node:${place.id}:arrival-place:turning-circle`);
    }
    for(const row of this.rows("SELECT id,record FROM evidence WHERE kind='parking' ORDER BY id")) {
      await this.step();
      const item=JSON.parse(String(row.record)) as NormalizedPortalEvidence;
      await this.parkingRoots(item,String(row.id));
    }
  }

  private async contactsAt(node: string) {
    // The node-leading membership index bounds this read by actual local contacts.
    for(const row of this.rows("SELECT DISTINCT w.id,w.record FROM way_nodes n JOIN ways w ON w.id=n.way_id WHERE n.node_id=? ORDER BY w.id",node)) {
      await this.step();
      const way=JSON.parse(String(row.record)) as NormalizedWay,kind=role(way);
      if(["road","limited-road","service","track"].includes(kind)&&contactUsable(way)&&way.nodeIds.includes(node))this.addContact(way,node,kind);
    }
  }
  private async frozenRoot(node: string, assertion: string, way: NormalizedWay | undefined, wayNodes: ReadonlySet<string>, item: NormalizedPortalEvidence | undefined, placeNodes: ReadonlySet<string>) {
    this.loadNode(node);
    if(way&&wayNodes.has(node)&&role(way)==="road"&&contactUsable(way))this.addContact(way,node,"road");
    if(assertion===`node:${node}:arrival-place:turning-circle`) {
      const place=this.get("SELECT * FROM entry_nodes WHERE id=?",node);
      if(place?.arrival_place==="turning-circle"&&!restricted(place.foot as string|null)) {
        await this.contactsAt(node);
        await this.placeRoots([node],place.foot!=="unknown",JSON.parse(String(place.source_refs)),assertion);
      }
    }
    if(item?.kind==="parking"&&placeNodes.has(node)) {
      await this.contactsAt(node);
      await this.parkingRoots(item,assertion,[node]);
    }
  }
  private async prepareFrozen() {
    this.db.exec("CREATE TEMP TABLE entry_refresh_roots(node_id TEXT NOT NULL,assertion TEXT NOT NULL,PRIMARY KEY(node_id,assertion)) WITHOUT ROWID;");
    for(const row of this.rows("SELECT node_id,witness FROM sparse_portal_candidates ORDER BY node_id")) {
      await this.step();
      const prior=JSON.parse(String(row.witness)) as PreparedEntry,node=String(row.node_id);
      this.run("INSERT OR IGNORE INTO entry_refresh_roots VALUES (?,?)",prior.rootNodeId,prior.rootAssertion);
      this.loadNode(node);
      // Final support may change the first measured departure, never the frozen
      // source assertion or approach profile. Read only this actual start's exits.
      for(const edgeRow of this.rows("SELECT e.record FROM edges e WHERE e.from_node=? AND EXISTS (SELECT 1 FROM selected_edges s WHERE s.id=e.id) ORDER BY e.id",node)) {
        await this.step();
        const edge=JSON.parse(String(edgeRow.record)) as CompiledEdge;
        this.loadNode(edge.toNode);
        this.addLink(edge.stablePhysicalId,edge.fromNode,edge.toNode,edge,edge.id.endsWith(":reverse") ? "backward" : "forward",true);
      }
    }
    // Group exact assertions: many frozen starts can share one source way/place.
    // Keep only that one record and its membership sets in memory at a time.
    let previous: string | undefined,way:NormalizedWay|undefined,item:NormalizedPortalEvidence|undefined;
    let wayNodes:ReadonlySet<string>=new Set(),placeNodes:ReadonlySet<string>=new Set();
    for(const row of this.rows("SELECT node_id,assertion FROM entry_refresh_roots ORDER BY assertion,node_id")) {
      await this.step();
      const assertion=String(row.assertion);
      if(assertion!==previous) {
        const source=assertion.startsWith("way:") ? this.get("SELECT record FROM ways WHERE id=?",assertion.slice(4)) : undefined;
        const place=this.get("SELECT record FROM evidence WHERE id=?",assertion);
        way=source ? JSON.parse(String(source.record)) as NormalizedWay : undefined;
        item=place ? JSON.parse(String(place.record)) as NormalizedPortalEvidence : undefined;
        wayNodes=new Set(way?.nodeIds);placeNodes=new Set(item?.nodeIds);previous=assertion;
      }
      await this.frozenRoot(String(row.node_id),assertion,way,wayNodes,item,placeNodes);
    }
  }
  private async prepared() {
    this.db.exec("CREATE INDEX entry_links_from ON entry_links(from_node,known DESC,physical_id,to_node,role); CREATE INDEX entry_roots_assertion ON entry_roots(assertion,node_id,road_class DESC,role);");
    await this.checkpoint();
  }

  async prepare(stage: "sparse" | "measured", discoverRequired=true): Promise<void> {
    await this.checkpoint();
    this.db.exec(`CREATE TEMP TABLE entry_nodes(id TEXT PRIMARY KEY,foot TEXT,motor TEXT,arrival_place TEXT,source_refs TEXT NOT NULL) STRICT;
      CREATE TEMP TABLE entry_contacts(node_id TEXT NOT NULL,role TEXT NOT NULL,road_class TEXT NOT NULL,source_refs TEXT NOT NULL,PRIMARY KEY(node_id,role)) WITHOUT ROWID;
      CREATE TEMP TABLE entry_roots(node_id TEXT NOT NULL,role TEXT NOT NULL,road_class TEXT NOT NULL,known INTEGER NOT NULL,source_refs TEXT NOT NULL,assertion TEXT NOT NULL,PRIMARY KEY(node_id,role,assertion)) WITHOUT ROWID;
      CREATE TEMP TABLE entry_spines(from_node TEXT NOT NULL,to_node TEXT NOT NULL,role TEXT NOT NULL,source_refs TEXT NOT NULL,PRIMARY KEY(from_node,to_node,role)) WITHOUT ROWID;
      CREATE TEMP TABLE entry_links(physical_id TEXT NOT NULL,from_node TEXT NOT NULL,to_node TEXT NOT NULL,known INTEGER NOT NULL,role TEXT NOT NULL,frontier INTEGER NOT NULL,record TEXT NOT NULL,PRIMARY KEY(physical_id,from_node,to_node)) WITHOUT ROWID;
      CREATE TEMP TABLE portal_candidates(node_id TEXT PRIMARY KEY,road_class TEXT NOT NULL,witness TEXT NOT NULL) STRICT;
      CREATE TEMP TABLE portal_evidence(node_id TEXT NOT NULL,evidence_id TEXT NOT NULL,PRIMARY KEY(node_id,evidence_id)) WITHOUT ROWID;`);
    if(stage==="measured"&&!discoverRequired&&this.get("SELECT 1 FROM sqlite_temp_master WHERE name='sparse_portal_candidates' AND type='table'")) {
      try { await this.prepareFrozen(); await this.prepared(); }
      catch(error) { this.clear(); throw error; }
      return;
    }
    for (const row of this.rows("SELECT record FROM nodes ORDER BY id")) {
      await this.step();
      const node = JSON.parse(String(row.record)) as NormalizedNode;
      this.insertNode(node);
    }
    for (const row of this.rows("SELECT record FROM ways ORDER BY id")) {
      await this.step();
      const way = JSON.parse(String(row.record)) as NormalizedWay, kind = role(way);
      if (["road","limited-road","service","track"].includes(kind) && contactUsable(way)) {
        for (const node of new Set(way.nodeIds)) { await this.step(); this.addContact(way,node,kind); }
      }
      if(discoverRequired && (kind === "service" || kind === "track"))for(let index=0;index<way.nodeIds.length-1;index++) {
        await this.step();
        // Motor movement is independent of foot bidirectionality: normalized facts
        // encode motor one-way exceptions in the same oriented source coordinates.
        for(const direction of ["forward","backward"] as const) {
          const from=way.nodeIds[index+(direction === "backward" ? 1 : 0)]!,to=way.nodeIds[index+(direction === "forward" ? 1 : 0)]!;
          const motor=motorAccess(way,direction),nodeMotor=this.get("SELECT motor FROM entry_nodes WHERE id=?",from)?.motor as string|null;
          if(!usable(motor)||(kind === "track" && motor !== "public")||restricted(nodeMotor))continue;
          const foot=this.passage(footWayDirectionAccessState(way.accessState,way.flags,direction),from,to);
          if(!usable(foot.access)&&motor !== "public")continue;
          this.run("INSERT OR IGNORE INTO entry_spines VALUES (?,?,?,?)",from,to,kind,JSON.stringify(references(way.sourceRefs,foot.sourceRefs)));
        }
      }
      // Mapped pedestrian approach context is not a hiking departure or invented connector.
      if (kind === "walk") for (let index = 0; index < way.nodeIds.length - 1; index++) {
        await this.step();
        this.addLink(`${way.id}:${index}`, way.nodeIds[index]!, way.nodeIds[index + 1]!, way,"forward");
        if (way.bidirectional) this.addLink(`${way.id}:${index}`, way.nodeIds[index + 1]!, way.nodeIds[index]!, way,"backward");
      }
    }
    await this.arrivalPlaces();
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
      this.addLink(edge.stablePhysicalId, edge.fromNode, edge.toNode, edge,edge.id.endsWith(":reverse") ? "backward" : "forward",true);
    }
    await this.prepared();
  }

  private async arrivals() {
    this.db.exec(`CREATE TEMP TABLE entry_arrivals(node_id TEXT NOT NULL,profile INTEGER NOT NULL,root_node TEXT NOT NULL,root_role TEXT NOT NULL,road_class TEXT NOT NULL,source_refs TEXT NOT NULL,root_assertion TEXT NOT NULL,PRIMARY KEY(node_id,profile,root_role)) WITHOUT ROWID;
      CREATE TEMP TABLE entry_queue(seq INTEGER PRIMARY KEY,node_id TEXT NOT NULL,root_node TEXT NOT NULL,root_role TEXT NOT NULL,road_class TEXT NOT NULL,source_refs TEXT NOT NULL,root_assertion TEXT NOT NULL) STRICT;`);
    for(const profile of [1,0]) {
      this.db.exec("DELETE FROM entry_queue");
      for(const root of this.rows(`SELECT * FROM entry_roots r WHERE ${profile ? "known=1 AND" : ""}
        (EXISTS (SELECT 1 FROM entry_spines s WHERE s.from_node=r.node_id) OR EXISTS (SELECT 1 FROM entry_links l WHERE l.from_node=r.node_id))
        ORDER BY node_id,road_class DESC,role,assertion`)) {
        await this.step();
        const values=[String(root.node_id),String(root.node_id),String(root.role),String(root.road_class),String(root.source_refs),String(root.assertion)] as const;
        if(this.run("INSERT OR IGNORE INTO entry_arrivals VALUES (?,?,?,?,?,?,?)",values[0],profile,...values.slice(1)).changes)this.run("INSERT INTO entry_queue(node_id,root_node,root_role,road_class,source_refs,root_assertion) VALUES (?,?,?,?,?,?)",...values);
      }
      for(;;) {
        const current=this.get("SELECT * FROM entry_queue ORDER BY seq LIMIT 1");if(!current)break;
        this.run("DELETE FROM entry_queue WHERE seq=?",Number(current.seq));await this.step();
        // Adapters use source snapshot IDs, bounded by regional source count K,
        // rather than per-way IDs. Provenance size does not grow with path length.
        const currentRefs=JSON.parse(String(current.source_refs)) as string[];
        for(const link of this.rows("SELECT * FROM entry_spines WHERE from_node=? ORDER BY to_node,role",String(current.node_id))) {
          await this.step();
          const refs=String(link.source_refs)===String(current.source_refs) ? String(current.source_refs) : JSON.stringify(references(currentRefs,JSON.parse(String(link.source_refs))));
          const values=[String(link.to_node),String(current.root_node),String(link.role),"service-road",refs,String(current.root_assertion)] as const;
          if(this.run("INSERT OR IGNORE INTO entry_arrivals VALUES (?,?,?,?,?,?,?)",values[0],profile,...values.slice(1)).changes)this.run("INSERT INTO entry_queue(node_id,root_node,root_role,road_class,source_refs,root_assertion) VALUES (?,?,?,?,?,?)",...values);
        }
      }
    }
    this.db.exec("DROP TABLE entry_queue");
  }
  private async reach(table: "entry_approach" | "entry_reach", approachOnly: boolean) {
    this.db.exec(`CREATE TEMP TABLE ${table}(node_id TEXT NOT NULL,profile INTEGER NOT NULL,root_node TEXT NOT NULL,root_role TEXT NOT NULL,road_class TEXT NOT NULL,source_refs TEXT NOT NULL,root_assertion TEXT NOT NULL,PRIMARY KEY(node_id,profile${approachOnly ? ",root_role" : ""})) WITHOUT ROWID;
      CREATE TEMP TABLE entry_queue(seq INTEGER PRIMARY KEY,node_id TEXT NOT NULL,root_node TEXT NOT NULL,root_role TEXT NOT NULL,road_class TEXT NOT NULL,source_refs TEXT NOT NULL,root_assertion TEXT NOT NULL) STRICT;`);
    for (const profile of [1, 0]) {
      this.db.exec("DELETE FROM entry_queue");
      for (const root of this.rows(`SELECT a.* FROM entry_arrivals a WHERE a.profile=? AND EXISTS (SELECT 1 FROM entry_links l WHERE l.from_node=a.node_id) ORDER BY a.node_id,a.road_class DESC,a.root_role`,profile)) {
        await this.step();
        if (restricted(this.get("SELECT foot FROM entry_nodes WHERE id=?", String(root.node_id))?.foot as string | null)) continue;
        const values = [String(root.node_id), String(root.root_node), String(root.root_role), String(root.road_class), String(root.source_refs),String(root.root_assertion)] as const;
        if (this.run(`INSERT OR IGNORE INTO ${table} VALUES (?,?,?,?,?,?,?)`, values[0], profile, ...values.slice(1)).changes)
          this.run("INSERT INTO entry_queue(node_id,root_node,root_role,road_class,source_refs,root_assertion) VALUES (?,?,?,?,?,?)", ...values);
      }
      for (;;) {
        const current = this.get("SELECT * FROM entry_queue ORDER BY seq LIMIT 1");
        if (!current) break;
        this.run("DELETE FROM entry_queue WHERE seq=?", Number(current.seq));await this.step();
        const currentRefs=JSON.parse(String(current.source_refs)) as string[];
        for (const link of this.rows(`SELECT * FROM entry_links WHERE from_node=? ${profile ? "AND known=1" : ""} ${approachOnly ? "AND role='walk'" : ""} ORDER BY physical_id,to_node`, String(current.node_id))) {
          await this.step();
          const source = JSON.parse(String(link.record)) as { sourceRefs: string[] };
          const refs=source.sourceRefs.length===currentRefs.length && source.sourceRefs.every((ref,index)=>ref===currentRefs[index]) ? String(current.source_refs) : JSON.stringify(references(currentRefs,source.sourceRefs));
          const values = [String(link.to_node), String(current.root_node), String(current.root_role), String(current.road_class), refs,String(current.root_assertion)] as const;
          if (this.run(`INSERT OR IGNORE INTO ${table} VALUES (?,?,?,?,?,?,?)`, values[0], profile, ...values.slice(1)).changes)
            this.run("INSERT INTO entry_queue(node_id,root_node,root_role,road_class,source_refs,root_assertion) VALUES (?,?,?,?,?,?)", ...values);
        }
      }
    }
    this.db.exec("DROP TABLE entry_queue");
  }

  /** An unused arrival road/spine is not walked and cannot taint foot certainty. */
  private departure(node: string, arrival: Row, kind: EntryWitness["kind"], knownApproach: boolean, interfaceOnly: boolean, requiredDepartureKnown?: boolean): PreparedEntry | undefined {
    for (const link of this.rows(`SELECT l.* FROM entry_links l WHERE l.from_node=? AND l.role!='walk' ${interfaceOnly ? `AND ${interfaceSql("l","?")}` : ""} ORDER BY l.known DESC,l.physical_id,l.to_node`, node,...(interfaceOnly ? [String(arrival.root_role)] : []))) {
      if (requiredDepartureKnown !== undefined && Boolean(link.known) !== requiredDepartureKnown) continue;
      const source = JSON.parse(String(link.record)) as { name?: string; sourceRefs: string[] };
      return { kind, rootNodeId: String(arrival.root_node), departurePhysicalId: String(link.physical_id), known: knownApproach && Boolean(link.known), approachKnown: knownApproach, requiresRoleChange: interfaceOnly, arrivalRole:String(arrival.root_role) as Role, rootAssertion:String(arrival.root_assertion ?? arrival.assertion), roadClass: String(arrival.road_class) as PreparedEntry["roadClass"], sourceRefs: references(JSON.parse(String(arrival.source_refs)), source.sourceRefs), name: source.name };
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
    for (const arrival of this.rows(`SELECT *,profile AS known FROM ${table} WHERE node_id=? ORDER BY profile DESC,road_class DESC,root_role`, node)) {
      const witness = this.departure(node, arrival, kind, Boolean(arrival.known), interfaceOnly);
      if (witness) this.offer(node, witness, boundary);
    }
  }
  private actualEvidenceNode(item:NormalizedPortalEvidence):string|undefined {
    if(item.nodeIds.length!==1 || !item.externalId.startsWith("node/"))return undefined;
    const node=item.nodeIds[0]!,actual=this.get("SELECT record FROM nodes WHERE id=?",node);
    return actual && (JSON.parse(String(actual.record)) as NormalizedNode).externalId===item.externalId ? node : undefined;
  }

  async discover(coverage: AreaGeometry): Promise<void> {
    await this.arrivals();
    await this.reach("entry_approach", true);
    let hasAssertion=false;
    for(const row of this.rows("SELECT record FROM evidence WHERE kind='trailhead' ORDER BY id")) {
      await this.step();
      const item=JSON.parse(String(row.record)) as NormalizedPortalEvidence;
      if(usable(item.accessState)&&this.actualEvidenceNode(item)){hasAssertion=true;break;}
    }
    // Finish schema-changing lazy traversal before opening the evidence cursor.
    if(hasAssertion)await this.reach("entry_reach",false);
    const boundary = prepareAreaGeometry(coverage);
    for (const row of this.rows(`SELECT DISTINCT a.node_id FROM entry_approach a WHERE EXISTS
      (SELECT 1 FROM entry_links l WHERE l.from_node=a.node_id AND ${interfaceSql("l","a.root_role")} ) ORDER BY a.node_id`)) {
      await this.step();this.best(String(row.node_id), "entry_approach", "interface", boundary, true);
    }
    for (const row of this.rows("SELECT id,record FROM evidence ORDER BY id")) {
      await this.step();
      const item = JSON.parse(String(row.record)) as NormalizedPortalEvidence;
      if (!usable(item.accessState)) continue;
      if (item.kind !== "parking") {
        const node=this.actualEvidenceNode(item);if(!node)continue;
        this.run("INSERT OR IGNORE INTO portal_evidence VALUES (?,?)", node, String(row.id));
        if (item.kind === "trailhead") this.best(node, "entry_reach", "trailhead", boundary);
        continue;
      }
      const arrival=this.get("SELECT *,node_id AS root_node,role AS root_role FROM entry_roots WHERE assertion=? ORDER BY node_id,road_class DESC,role LIMIT 1",String(row.id));
      if(!arrival)continue;
      for (const node of new Set(item.nodeIds)) {
        await this.step();
        const witness=this.departure(node,arrival,"parking",Boolean(arrival.known),true);if(!witness)continue;
        this.offer(node,witness,boundary);this.run("INSERT OR IGNORE INTO portal_evidence VALUES (?,?)",node,String(row.id));
      }
    }
    await this.checkpoint();
  }

  /** Revalidate frozen locations only; final support cannot nominate or reroot a place. */
  refresh(node: string, prior: PreparedEntry): PreparedEntry | undefined {
    const root=this.get("SELECT * FROM entry_roots WHERE node_id=? AND assertion=? ORDER BY known DESC,road_class DESC,role LIMIT 1",prior.rootNodeId,prior.rootAssertion);
    if(!root || (prior.approachKnown && !root.known))return undefined;
    const arrival={root_node:prior.rootNodeId,root_role:prior.arrivalRole,road_class:prior.roadClass,source_refs:JSON.stringify(prior.sourceRefs),root_assertion:prior.rootAssertion};
    const witness=this.departure(node,arrival,prior.kind,prior.approachKnown,prior.requiresRoleChange,prior.approachKnown ? prior.known : undefined);
    if(!witness || (prior.known && !witness.known))return undefined;
    return {...witness,rootNodeId:prior.rootNodeId,known:prior.known};
  }

  clear(): void {
    this.statements.clear();
    for (const table of ["entry_refresh_roots", "entry_queue", "entry_reach", "entry_approach", "entry_arrivals", "entry_links", "entry_spines", "entry_roots", "entry_contacts", "entry_nodes", "portal_evidence", "portal_candidates"]) this.db.exec(`DROP TABLE IF EXISTS temp.${table}`);
  }
}
