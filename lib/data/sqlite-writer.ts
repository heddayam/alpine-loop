import { DatabaseSync } from "node:sqlite";
import type { SourceSnapshot } from "./adapters";
import type { CompiledEdge, NormalizedAccessPoint, NormalizedNode } from "./types";

export type DatabaseContents = {
  nodes: NormalizedNode[];
  edges: CompiledEdge[];
  accessPoints: NormalizedAccessPoint[];
  sources: SourceSnapshot[];
  metadata: Record<string, string>;
};

function geometryBounds(geometry: CompiledEdge["geometry"]): [number, number, number, number] {
  const lons = geometry.map(([lon]) => lon);
  const lats = geometry.map(([, lat]) => lat);
  return [Math.min(...lons), Math.max(...lons), Math.min(...lats), Math.max(...lats)];
}

export function writePackDatabase(path: string, contents: DatabaseContents): void {
  const database = new DatabaseSync(path);
  try {
    database.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = DELETE;");
    database.exec(`
      CREATE TABLE nodes (
        id TEXT PRIMARY KEY, lon REAL NOT NULL, lat REAL NOT NULL,
        elevation_m REAL, flags TEXT NOT NULL
      ) STRICT;
      CREATE VIRTUAL TABLE node_spatial USING rtree(
        row_id, min_lon, max_lon, min_lat, max_lat
      );
      CREATE TABLE edges (
        id TEXT PRIMARY KEY, from_node TEXT NOT NULL REFERENCES nodes(id),
        to_node TEXT NOT NULL REFERENCES nodes(id), geometry TEXT NOT NULL,
        length_m REAL NOT NULL, gain_m REAL, loss_m REAL,
        max_elevation_m REAL, max_sustained_grade_pct REAL,
        access_state TEXT NOT NULL, source_refs TEXT NOT NULL, flags TEXT NOT NULL
      ) STRICT;
      CREATE INDEX edges_from_node ON edges(from_node);
      CREATE INDEX edges_to_node ON edges(to_node);
      CREATE VIRTUAL TABLE edge_spatial USING rtree(
        row_id, min_lon, max_lon, min_lat, max_lat
      );
      CREATE TABLE access_points (
        id TEXT PRIMARY KEY, node_id TEXT NOT NULL REFERENCES nodes(id),
        name TEXT NOT NULL, kind TEXT NOT NULL, access_state TEXT NOT NULL,
        confidence TEXT NOT NULL, parking_evidence TEXT, source_refs TEXT NOT NULL
      ) STRICT;
      CREATE TABLE sources (
        id TEXT PRIMARY KEY, authority TEXT NOT NULL, dataset TEXT NOT NULL,
        version TEXT NOT NULL, retrieved_at TEXT NOT NULL, url TEXT NOT NULL,
        license TEXT NOT NULL, content_hash TEXT NOT NULL
      ) STRICT;
      CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL
      ) STRICT;
    `);

    const insertNode = database.prepare(
      "INSERT INTO nodes(id, lon, lat, elevation_m, flags) VALUES (?, ?, ?, ?, ?)",
    );
    const insertNodeSpatial = database.prepare(
      "INSERT INTO node_spatial(row_id, min_lon, max_lon, min_lat, max_lat) VALUES (?, ?, ?, ?, ?)",
    );
    const insertEdge = database.prepare(`
      INSERT INTO edges(
        id, from_node, to_node, geometry, length_m, gain_m, loss_m,
        max_elevation_m, max_sustained_grade_pct, access_state, source_refs, flags
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertEdgeSpatial = database.prepare(
      "INSERT INTO edge_spatial(row_id, min_lon, max_lon, min_lat, max_lat) VALUES (?, ?, ?, ?, ?)",
    );
    const insertAccess = database.prepare(`
      INSERT INTO access_points(
        id, node_id, name, kind, access_state, confidence, parking_evidence, source_refs
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertSource = database.prepare(`
      INSERT INTO sources(
        id, authority, dataset, version, retrieved_at, url, license, content_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertMetadata = database.prepare("INSERT INTO metadata(key, value) VALUES (?, ?)");

    database.exec("BEGIN IMMEDIATE");
    try {
      contents.nodes.forEach((node, index) => {
        insertNode.run(node.id, node.lon, node.lat, node.elevationM, JSON.stringify(node.flags));
        insertNodeSpatial.run(index + 1, node.lon, node.lon, node.lat, node.lat);
      });
      contents.edges.forEach((edge, index) => {
        insertEdge.run(
          edge.id, edge.fromNode, edge.toNode, JSON.stringify(edge.geometry), edge.lengthM,
          edge.gainM, edge.lossM, edge.maxElevationM, edge.maxSustainedGradePct,
          edge.accessState, JSON.stringify(edge.sourceRefs), JSON.stringify(edge.flags),
        );
        insertEdgeSpatial.run(index + 1, ...geometryBounds(edge.geometry));
      });
      for (const point of contents.accessPoints) {
        insertAccess.run(
          point.id, point.nodeId, point.name, point.kind, point.accessState,
          point.confidence, point.parkingEvidence, JSON.stringify(point.sourceRefs),
        );
      }
      for (const source of contents.sources) {
        insertSource.run(
          source.id, source.authority, source.dataset, source.version, source.retrievedAt,
          source.url, source.license, source.contentHash,
        );
      }
      for (const [key, value] of Object.entries(contents.metadata)) insertMetadata.run(key, value);
      database.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (1, ?)")
        .run(contents.metadata.builtAt);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    const integrity = database.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
    if (integrity.integrity_check !== "ok") throw new Error(`SQLite integrity check failed: ${integrity.integrity_check}`);
  } finally {
    database.close();
  }
}
