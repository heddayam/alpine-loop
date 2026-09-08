import { readFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { namedAreaSchema, packManifestSchema, type PackManifest } from "@/lib/contracts";
import type { AccessState } from "@/lib/graph/types";
import { edgeInsideCoverage } from "../area-geometry";
import { auditRegionalPack } from "./audit";
import type {
  AuditAccessPoint,
  AuditEdge,
  AuditNode,
  AuditSource,
  RegionalPackAudit,
} from "./types";
import { topologySha256 } from "@/lib/graph/topology-hash";
import { CLOSED_ROUTE_TOPOLOGY_FORMAT_VERSION } from "@/lib/graph/closed-route-topology";

const ACCESS_STATES = new Set<AccessState>(["public", "unknown", "private", "closed", "prohibited"]);

type Metadata = Record<string, string>;
type BuildMetrics = {
  rejectedEdgeCount: number;
  conflictRecordIds: string[];
  conflictCount: number;
  errors: string[];
  warnings: string[];
};

export type SqlitePackAuditOptions = {
  databasePath: string;
  manifestPath: string;
  /** Defaults to audit.json beside the manifest. Pass null when no build audit exists. */
  auditPath?: string | null;
  onProgress?: (label: string) => void;
};

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`Invalid ${field}: expected a non-empty string`);
  return value;
}

function nullableNumber(value: unknown, field: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number") throw new Error(`Invalid ${field}: expected a number or null`);
  return value;
}

function requiredNumber(value: unknown, field: string): number {
  if (typeof value !== "number") throw new Error(`Invalid ${field}: expected a number`);
  return value;
}

function accessState(value: unknown, field: string): AccessState {
  if (typeof value !== "string" || !ACCESS_STATES.has(value as AccessState)) {
    throw new Error(`Invalid ${field}: ${String(value)}`);
  }
  return value as AccessState;
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new Error(`Invalid ${field}: expected an array of non-empty strings`);
  }
  return [...new Set(value)];
}

function jsonStringArray(value: unknown, field: string): string[] {
  const encoded = requiredString(value, field);
  try {
    return stringArray(JSON.parse(encoded), field);
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`Invalid ${field}: malformed JSON`, { cause: error });
    throw error;
  }
}

function jsonCoordinates(value: unknown, field: string): Array<[number, number]> {
  const encoded = requiredString(value, field);
  let parsed: unknown;
  try {
    parsed = JSON.parse(encoded);
  } catch (error) {
    throw new Error(`Invalid ${field}: malformed JSON`, { cause: error });
  }
  if (!Array.isArray(parsed) || parsed.length < 2 || parsed.some((coordinate) =>
    !Array.isArray(coordinate) || coordinate.length !== 2 || coordinate.some((number) => typeof number !== "number" || !Number.isFinite(number)))) {
    throw new Error(`Invalid ${field}: expected at least two finite coordinate pairs`);
  }
  return parsed as Array<[number, number]>;
}

function databaseMetadata(database: DatabaseSync): Metadata {
  const rows = database.prepare("SELECT key, value FROM metadata").all() as Array<Record<string, unknown>>;
  return Object.fromEntries(rows.map((row) => [
    requiredString(row.key, "metadata.key"),
    requiredString(row.value, `metadata.${String(row.key)}`),
  ]));
}

function assertManifestMetadata(manifest: PackManifest, metadata: Metadata): void {
  const expected: Metadata = {
    schemaVersion: manifest.schemaVersion,
    packId: manifest.id,
    dataVersion: manifest.dataVersion,
    builtAt: manifest.builtAt,
    compilerVersion: manifest.compilerVersion,
    metricAlgorithmVersion: manifest.metricAlgorithmVersion,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (metadata[key] !== value) {
      throw new Error(`Manifest/database mismatch for ${key}: manifest=${value}, database=${metadata[key] ?? "missing"}`);
    }
  }
}

