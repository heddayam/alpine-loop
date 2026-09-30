import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { distanceMetersBetween } from "@/lib/graph/geometry";

export const ENTRANCE_FAMILY_ALGORITHM_VERSION = "entrance-family-bridge-arms-v1";
const MAX_APPROACH_METERS = 250;
const MAX_ENTRANCE_SEPARATION_METERS = 100;
const MAX_APPROACH_HOPS = 4096;
type Profile = "known" | "inclusive";

/** Optional schema-7 metadata: the graph and every original start remain intact. */
export function createEntranceFamilySchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS access_entrance_families(
    profile TEXT NOT NULL CHECK(profile IN ('known','inclusive')),
    access_point_id TEXT NOT NULL REFERENCES access_points(id),
    family_id TEXT NOT NULL,
    junction_node_id TEXT NOT NULL REFERENCES nodes(id),
    approach_distance_m REAL NOT NULL CHECK(approach_distance_m>=0 AND approach_distance_m<=250),
    PRIMARY KEY(profile,access_point_id)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS access_entrance_family_members ON access_entrance_families(profile,family_id);
  CREATE INDEX IF NOT EXISTS access_entrance_family_access ON access_entrance_families(access_point_id);
  CREATE INDEX IF NOT EXISTS access_entrance_family_junction ON access_entrance_families(junction_node_id);`);
}

/** Reuses seedCycles' bridge proof. Full-profile incidence comes from work_edges,
 * since work_physical has already discarded edges crossing directed SCCs.
 * Removing the accepted leaf arms leaves exactly one onward edge at the common
 * junction, so all simple loops are reached through that same edge. */
export async function writeEntranceFamilies(db: DatabaseSync, profile: Profile, checkpoint: () => Promise<void>): Promise<void> {
  let work = 0;
  await checkpoint();
  createEntranceFamilySchema(db);
  db.prepare("DELETE FROM access_entrance_families WHERE profile=?").run(profile);
  db.exec(`CREATE TEMP TABLE entrance_links(
      physical_edge_key INTEGER PRIMARY KEY,from_key INTEGER NOT NULL,to_key INTEGER NOT NULL,
      length_m REAL NOT NULL,safe INTEGER NOT NULL,access_state TEXT NOT NULL
    ) STRICT;
    INSERT INTO entrance_links
      SELECT p.physical_edge_key,p.from_node_key,p.to_node_key,min(w.length_m),
        p.from_node_key<>p.to_node_key AND count(*)=2
        AND count(DISTINCT w.from_key)=2 AND count(DISTINCT w.to_key)=2
        AND max(w.length_m)-min(w.length_m)<=1e-6
        AND max(EXISTS(SELECT 1 FROM json_each(e.flags) f
          WHERE lower(f.value) IN ('non-pedestrian','pedestrian:no','foot:no','legal:no')))=0,
        CASE WHEN max(e.access_state='unknown') THEN 'unknown' ELSE 'public' END
      FROM physical_edges p JOIN work_edges w ON w.physical_edge_key=p.physical_edge_key
      JOIN edges e ON e.edge_key=w.edge_key GROUP BY p.physical_edge_key;
    CREATE INDEX entrance_links_from ON entrance_links(from_key,physical_edge_key);
    CREATE INDEX entrance_links_to ON entrance_links(to_key,physical_edge_key);
    CREATE TEMP TABLE entrance_degrees(k INTEGER PRIMARY KEY,degree INTEGER NOT NULL) STRICT;
    INSERT INTO entrance_degrees SELECT k,count(*) FROM (
      SELECT from_key AS k FROM entrance_links UNION ALL SELECT to_key AS k FROM entrance_links
    ) GROUP BY k;
    CREATE TEMP TABLE entrance_arms(
      access_point_id TEXT PRIMARY KEY,junction_key INTEGER NOT NULL,terminal_edge INTEGER NOT NULL,
      distance_m REAL NOT NULL,access_state TEXT NOT NULL,approach_access_state TEXT NOT NULL,
      lon REAL NOT NULL,lat REAL NOT NULL
    ) STRICT;
    CREATE INDEX entrance_arms_junction ON entrance_arms(junction_key,access_point_id);`);
  try {
    await checkpoint();
    const next = db.prepare(`SELECT l.*,b.physical_edge_key AS bridge FROM entrance_links l
      LEFT JOIN bridges b ON b.physical_edge_key=l.physical_edge_key
      WHERE (l.from_key=? OR l.to_key=?) AND l.physical_edge_key<>?
      ORDER BY l.physical_edge_key LIMIT 1`);
    const degree = db.prepare("SELECT degree FROM entrance_degrees WHERE k=?");
    const arm = db.prepare("INSERT INTO entrance_arms VALUES (?,?,?,?,?,?,?,?)");
    const candidates = db.prepare(`SELECT a.id,a.access_state,n.node_key,n.lon,n.lat
      FROM access_points a JOIN nodes n ON n.id=a.node_id JOIN entrance_degrees d ON d.k=n.node_key
      WHERE d.degree=1 AND (a.access_state='public' OR (?='inclusive' AND a.access_state='unknown')) ORDER BY a.id`);
    for (const access of candidates.iterate(profile)) {
      if (++work % 1000 === 0) await checkpoint();
      let current = Number(access.node_key), previousEdge = 0, distance = 0, uncertain = false;
      for (let hops = 0; hops < MAX_APPROACH_HOPS; hops++) {
        if (++work % 1000 === 0) await checkpoint();
        const link = next.get(current,current,previousEdge);
        if (!link || !link.safe || link.bridge === null || !Number.isFinite(link.length_m) || Number(link.length_m)<0) break;
        distance += Number(link.length_m);
        if (distance>MAX_APPROACH_METERS) break;
        uncertain ||= link.access_state === "unknown";
        current = Number(link.from_key) === current ? Number(link.to_key) : Number(link.from_key);
        previousEdge = Number(link.physical_edge_key);
        const incidence = Number(degree.get(current)?.degree ?? 0);
        if (incidence>=3) {
          arm.run(String(access.id),current,previousEdge,distance,String(access.access_state),uncertain?"unknown":"public",Number(access.lon),Number(access.lat));
          break;
        }
        if (incidence!==2) break;
      }
    }
    // Prove the entire junction before applying distance bounds. Never salvage a
    // spatial subset: an omitted entrance would become a second onward branch.
    const junctions = db.prepare(`SELECT a.junction_key,n.id FROM entrance_arms a
      JOIN entrance_degrees d ON d.k=a.junction_key JOIN nodes n ON n.node_key=a.junction_key
      GROUP BY a.junction_key HAVING count(DISTINCT a.terminal_edge)>=2
      AND count(DISTINCT a.terminal_edge)=d.degree-1
      AND min(a.access_state)=max(a.access_state)
      AND min(a.approach_access_state)=max(a.approach_access_state) ORDER BY a.junction_key`);
    const members = db.prepare("SELECT * FROM entrance_arms WHERE junction_key=? ORDER BY access_point_id");
    const insert = db.prepare("INSERT INTO access_entrance_families VALUES (?,?,?,?,?)");
    for (const junction of junctions.iterate()) {
      if (++work % 1000 === 0) await checkpoint();
      const representative = members.get(Number(junction.junction_key))!;
      const hash = createHash("sha256").update(JSON.stringify([ENTRANCE_FAMILY_ALGORITHM_VERSION,profile,String(junction.id)]));
      let near = true;
      for (const member of members.iterate(Number(junction.junction_key))) {
        if (++work % 1000 === 0) await checkpoint();
        const separation = distanceMetersBetween([Number(representative.lon),Number(representative.lat)],[Number(member.lon),Number(member.lat)]);
        if (!Number.isFinite(separation) || separation>MAX_ENTRANCE_SEPARATION_METERS) { near=false;break; }
        hash.update(JSON.stringify(String(member.access_point_id)));
      }
      if (!near) continue;
      const family = `entrance-family:${hash.digest("hex")}`;
      for (const member of members.iterate(Number(junction.junction_key))) {
        if (++work % 1000 === 0) await checkpoint();
        insert.run(profile,String(member.access_point_id),family,String(junction.id),Number(member.distance_m));
      }
    }
  } finally {
    db.exec("DROP TABLE IF EXISTS temp.entrance_arms; DROP TABLE IF EXISTS temp.entrance_degrees; DROP TABLE IF EXISTS temp.entrance_links;");
  }
}
