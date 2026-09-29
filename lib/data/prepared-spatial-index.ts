import { DatabaseSync } from "node:sqlite";

export function preparedEdgeBounds(geometry: ReadonlyArray<readonly [number,number]>): [number,number,number,number] {
  let minLon=Infinity,maxLon=-Infinity,minLat=Infinity,maxLat=-Infinity;
  for (const [lon,lat] of geometry) {
    minLon=Math.min(minLon,lon);maxLon=Math.max(maxLon,lon);
    minLat=Math.min(minLat,lat);maxLat=Math.max(maxLat,lat);
  }
  return [minLon,maxLon,minLat,maxLat];
}

/** Populate only the finished graph. Normal rtree inserts retain SQLite's outward
 * float32 bounds rounding: https://www.sqlite.org/rtree.html#roundoff_error
 * Neither source rows nor an rtree scan is retained while its index is written. */
export async function rebuildPreparedSpatialIndexes(db:DatabaseSync, checkpoint:()=>Promise<void>):Promise<void> {
  if (db.isTransaction) throw new Error("Spatial index rebuilding requires no active transaction");
  await checkpoint();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec("DELETE FROM node_spatial; DELETE FROM edge_spatial;");
    const insertNode=db.prepare("INSERT INTO node_spatial VALUES(?,?,?,?,?)");
    const insertEdge=db.prepare("INSERT INTO edge_spatial VALUES(?,?,?,?,?)");
    let work=0;
    for (const row of db.prepare("SELECT node_key,lon,lat FROM nodes ORDER BY id").iterate()) {
      if (++work%1000===0) await checkpoint();
      const lon=Number(row.lon),lat=Number(row.lat);
      insertNode.run(Number(row.node_key),lon,lon,lat,lat);
    }
    for (const row of db.prepare("SELECT edge_key,geometry FROM edges ORDER BY id").iterate()) {
      if (++work%1000===0) await checkpoint();
      const geometry=JSON.parse(String(row.geometry)) as Array<[number,number]>;
      insertEdge.run(Number(row.edge_key),...preparedEdgeBounds(geometry));
    }
    await checkpoint();
    db.exec("COMMIT");
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}