function sourcesFromDatabase(database: DatabaseSync, manifest: PackManifest): AuditSource[] {
  const rows = database.prepare(`
    SELECT id, authority, dataset, version, retrieved_at, url, license, content_hash
    FROM sources ORDER BY id
  `).all() as Array<Record<string, unknown>>;
  const manifestById = new Map(manifest.sources.map((source) => [source.id, source]));
  const databaseIds = rows.map((row) => requiredString(row.id, "sources.id"));
  const manifestIds = [...manifestById.keys()].sort();
  if (databaseIds.join("\u0000") !== manifestIds.join("\u0000")) {
    throw new Error(`Manifest/database source IDs do not match: manifest=${manifestIds.join(",")}, database=${databaseIds.join(",")}`);
  }

  return rows.map((row) => {
    const id = requiredString(row.id, "sources.id");
    const persisted = {
      id,
      authority: requiredString(row.authority, `source ${id}.authority`),
      dataset: requiredString(row.dataset, `source ${id}.dataset`),
      version: requiredString(row.version, `source ${id}.version`),
      retrievedAt: requiredString(row.retrieved_at, `source ${id}.retrieved_at`),
      url: requiredString(row.url, `source ${id}.url`),
      license: requiredString(row.license, `source ${id}.license`),
      contentHash: requiredString(row.content_hash, `source ${id}.content_hash`),
    };
    const declared = manifestById.get(id)!;
    for (const key of ["authority", "dataset", "version", "retrievedAt", "url", "license", "contentHash"] as const) {
      if (persisted[key] !== declared[key]) {
        throw new Error(`Manifest/database source mismatch for ${id}.${key}`);
      }
    }
    return {
      ...persisted,
      // Pack schema v1 intentionally persists the recorded license/terms decision
      // in one field. Official-source snapshots concatenate both before compilation.
      termsDecision: persisted.license,
    };
  });
}

function edgesFromDatabase(database: DatabaseSync): AuditEdge[] {
  const rows = database.prepare(`
    SELECT id, from_node, to_node, geometry, length_m, gain_m, loss_m, max_elevation_m,
      max_sustained_grade_pct, access_state, edge_class, source_refs, flags
    FROM edges ORDER BY id
  `).all() as Array<Record<string, unknown>>;
  return rows.map((row) => {
    const id = requiredString(row.id, "edges.id");
    return {
      id,
      fromNode: requiredString(row.from_node, `edge ${id}.from_node`),
      toNode: requiredString(row.to_node, `edge ${id}.to_node`),
      lengthM: requiredNumber(row.length_m, `edge ${id}.length_m`),
      gainM: nullableNumber(row.gain_m, `edge ${id}.gain_m`),
      lossM: nullableNumber(row.loss_m, `edge ${id}.loss_m`),
      maxElevationM: nullableNumber(row.max_elevation_m, `edge ${id}.max_elevation_m`),
      maxSustainedGradePct: nullableNumber(row.max_sustained_grade_pct, `edge ${id}.max_sustained_grade_pct`),
      accessState: accessState(row.access_state, `edge ${id}.access_state`),
      edgeClass: requiredString(row.edge_class, `edge ${id}.edge_class`) as AuditEdge["edgeClass"],
      sourceRefs: jsonStringArray(row.source_refs, `edge ${id}.source_refs`),
      flags: jsonStringArray(row.flags, `edge ${id}.flags`),
      geometry: jsonCoordinates(row.geometry, `edge ${id}.geometry`),
    };
  });
}

