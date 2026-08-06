import { DatabaseSync } from "node:sqlite";
import type { SourceSnapshot } from "./adapters";
import { namedAreaSearchKey } from "./named-areas";
import type { CompiledEdge, NormalizedAccessPoint, NormalizedNamedArea, NormalizedNode, NormalizedSearchRegion, Schema3TopologyBuild } from "./types";

export type DatabaseContents = {
  nodes: NormalizedNode[];
  edges: CompiledEdge[];
  accessPoints: NormalizedAccessPoint[];
  namedAreas?: NormalizedNamedArea[];
  searchRegions?: NormalizedSearchRegion[];
  sources: SourceSnapshot[];
  metadata: Record<string, string>;
  closedRouteTopology?: Schema3TopologyBuild;
};

function geometryBounds(geometry: CompiledEdge["geometry"]): [number, number, number, number] {
  const lons = geometry.map(([lon]) => lon);
  const lats = geometry.map(([, lat]) => lat);
  return [Math.min(...lons), Math.max(...lons), Math.min(...lats), Math.max(...lats)];
}

export function writePackDatabase(path: string, contents: DatabaseContents): void {
  const database = new DatabaseSync(path);
  const schemaVersion = contents.metadata.schemaVersion;
  const hasClosedRouteTopology = schemaVersion === "3" || schemaVersion === "4";
  if (schemaVersion !== "1" && schemaVersion !== "2" && schemaVersion !== "3" && schemaVersion !== "4") throw new Error(`Unsupported database schema version ${schemaVersion}`);
  if (schemaVersion !== "1" && !contents.namedAreas) throw new Error(`Schema ${schemaVersion} database requires named areas`);
  if (hasClosedRouteTopology && !contents.closedRouteTopology) throw new Error(`Schema ${schemaVersion} database requires closed-route topology`);
  if (schemaVersion === "4" && !contents.searchRegions) throw new Error("Schema 4 database requires search regions");
  try {
    database.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = DELETE;");
    database.exec(`
      CREATE TABLE nodes (
        id TEXT PRIMARY KEY${hasClosedRouteTopology ? ", node_key INTEGER NOT NULL UNIQUE" : ""}, lon REAL NOT NULL, lat REAL NOT NULL,
        elevation_m REAL, flags TEXT NOT NULL
      ) STRICT;
      CREATE VIRTUAL TABLE node_spatial USING rtree(
        row_id, min_lon, max_lon, min_lat, max_lat
      );
      ${hasClosedRouteTopology ? `
      CREATE TABLE physical_edges (
        physical_edge_key INTEGER PRIMARY KEY,
        stable_physical_id TEXT NOT NULL UNIQUE,
        from_node_key INTEGER NOT NULL REFERENCES nodes(node_key),
        to_node_key INTEGER NOT NULL REFERENCES nodes(node_key),
        geometry_hash TEXT NOT NULL
      ) STRICT;
      CREATE INDEX physical_edges_nodes ON physical_edges(from_node_key, to_node_key);` : ""}
      CREATE TABLE edges (
        id TEXT PRIMARY KEY${hasClosedRouteTopology ? ", edge_key INTEGER NOT NULL UNIQUE, physical_edge_key INTEGER NOT NULL REFERENCES physical_edges(physical_edge_key)" : ""}, from_node TEXT NOT NULL REFERENCES nodes(id),
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
        ${schemaVersion !== "1" ? `,
        known_connectivity INTEGER NOT NULL CHECK(known_connectivity >= 0),
        inclusive_connectivity INTEGER NOT NULL CHECK(inclusive_connectivity >= 0),
        known_out_degree INTEGER NOT NULL CHECK(known_out_degree >= 0),
        inclusive_out_degree INTEGER NOT NULL CHECK(inclusive_out_degree >= 0),
        population_within_radius REAL CHECK(population_within_radius IS NULL OR population_within_radius >= 0),
        local_relief_m REAL CHECK(local_relief_m IS NULL OR local_relief_m >= 0)` : ""}
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
      ${schemaVersion !== "1" ? `
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
      );` : ""}
      ${schemaVersion === "4" ? `
      CREATE TABLE search_regions (
        named_area_id TEXT PRIMARY KEY REFERENCES named_areas(id),
        display_order INTEGER NOT NULL UNIQUE CHECK(display_order >= 0)
      ) STRICT;` : ""}
      ${hasClosedRouteTopology ? `
      CREATE TABLE topology_profiles (
        profile TEXT PRIMARY KEY CHECK(profile IN ('known','inclusive')),
        format_version INTEGER NOT NULL, node_count INTEGER NOT NULL,
        physical_edge_count INTEGER NOT NULL, decision_node_count INTEGER NOT NULL,
        decision_edge_count INTEGER NOT NULL, built_at TEXT NOT NULL, content_hash TEXT NOT NULL
      ) STRICT;
      CREATE TABLE topology_networks (
        profile TEXT NOT NULL REFERENCES topology_profiles(profile), network_id INTEGER NOT NULL,
        decision_node_count INTEGER NOT NULL, decision_edge_count INTEGER NOT NULL,
        cycle_block_count INTEGER NOT NULL, minimum_cycle_length_m REAL, maximum_cycle_length_m REAL,
        minimum_elevation_m REAL, maximum_elevation_m REAL, content_hash TEXT NOT NULL,
        PRIMARY KEY(profile, network_id)
      ) STRICT;
      CREATE TABLE topology_nodes (
        profile TEXT NOT NULL REFERENCES topology_profiles(profile), dense_id INTEGER NOT NULL,
        source_node_id TEXT NOT NULL REFERENCES nodes(id), decision_node_id INTEGER,
        connected_component_id INTEGER NOT NULL, directed_scc_id INTEGER NOT NULL,
        two_edge_component_id INTEGER NOT NULL, is_articulation INTEGER NOT NULL CHECK(is_articulation IN (0,1)),
        nearest_cycle_network_id INTEGER, cycle_portal_decision_node_id INTEGER, minimum_stem_distance_m REAL,
        PRIMARY KEY(profile, dense_id), UNIQUE(profile, source_node_id)
      ) STRICT;
      CREATE INDEX topology_nodes_network ON topology_nodes(profile, nearest_cycle_network_id);
      CREATE INDEX topology_nodes_decision ON topology_nodes(profile, decision_node_id);
      CREATE TABLE topology_decision_edges (
        profile TEXT NOT NULL REFERENCES topology_profiles(profile), decision_edge_key INTEGER NOT NULL,
        network_id INTEGER NOT NULL, from_decision_node_id INTEGER NOT NULL, to_decision_node_id INTEGER NOT NULL,
        length_m REAL NOT NULL, gain_m REAL NOT NULL, loss_m REAL NOT NULL,
        is_bridge INTEGER NOT NULL CHECK(is_bridge IN (0,1)), two_edge_component_id INTEGER NOT NULL,
        vertex_block_id INTEGER, metrics_and_flags TEXT NOT NULL,
        PRIMARY KEY(profile, decision_edge_key)
      ) STRICT;
      CREATE UNIQUE INDEX topology_decision_edges_global_key ON topology_decision_edges(decision_edge_key);
      CREATE INDEX topology_decision_edges_network ON topology_decision_edges(profile, network_id, from_decision_node_id);
      CREATE TABLE topology_decision_edge_members (
        profile TEXT NOT NULL, decision_edge_key INTEGER NOT NULL, sequence_index INTEGER NOT NULL,
        edge_key INTEGER NOT NULL REFERENCES edges(edge_key), physical_edge_key INTEGER NOT NULL,
        PRIMARY KEY(profile, decision_edge_key, sequence_index),
        FOREIGN KEY(profile, decision_edge_key) REFERENCES topology_decision_edges(profile, decision_edge_key),
        FOREIGN KEY(physical_edge_key) REFERENCES physical_edges(physical_edge_key)
      ) STRICT;
      CREATE UNIQUE INDEX topology_member_edge ON topology_decision_edge_members(profile, edge_key);
      CREATE TABLE topology_blocks (
        profile TEXT NOT NULL REFERENCES topology_profiles(profile), block_id INTEGER NOT NULL, network_id INTEGER NOT NULL,
        block_kind TEXT NOT NULL CHECK(block_kind IN ('vertex-cycle','bridge')), node_count INTEGER NOT NULL,
        edge_count INTEGER NOT NULL, cycle_rank INTEGER NOT NULL, total_physical_length_m REAL NOT NULL,
        minimum_cycle_length_m REAL, elevation_summary TEXT NOT NULL, trail_summary TEXT NOT NULL,
        PRIMARY KEY(profile, block_id)
      ) STRICT;
      CREATE INDEX topology_blocks_network ON topology_blocks(profile, network_id, block_kind);
      CREATE TABLE topology_block_nodes (
        profile TEXT NOT NULL, block_id INTEGER NOT NULL, decision_node_id INTEGER NOT NULL,
        PRIMARY KEY(profile, block_id, decision_node_id),
        FOREIGN KEY(profile, block_id) REFERENCES topology_blocks(profile, block_id)
      ) STRICT;
      CREATE TABLE topology_block_edges (
        profile TEXT NOT NULL, block_id INTEGER NOT NULL, decision_edge_key INTEGER NOT NULL,
        PRIMARY KEY(profile, block_id, decision_edge_key),
        FOREIGN KEY(profile, block_id) REFERENCES topology_blocks(profile, block_id),
        FOREIGN KEY(profile, decision_edge_key) REFERENCES topology_decision_edges(profile, decision_edge_key)
      ) STRICT;
      CREATE TABLE topology_block_links (
        profile TEXT NOT NULL, network_id INTEGER NOT NULL, from_block_id INTEGER NOT NULL,
        to_block_id INTEGER NOT NULL, articulation_decision_node_id INTEGER NOT NULL, connector_distance_m REAL NOT NULL,
        PRIMARY KEY(profile, from_block_id, to_block_id, articulation_decision_node_id)
      ) STRICT;
      CREATE INDEX topology_block_links_network ON topology_block_links(profile, network_id);
      CREATE TABLE access_topology (
        profile TEXT NOT NULL REFERENCES topology_profiles(profile), access_point_id TEXT NOT NULL REFERENCES access_points(id),
        attachment_decision_node_id INTEGER NOT NULL, cycle_network_id INTEGER, connector_key TEXT,
        connector_decision_edge_ids TEXT NOT NULL, portal_decision_node_id INTEGER, minimum_stem_distance_m REAL,
        can_reach_cycle INTEGER NOT NULL CHECK(can_reach_cycle IN (0,1)), PRIMARY KEY(profile, access_point_id)
      ) STRICT;
      CREATE INDEX access_topology_network ON access_topology(profile, cycle_network_id, portal_decision_node_id);` : ""}
    `);

    const insertNode = database.prepare(
      `INSERT INTO nodes(id${hasClosedRouteTopology ? ", node_key" : ""}, lon, lat, elevation_m, flags) VALUES (?${hasClosedRouteTopology ? ", ?" : ""}, ?, ?, ?, ?)`,
    );
    const insertNodeSpatial = database.prepare(
      "INSERT INTO node_spatial(row_id, min_lon, max_lon, min_lat, max_lat) VALUES (?, ?, ?, ?, ?)",
    );
    const insertEdge = database.prepare(`
      INSERT INTO edges(
        id${hasClosedRouteTopology ? ", edge_key, physical_edge_key" : ""}, from_node, to_node, geometry, length_m, gain_m, loss_m,
        max_elevation_m, max_sustained_grade_pct, access_state, source_refs, flags
      ) VALUES (?${hasClosedRouteTopology ? ", ?, ?" : ""}, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertEdgeSpatial = database.prepare(
      "INSERT INTO edge_spatial(row_id, min_lon, max_lon, min_lat, max_lat) VALUES (?, ?, ?, ?, ?)",
    );
    const insertAccess = database.prepare(`
      INSERT INTO access_points(
        id, node_id, name, kind, access_state, confidence, parking_evidence, source_refs
        ${schemaVersion !== "1" ? ", known_connectivity, inclusive_connectivity, known_out_degree, inclusive_out_degree, population_within_radius, local_relief_m" : ""}
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?${schemaVersion !== "1" ? ", ?, ?, ?, ?, ?, ?" : ""})
    `);
    const insertNamedArea = schemaVersion !== "1" ? database.prepare(`
      INSERT INTO named_areas(
        id, name, kind, context, min_lon, min_lat, max_lon, max_lat, geometry, source_refs
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `) : null;
    const insertNamedAreaAlias = schemaVersion !== "1" ? database.prepare(`
      INSERT INTO named_area_aliases(area_id, alias, normalized_alias) VALUES (?, ?, ?)
    `) : null;
    const insertNamedAreaSpatial = schemaVersion !== "1" ? database.prepare(`
      INSERT INTO named_area_spatial(row_id, min_lon, max_lon, min_lat, max_lat) VALUES (?, ?, ?, ?, ?)
    `) : null;
    const insertSource = database.prepare(`
      INSERT INTO sources(
        id, authority, dataset, version, retrieved_at, url, license, content_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertMetadata = database.prepare("INSERT INTO metadata(key, value) VALUES (?, ?)");

    database.exec("BEGIN IMMEDIATE");
    try {
      contents.nodes.forEach((node, index) => {
        insertNode.run(node.id, ...(hasClosedRouteTopology ? [contents.closedRouteTopology!.nodeKeys.get(node.id)!] : []), node.lon, node.lat, node.elevationM, JSON.stringify(node.flags));
        insertNodeSpatial.run(index + 1, node.lon, node.lon, node.lat, node.lat);
      });
      if (hasClosedRouteTopology) {
        const insertPhysical = database.prepare("INSERT INTO physical_edges VALUES (?, ?, ?, ?, ?)");
        for (const edge of contents.closedRouteTopology!.physicalEdges) {
          insertPhysical.run(edge.physicalEdgeKey, edge.stablePhysicalId, edge.fromNodeKey, edge.toNodeKey, edge.geometryHash);
        }
      }
      contents.edges.forEach((edge, index) => {
        insertEdge.run(
          edge.id, ...(hasClosedRouteTopology ? [contents.closedRouteTopology!.edgeKeys.get(edge.id)!, contents.closedRouteTopology!.physicalEdgeKeysByStableId.get(edge.stablePhysicalId)!] : []), edge.fromNode, edge.toNode, JSON.stringify(edge.geometry), edge.lengthM,
          edge.gainM, edge.lossM, edge.maxElevationM, edge.maxSustainedGradePct,
          edge.accessState, JSON.stringify(edge.sourceRefs), JSON.stringify(edge.flags),
        );
        insertEdgeSpatial.run(index + 1, ...geometryBounds(edge.geometry));
      });
      for (const point of contents.accessPoints) {
        const rankingValues = schemaVersion !== "1" ? [
          point.knownConnectivity,
          point.inclusiveConnectivity,
          point.knownOutDegree,
          point.inclusiveOutDegree,
        ] : [];
        if (schemaVersion !== "1" && rankingValues.some((value) => value === undefined)) {
          throw new Error(`Access point ${point.id} is missing schema ${schemaVersion} ranking fields`);
        }
        const ranking = rankingValues.map((value) => value!);
        // Remoteness is optional: a pack built without a population source stores
        // nulls, which classify as "unknown" rather than as remote.
        const remoteness = schemaVersion !== "1"
          ? [point.populationWithinRadius ?? null, point.localReliefM ?? null]
          : [];
        insertAccess.run(
          point.id, point.nodeId, point.name, point.kind, point.accessState,
          point.confidence, point.parkingEvidence, JSON.stringify(point.sourceRefs), ...ranking, ...remoteness,
        );
      }
      contents.namedAreas?.forEach((area, index) => {
        insertNamedArea!.run(
          area.id, area.name, area.kind, area.context ?? null,
          area.bbox[0], area.bbox[1], area.bbox[2], area.bbox[3],
          JSON.stringify(area.geometry), JSON.stringify(area.sourceIds),
        );
        insertNamedAreaSpatial!.run(index + 1, area.bbox[0], area.bbox[2], area.bbox[1], area.bbox[3]);
        for (const alias of area.aliases) insertNamedAreaAlias!.run(area.id, alias, namedAreaSearchKey(alias));
      });
      if (schemaVersion === "4") {
        const insertSearchRegion = database.prepare("INSERT INTO search_regions(named_area_id, display_order) VALUES (?, ?)");
        for (const region of contents.searchRegions!) insertSearchRegion.run(region.namedAreaId, region.displayOrder);
      }
      if (hasClosedRouteTopology) {
        const topology = contents.closedRouteTopology!;
        const insertProfile = database.prepare("INSERT INTO topology_profiles VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
        const insertNetwork = database.prepare("INSERT INTO topology_networks VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
        const insertTopologyNode = database.prepare("INSERT INTO topology_nodes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
        const insertDecisionEdge = database.prepare("INSERT INTO topology_decision_edges VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
        const insertMember = database.prepare("INSERT INTO topology_decision_edge_members VALUES (?, ?, ?, ?, ?)");
        const insertBlock = database.prepare("INSERT INTO topology_blocks VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
        const insertBlockNode = database.prepare("INSERT INTO topology_block_nodes VALUES (?, ?, ?)");
        const insertBlockEdge = database.prepare("INSERT INTO topology_block_edges VALUES (?, ?, ?)");
        const insertBlockLink = database.prepare("INSERT INTO topology_block_links VALUES (?, ?, ?, ?, ?, ?)");
        const insertAccessTopology = database.prepare("INSERT INTO access_topology VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
        for (const profile of topology.profiles) {
          insertProfile.run(profile.profile, profile.formatVersion, profile.nodeCount, profile.physicalEdgeCount, profile.decisionNodeCount, profile.decisionEdgeCount, profile.builtAt, profile.contentHash);
          for (const network of profile.networks) insertNetwork.run(profile.profile, network.networkId, network.decisionNodeCount, network.decisionEdgeCount, network.cycleBlockCount, network.minimumCycleLengthM, network.maximumCycleLengthM, network.minimumElevationM, network.maximumElevationM, network.contentHash);
          for (const node of profile.nodes) insertTopologyNode.run(profile.profile, node.denseId, node.sourceNodeId, node.decisionNodeId, node.connectedComponentId, node.directedSccId, node.twoEdgeComponentId, Number(node.isArticulation), node.nearestCycleNetworkId, node.cyclePortalDecisionNodeId, node.minimumStemDistanceM);
          for (const edge of profile.decisionEdges) {
            insertDecisionEdge.run(profile.profile, edge.decisionEdgeKey, edge.networkId, edge.fromDecisionNodeId, edge.toDecisionNodeId, edge.lengthM, edge.gainM, edge.lossM, Number(edge.isBridge), edge.twoEdgeComponentId, edge.vertexBlockId, edge.metricsAndFlags);
            for (const member of edge.members) insertMember.run(profile.profile, edge.decisionEdgeKey, member.sequenceIndex, member.edgeKey, member.physicalEdgeKey);
          }
          for (const block of profile.blocks) {
            insertBlock.run(profile.profile, block.blockId, block.networkId, block.blockKind, block.nodeCount, block.edgeCount, block.cycleRank, block.totalPhysicalLengthM, block.minimumCycleLengthM, block.elevationSummary, block.trailSummary);
            block.decisionNodeIds.forEach((id) => insertBlockNode.run(profile.profile, block.blockId, id));
            block.decisionEdgeKeys.forEach((id) => insertBlockEdge.run(profile.profile, block.blockId, id));
          }
          profile.blockLinks.forEach((link) => insertBlockLink.run(profile.profile, link.networkId, link.fromBlockId, link.toBlockId, link.articulationDecisionNodeId, link.connectorDistanceM));
          profile.accessTopology.forEach((access) => insertAccessTopology.run(profile.profile, access.accessPointId, access.attachmentDecisionNodeId, access.cycleNetworkId, access.connectorKey, JSON.stringify(access.connectorDecisionEdgeIds), access.portalDecisionNodeId, access.minimumStemDistanceM, Number(access.canReachCycle)));
        }
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
      if (schemaVersion !== "1") {
        database.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (2, ?)")
          .run(contents.metadata.builtAt);
      }
      if (hasClosedRouteTopology) database.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (3, ?)").run(contents.metadata.builtAt);
      if (schemaVersion === "4") database.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (4, ?)").run(contents.metadata.builtAt);
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
