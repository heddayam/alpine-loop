import { readFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { packManifestV1Schema, type PackManifestV1 } from "@/lib/contracts";
import type { AccessState } from "@/lib/graph/types";
import { auditRegionalPack } from "./audit";
import type {
  AuditAccessPoint,
  AuditEdge,
  AuditNode,
  AuditSource,
  RegionalPackAudit,
} from "./types";

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

function databaseMetadata(database: DatabaseSync): Metadata {
  const rows = database.prepare("SELECT key, value FROM metadata").all() as Array<Record<string, unknown>>;
  return Object.fromEntries(rows.map((row) => [
    requiredString(row.key, "metadata.key"),
    requiredString(row.value, `metadata.${String(row.key)}`),
  ]));
}

function assertManifestMetadata(manifest: PackManifestV1, metadata: Metadata): void {
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

function sourcesFromDatabase(database: DatabaseSync, manifest: PackManifestV1): AuditSource[] {
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
    SELECT id, from_node, to_node, length_m, gain_m, loss_m, max_elevation_m,
      max_sustained_grade_pct, access_state, source_refs, flags
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
      sourceRefs: jsonStringArray(row.source_refs, `edge ${id}.source_refs`),
      flags: jsonStringArray(row.flags, `edge ${id}.flags`),
    };
  });
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
  const auditRejected = optionalCount(audit.rejectedEdgeCount, "build audit rejectedEdgeCount", errors);
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
  const manifest = packManifestV1Schema.parse(JSON.parse(await readFile(options.manifestPath, "utf8")));
  const database = new DatabaseSync(options.databasePath, { readOnly: true });
  let metadata: Metadata;
  let sources: AuditSource[];
  let edges: AuditEdge[];
  let nodes: AuditNode[];
  let accessPoints: AuditAccessPoint[];
  try {
    metadata = databaseMetadata(database);
    assertManifestMetadata(manifest, metadata);
    sources = sourcesFromDatabase(database, manifest);
    edges = edgesFromDatabase(database);
    nodes = nodesFromDatabase(database, edges);
    accessPoints = accessPointsFromDatabase(database);
  } finally {
    database.close();
  }

  const metrics = await buildMetrics(
    metadata,
    options.auditPath === undefined ? path.join(path.dirname(options.manifestPath), "audit.json") : options.auditPath,
  );
  const audit = auditRegionalPack({
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
  return audit;
}