function auditNamedAreas(
  database: DatabaseSync,
  manifest: PackManifest,
  sourceIds: ReadonlySet<string>,
): { count: number; errors: string[] } {
  const errors: string[] = [];
  const rows = database.prepare(`
    SELECT id, name, kind, context, min_lon, min_lat, max_lon, max_lat, geometry, source_refs
    FROM named_areas ORDER BY id
  `).all() as Array<Record<string, unknown>>;
  const ids = new Set<string>();
  for (const row of rows) {
    const id = requiredString(row.id, "named_areas.id");
    ids.add(id);
    try {
      const area = namedAreaSchema.parse({
        id,
        name: row.name,
        kind: row.kind,
        ...(row.context === null ? {} : { context: row.context }),
        bbox: [row.min_lon, row.min_lat, row.max_lon, row.max_lat],
        geometry: JSON.parse(requiredString(row.geometry, `named area ${id}.geometry`)),
        sourceIds: jsonStringArray(row.source_refs, `named area ${id}.source_refs`),
      });
      if (area.sourceIds.some((sourceId) => !sourceIds.has(sourceId))) errors.push(`Named area ${id} references an unknown source`);
    } catch (error) {
      errors.push(`Named area ${id} is invalid: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (!ids.has(`pack:${manifest.id}`)) errors.push(`Named-area catalog is missing pack:${manifest.id}`);
  const aliasAreas = database.prepare("SELECT DISTINCT area_id FROM named_area_aliases ORDER BY area_id")
    .all().map((row) => requiredString((row as Record<string, unknown>).area_id, "named_area_aliases.area_id"));
  for (const id of ids) if (!aliasAreas.includes(id)) errors.push(`Named area ${id} has no searchable alias`);
  const spatialCount = requiredNumber(
    (database.prepare("SELECT count(*) AS count FROM named_area_spatial").get() as Record<string, unknown>).count,
    "named_area_spatial count",
  );
  if (spatialCount !== rows.length) errors.push(`Named-area spatial row count ${spatialCount} does not match catalog count ${rows.length}`);
  return { count: rows.length, errors };
}

function auditSearchRegions(database: DatabaseSync): { count: number; errors: string[] } {
  const rows = database.prepare(`
    SELECT r.named_area_id, r.display_order, a.name, a.kind
    FROM search_regions r
    LEFT JOIN named_areas a ON a.id = r.named_area_id
    ORDER BY r.display_order, r.named_area_id
  `).all() as Array<Record<string, unknown>>;
  const errors: string[] = [];
  if (rows.length === 0) errors.push("Search-region catalog is empty");
  const allowedKinds = new Set(["pack", "park", "preserve", "protected-area"]);
  rows.forEach((row, index) => {
    const id = requiredString(row.named_area_id, "search_regions.named_area_id");
    if (row.name === null || row.kind === null) {
      errors.push(`Search region ${id} references a missing named area`);
      return;
    }
    const name = requiredString(row.name, `search region ${id}.name`);
    const kind = requiredString(row.kind, `search region ${id}.kind`);
    const displayOrder = requiredNumber(row.display_order, `search region ${id}.display_order`);
    if (!Number.isSafeInteger(displayOrder) || displayOrder !== index) {
      errors.push(`Search region ${id} has non-contiguous display order ${displayOrder}; expected ${index}`);
    }
    if (!allowedKinds.has(kind)) errors.push(`Search region ${id} has unsupported kind ${kind}`);
    if (/\bclosed areas?\b/i.test(name)) errors.push(`Search region ${id} refers to a closed-area variant`);
  });
  return { count: rows.length, errors };
}

function auditElevationProfiles(database: DatabaseSync): string[] {
  const errors: string[] = [];
  const edges = database.prepare(`SELECT edge_key, id, length_m, elevation_profile FROM edges
    WHERE edge_class = 'trail' ORDER BY edge_key`)
    .all() as Array<Record<string, unknown>>;
  for (const edge of edges) {
    requiredNumber(edge.edge_key, "edges.edge_key");
    const id = requiredString(edge.id, "edges.id");
    const length = requiredNumber(edge.length_m, `edge ${id}.length_m`);
    let samples: unknown[][] = [];
    try {
      const parsed: unknown = JSON.parse(requiredString(edge.elevation_profile, `edge ${id}.elevation_profile`));
      if (Array.isArray(parsed) && parsed.every(Array.isArray)) samples = parsed;
    } catch { /* Report the invalid profile below. */ }
    if (samples.length < 2) { errors.push(`Edge ${id} has no complete elevation profile`); continue; }
    let previous = -1;
    samples.forEach((sample, index) => {
      if (sample.length !== 2) { errors.push(`Edge ${id} has a malformed elevation profile sample`); return; }
      const distance = requiredNumber(sample[0], `edge ${id} profile distance`);
      requiredNumber(sample[1], `edge ${id} profile elevation`);
      if (index === 0 && Math.abs(distance) > 1e-6) errors.push(`Edge ${id} elevation profile does not start at zero`);
      if (previous >= 0 && (distance <= previous || distance - previous > 25.001)) {
        errors.push(`Edge ${id} elevation profile spacing exceeds 25 meters or is not increasing`);
      }
      previous = distance;
    });
    if (Math.abs(previous - length) > 0.01) errors.push(`Edge ${id} elevation profile does not end at edge length`);
  }
  return errors;
}

function auditPortalAccess(database: DatabaseSync): string[] {
  const errors: string[] = [];
  const contextEdges = requiredNumber(
    (database.prepare("SELECT count(*) AS count FROM edges WHERE edge_class <> 'trail'").get() as Record<string, unknown>).count,
    "schema 6 context edge count",
  );
  if (contextEdges > 0) errors.push(`${contextEdges} build-only road or sidewalk edges were published`);
  const rows = database.prepare(`SELECT id, kind, reachable_trail_km, trail_component_id,
    portal_road_class, parking_distance_m FROM access_points ORDER BY id`).all() as Array<Record<string, unknown>>;
  for (const row of rows) {
    const id = requiredString(row.id, "access_points.id");
    if (row.kind !== "trailhead") errors.push(`Schema 6 access point ${id} is not a trailhead portal`);
    const reachable = requiredNumber(row.reachable_trail_km, `access point ${id}.reachable_trail_km`);
    if (!Number.isFinite(reachable) || reachable < 0) errors.push(`Schema 6 access point ${id} has invalid trail reach`);
    requiredString(row.trail_component_id, `access point ${id}.trail_component_id`);
    if (row.portal_road_class !== "street" && row.portal_road_class !== "service-road") {
      errors.push(`Schema 6 access point ${id} has invalid portal road class`);
    }
    if (row.parking_distance_m !== null) {
      const parkingDistance = requiredNumber(row.parking_distance_m, `access point ${id}.parking_distance_m`);
      if (!Number.isFinite(parkingDistance) || parkingDistance < 0) errors.push(`Schema 6 access point ${id} has invalid parking distance`);
    }
  }
  return errors;
}

function nodesFromDatabase(database: DatabaseSync, edges: AuditEdge[]): AuditNode[] {
  const incidentSources = new Map<string, Set<string>>();
  for (const edge of edges) {
    for (const nodeId of [edge.fromNode, edge.toNode]) {
      const refs = incidentSources.get(nodeId) ?? new Set<string>();
      edge.sourceRefs.forEach((sourceId) => refs.add(sourceId));
      incidentSources.set(nodeId, refs);
    }
  }
  const rows = database.prepare("SELECT id, elevation_m FROM nodes ORDER BY id").all() as Array<Record<string, unknown>>;
  return rows.map((row) => {
    const id = requiredString(row.id, "nodes.id");
    return {
      id,
      elevationM: nullableNumber(row.elevation_m, `node ${id}.elevation_m`),
      sourceRefs: [...(incidentSources.get(id) ?? [])].sort(),
    };
  });
}

function accessPointsFromDatabase(database: DatabaseSync): AuditAccessPoint[] {
  const rows = database.prepare(`
    SELECT id, access_state, source_refs FROM access_points ORDER BY id
  `).all() as Array<Record<string, unknown>>;
  return rows.map((row) => {
    const id = requiredString(row.id, "access_points.id");
    return {
      id,
      accessState: accessState(row.access_state, `access point ${id}.access_state`),
      sourceRefs: jsonStringArray(row.source_refs, `access point ${id}.source_refs`),
    };
  });
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function optionalCount(value: unknown, field: string, errors: string[]): number | null {
  if (value === undefined) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    errors.push(`Invalid ${field}; defaulted to 0 instead of assuming a successful build metric`);
    return 0;
  }
  return value;
}

async function buildMetrics(metadata: Metadata, auditPath: string | null): Promise<BuildMetrics> {
  const errors: string[] = [];
  const warnings: string[] = [];
  let audit: Record<string, unknown> = {};
  if (auditPath !== null) {
    try {
      audit = objectValue(JSON.parse(await readFile(auditPath, "utf8"))) ?? {};
      if (Object.keys(audit).length === 0) errors.push(`Build audit ${auditPath} is not a non-empty object`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        warnings.push(`Build audit ${auditPath} is missing; rejected-edge and conflict metrics default to 0`);
      } else {
        errors.push(`Build audit ${auditPath} could not be parsed; metrics defaulted to 0`);
      }
    }
  } else {
    warnings.push("No build audit was supplied; rejected-edge and conflict metrics default to 0");
  }

  const metadataRejected = metadata.rejectedEdgeCount === undefined
    ? null
    : optionalCount(Number(metadata.rejectedEdgeCount), "metadata.rejectedEdgeCount", errors);
  const auditRejected = optionalCount(
    audit.rejectedCoverageEdgeCount ?? audit.rejectedEdgeCount,
    "build audit rejectedCoverageEdgeCount",
    errors,
  );
  const rejectedWays = optionalCount(audit.rejectedWayCount, "build audit rejectedWayCount", errors);
  let rejectedEdgeCount = metadataRejected ?? auditRejected ?? rejectedWays ?? 0;
  if (metadataRejected === null && auditRejected === null && rejectedWays !== null) {
    warnings.push("Build audit reports rejected ways, not rejected directed edges; using rejectedWayCount as the available rejection count");
  } else if (metadataRejected === null && auditRejected === null && rejectedWays === null) {
    warnings.push("No rejected-edge metric was recorded; rejectedEdgeCount defaulted to 0");
    rejectedEdgeCount = 0;
  }

  let conflictRecordIds: string[] = [];
  const encodedConflictIds = metadata.conflictRecordIds;
  if (encodedConflictIds !== undefined) {
    try {
      conflictRecordIds = stringArray(JSON.parse(encodedConflictIds), "metadata.conflictRecordIds");
    } catch {
      errors.push("Invalid metadata.conflictRecordIds; no conflict record IDs were inferred");
    }
  } else if (audit.conflictRecordIds !== undefined) {
    try {
      conflictRecordIds = stringArray(audit.conflictRecordIds, "build audit conflictRecordIds");
    } catch {
      errors.push("Invalid build audit conflictRecordIds; no conflict record IDs were inferred");
    }
  }
  const metadataConflictCount = metadata.conflictCount === undefined
    ? null
    : optionalCount(Number(metadata.conflictCount), "metadata.conflictCount", errors);
  const auditConflictCount = optionalCount(audit.conflictCount, "build audit conflictCount", errors);
  const conflictCount = metadataConflictCount ?? auditConflictCount ?? conflictRecordIds.length;
  if (metadataConflictCount === null && auditConflictCount === null && conflictRecordIds.length === 0) {
    warnings.push("No conflict metric was recorded; conflictCount defaulted to 0");
  }
  if (conflictCount !== conflictRecordIds.length) {
    errors.push(`Build metadata reports ${conflictCount} conflicts but provides ${conflictRecordIds.length} conflict record IDs`);
  }

  return { rejectedEdgeCount, conflictRecordIds, conflictCount, errors, warnings };
}

export async function auditSqlitePack(options: SqlitePackAuditOptions): Promise<RegionalPackAudit> {
  options.onProgress?.("Validate pack metadata and source records");
  const manifest = packManifestSchema.parse(JSON.parse(await readFile(options.manifestPath, "utf8")));
  const database = new DatabaseSync(options.databasePath, { readOnly: true });
  let metadata: Metadata;
  let sources: AuditSource[];
  let edges: AuditEdge[];
  let nodes: AuditNode[];
  let accessPoints: AuditAccessPoint[];
  let namedAreas: ReturnType<typeof auditNamedAreas>;
  let searchRegions: ReturnType<typeof auditSearchRegions>;
  let topologyCounts: { profiles: number; networks: number; decisionEdges: number };
  try {
    metadata = databaseMetadata(database);
    assertManifestMetadata(manifest, metadata);
    sources = sourcesFromDatabase(database, manifest);
    options.onProgress?.("Read the graph and access points");
    edges = edgesFromDatabase(database);
    nodes = nodesFromDatabase(database, edges);
    accessPoints = accessPointsFromDatabase(database);
    options.onProgress?.("Validate named areas, elevation profiles, and access");
    namedAreas = auditNamedAreas(database, manifest, new Set(sources.map(({ id }) => id)));
    searchRegions = auditSearchRegions(database);
    const elevationProfileErrors = auditElevationProfiles(database);
    if (elevationProfileErrors.length) throw new Error(elevationProfileErrors.join("; "));
    const portalErrors = auditPortalAccess(database);
    if (portalErrors.length) throw new Error(portalErrors.join("; "));
    options.onProgress?.("Validate topology counts and hashes");
    const profiles = database.prepare(`SELECT profile, format_version, node_count, physical_edge_count,
      decision_node_count, decision_edge_count, built_at, content_hash FROM topology_profiles ORDER BY profile DESC`).all() as Array<Record<string, unknown>>;
    if (profiles.map(({ profile }) => profile).join(",") !== "known,inclusive") throw new Error("Closed-route topology profiles must be exactly known,inclusive");
    for (const row of profiles) {
      const profile = requiredString(row.profile, "topology profile");
      if (row.format_version !== 1 && row.format_version !== CLOSED_ROUTE_TOPOLOGY_FORMAT_VERSION) {
        throw new Error(`Unsupported ${profile} topology format version`);
      }
      const count = (table: string, predicate = "profile = ?") => requiredNumber(
        (database.prepare(`SELECT count(*) AS count FROM ${table} WHERE ${predicate}`).get(profile) as Record<string, unknown>).count,
        `${table} count`,
      );
      const expectedNodes = requiredNumber(row.node_count, `${profile}.node_count`);
      const expectedPhysical = requiredNumber(row.physical_edge_count, `${profile}.physical_edge_count`);
      const expectedDecisionNodes = requiredNumber(row.decision_node_count, `${profile}.decision_node_count`);
      const expectedDecisionEdges = requiredNumber(row.decision_edge_count, `${profile}.decision_edge_count`);
      const actualNodes = count("topology_nodes");
      const actualPhysical = requiredNumber((database.prepare(`SELECT count(DISTINCT physical_edge_key) AS count FROM edges
            WHERE (edge_class = 'trail' AND access_state = 'public')
               OR (edge_class = 'trail' AND ? = 'inclusive' AND access_state = 'unknown')`).get(profile) as Record<string, unknown>).count, "topology physical count");
      const actualDecisionNodes = requiredNumber((database.prepare(`SELECT count(*) AS count FROM topology_nodes
        WHERE profile = ? AND decision_node_id IS NOT NULL`).get(profile) as Record<string, unknown>).count, "topology decision node count");
      const actualDecisionEdges = count("topology_decision_edges");
      if (expectedNodes !== actualNodes || expectedPhysical !== actualPhysical || expectedDecisionNodes !== actualDecisionNodes || expectedDecisionEdges !== actualDecisionEdges) {
        throw new Error(`Closed-route topology count mismatch for ${profile}`);
      }
      const accessCount = count("access_topology");
      if (accessCount !== accessPoints.length) throw new Error(`Schema 6 fallback access topology count mismatch for ${profile}`);
    }
    for (const table of ["topology_networks", "topology_nodes", "topology_decision_edges", "topology_decision_edge_members", "topology_blocks", "topology_block_nodes", "topology_block_edges", "topology_block_links"]) {
      const count = requiredNumber((database.prepare(`SELECT count(*) AS count FROM ${table}`).get() as Record<string, unknown>).count, `${table} count`);
      if (count !== 0) throw new Error(`Reachable-graph fallback packs must not persist primitive rows in ${table}`);
    }
    const combinedHash = topologySha256({
      runtimeMode: manifest.closedRouteTopology.runtimeMode,
      algorithmVersion: manifest.closedRouteTopology.algorithmVersion,
      policyVersion: manifest.closedRouteTopology.policyVersion,
      profiles: profiles.map((row) => ({ profile: requiredString(row.profile, "topology profile"), contentHash: requiredString(row.content_hash, "topology content hash") })),
    });
    if (metadata.topologyContentHash !== combinedHash) throw new Error("Schema 6 topology content hash mismatch");
    topologyCounts = {
      profiles: profiles.length,
      networks: requiredNumber((database.prepare("SELECT count(*) AS count FROM topology_networks").get() as Record<string, unknown>).count, "topology network count"),
      decisionEdges: requiredNumber((database.prepare("SELECT count(*) AS count FROM topology_decision_edges").get() as Record<string, unknown>).count, "topology decision edge count"),
    };
  } finally {
    database.close();
  }

  options.onProgress?.("Audit graph connectivity and build metrics");
  const metrics = await buildMetrics(
    metadata,
    options.auditPath === undefined ? path.join(path.dirname(options.manifestPath), "audit.json") : options.auditPath,
  );
  const audit = auditRegionalPack({
    schemaVersion: manifest.schemaVersion,
    packId: manifest.id,
    dataVersion: manifest.dataVersion,
    nodes,
    edges,
    accessPoints,
    sources,
    rejectedEdgeCount: metrics.rejectedEdgeCount,
    conflictRecordIds: metrics.conflictRecordIds,
  });
  audit.warnings.push(...metrics.warnings);
  audit.errors.push(...metrics.errors);
  audit.counts.conflicts = metrics.conflictCount;
  audit.counts.namedAreas = namedAreas.count;
  audit.errors.push(...namedAreas.errors);
  options.onProgress?.(`Check exact coverage: 0/${edges.length} edges`);
  let lastCoverageProgress = options.onProgress ? Date.now() : 0;
  audit.outsideCoverageEdgeIds = edges
    .filter((edge, index) => {
      const outside = !edgeInsideCoverage({ geometry: edge.geometry! }, manifest.coverage.boundary);
      if (options.onProgress && Date.now() - lastCoverageProgress >= 5_000) {
        options.onProgress(`Check exact coverage: ${index + 1}/${edges.length} edges`);
        lastCoverageProgress = Date.now();
      }
      return outside;
    })
    .map(({ id }) => id);
  options.onProgress?.(`Check exact coverage: ${edges.length}/${edges.length} edges`);
  if (audit.outsideCoverageEdgeIds.length) {
    audit.errors.push(`${audit.outsideCoverageEdgeIds.length} persisted edges leave exact pack coverage`);
  }
  audit.counts.searchRegions = searchRegions.count;
  audit.errors.push(...searchRegions.errors);
  audit.counts = { ...audit.counts, topologyProfiles: topologyCounts.profiles, topologyNetworks: topologyCounts.networks, topologyDecisionEdges: topologyCounts.decisionEdges };
  return audit;
}
