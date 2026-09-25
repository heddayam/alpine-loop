import { DatabaseSync } from "node:sqlite";

/** Immutable prepared graph section schema. */
export function createPreparedSchema(database:DatabaseSync):void {
  database.exec(`      CREATE TABLE nodes (
        id TEXT PRIMARY KEY, node_key INTEGER NOT NULL UNIQUE, lon REAL NOT NULL, lat REAL NOT NULL,
        elevation_m REAL, flags TEXT NOT NULL
      ) STRICT;
      CREATE VIRTUAL TABLE node_spatial USING rtree(
        row_id, min_lon, max_lon, min_lat, max_lat
      );

      CREATE TABLE physical_edges (
        physical_edge_key INTEGER PRIMARY KEY,
        stable_physical_id TEXT NOT NULL UNIQUE,
        from_node_key INTEGER NOT NULL REFERENCES nodes(node_key),
        to_node_key INTEGER NOT NULL REFERENCES nodes(node_key),
        geometry_hash TEXT NOT NULL
      ) STRICT;
      CREATE INDEX physical_edges_nodes ON physical_edges(from_node_key, to_node_key);
      CREATE TABLE edges (
        id TEXT PRIMARY KEY, edge_key INTEGER NOT NULL UNIQUE, physical_edge_key INTEGER NOT NULL REFERENCES physical_edges(physical_edge_key), from_node TEXT NOT NULL REFERENCES nodes(id),
        to_node TEXT NOT NULL REFERENCES nodes(id), geometry TEXT NOT NULL,
        length_m REAL NOT NULL, gain_m REAL, loss_m REAL,
        max_elevation_m REAL, max_sustained_grade_pct REAL, elevation_profile TEXT,
        access_state TEXT NOT NULL, edge_class TEXT NOT NULL CHECK(edge_class IN ('trail','service-road','street','sidewalk')), source_refs TEXT NOT NULL, flags TEXT NOT NULL
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
        ,
        known_connectivity INTEGER NOT NULL CHECK(known_connectivity >= 0),
        inclusive_connectivity INTEGER NOT NULL CHECK(inclusive_connectivity >= 0),
        known_out_degree INTEGER NOT NULL CHECK(known_out_degree >= 0),
        inclusive_out_degree INTEGER NOT NULL CHECK(inclusive_out_degree >= 0),
        nearby_building_count INTEGER NOT NULL CHECK(nearby_building_count >= 0)
        ,
        reachable_trail_km REAL NOT NULL CHECK(reachable_trail_km >= 0),
        trail_component_id TEXT NOT NULL,
        portal_road_class TEXT NOT NULL CHECK(portal_road_class IN ('street','service-road')),
        parking_distance_m REAL CHECK(parking_distance_m IS NULL OR parking_distance_m >= 0)
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

      CREATE TABLE named_areas (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL,
        context TEXT, min_lon REAL NOT NULL, min_lat REAL NOT NULL,
        max_lon REAL NOT NULL, max_lat REAL NOT NULL,
        geometry TEXT NOT NULL, source_refs TEXT NOT NULL
      ) STRICT;
      CREATE INDEX named_areas_kind_name ON named_areas(kind, name, id);
      CREATE TABLE named_area_aliases (
        area_id TEXT NOT NULL REFERENCES named_areas(id) ON DELETE CASCADE,
        alias TEXT NOT NULL, normalized_alias TEXT NOT NULL,
        PRIMARY KEY(area_id, normalized_alias)
      ) STRICT;
      CREATE INDEX named_area_alias_search ON named_area_aliases(normalized_alias, area_id);
      CREATE VIRTUAL TABLE named_area_spatial USING rtree(
        row_id, min_lon, max_lon, min_lat, max_lat
      );

      CREATE TABLE search_regions (
        named_area_id TEXT PRIMARY KEY REFERENCES named_areas(id),
        display_order INTEGER NOT NULL UNIQUE CHECK(display_order >= 0)
      ) STRICT;

    ALTER TABLE access_points ADD COLUMN known_minimum_stem_m REAL CHECK(known_minimum_stem_m IS NULL OR known_minimum_stem_m>=0);
    ALTER TABLE access_points ADD COLUMN inclusive_minimum_stem_m REAL CHECK(inclusive_minimum_stem_m IS NULL OR inclusive_minimum_stem_m>=0);
  `);
}
