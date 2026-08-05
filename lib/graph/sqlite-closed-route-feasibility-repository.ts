import { createHash, type Hash } from "node:crypto";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { packManifestV3Schema, type PackManifestV3, type TopologyProfile } from "@/lib/contracts";
import type { AccessTopology } from "./closed-route-topology";

type SqliteRow = Record<string, SQLInputValue>;

export type SQLiteClosedRouteFeasibilityRepositoryOptions = {
  databasePath: string;
  manifest: unknown;
};

/** The narrow read surface needed by the reachable-graph fallback. */
export interface ClosedRouteFeasibilityRepository {
  readonly packId: string;
  readonly dataVersion: string;

  getAccessTopology(
    profile: TopologyProfile,
    accessPointIds: readonly string[],
  ): Promise<AccessTopology[]>;
  close(): Promise<void>;
}

const TOPOLOGY_FORMAT_VERSION = 1;
const BATCH_SIZE = 500;
const PROFILES = ["known", "inclusive"] as const satisfies readonly TopologyProfile[];
const REQUIRED_TABLES = [
  "metadata",
  "schema_migrations",
  "access_points",
  "topology_profiles",
  "access_topology",
] as const;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;

function corruption(message: string): Error {
  return new Error(`Closed-route feasibility corruption: ${message}`);
}

function updateCanonicalHash(hash: Hash, value: unknown): void {
  if (Array.isArray(value)) {
    hash.update("[");
    value.forEach((item, index) => {
      if (index) hash.update(",");
      updateCanonicalHash(hash, item === undefined ? null : item);
    });
    hash.update("]");
    return;
  }
  if (value !== null && typeof value === "object") {
    hash.update("{");
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    entries.forEach(([key, item], index) => {
      if (index) hash.update(",");
      hash.update(JSON.stringify(key));
      hash.update(":");
      updateCanonicalHash(hash, item);
    });
    hash.update("}");
    return;
  }
  hash.update(JSON.stringify(value));
}

function topologyHash(value: unknown): string {
  const hash = createHash("sha256");
  updateCanonicalHash(hash, value);
  return `sha256:${hash.digest("hex")}`;
}

function requiredString(row: SqliteRow, column: string): string {
  const value = row[column];
  if (typeof value !== "string" || value.length === 0) throw corruption(`invalid ${column}`);
  return value;
}

function nullableString(row: SqliteRow, column: string): string | null {
  const value = row[column];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || value.length === 0) throw corruption(`invalid ${column}`);
  return value;
}

function requiredNumber(row: SqliteRow, column: string): number {
  const value = row[column];
  if (typeof value !== "number" || !Number.isFinite(value)) throw corruption(`invalid ${column}`);
  return value;
}

function requiredInteger(row: SqliteRow, column: string): number {
  const value = requiredNumber(row, column);
  if (!Number.isSafeInteger(value)) throw corruption(`invalid integer ${column}`);
  return value;
}

function nonNegativeInteger(row: SqliteRow, column: string): number {
  const value = requiredInteger(row, column);
  if (value < 0) throw corruption(`negative ${column}`);
  return value;
}

function nullableNonNegativeInteger(row: SqliteRow, column: string): number | null {
  const value = row[column];
  if (value === null || value === undefined) return null;
  return nonNegativeInteger(row, column);
}

function nullableNonNegativeNumber(row: SqliteRow, column: string): number | null {
  const value = row[column];
  if (value === null || value === undefined) return null;
  const number = requiredNumber(row, column);
  if (number < 0) throw corruption(`negative ${column}`);
  return number;
}

function booleanInteger(row: SqliteRow, column: string): boolean {
  const value = requiredInteger(row, column);
  if (value !== 0 && value !== 1) throw corruption(`invalid boolean ${column}`);
  return value === 1;
}

function integerArray(value: SQLInputValue | undefined, label: string): readonly number[] {
  if (typeof value !== "string") throw corruption(`invalid ${label}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw corruption(`invalid JSON in ${label}`);
  }
  if (!Array.isArray(parsed) || !parsed.every((item) => Number.isSafeInteger(item) && item >= 0)) {
    throw corruption(`invalid integer array in ${label}`);
  }
  return Object.freeze([...parsed]);
}

function freezeAccessTopology(row: SqliteRow): AccessTopology {
  const profile = requiredString(row, "profile");
  if (!PROFILES.includes(profile as TopologyProfile)) throw corruption(`unsupported topology profile ${profile}`);
  const accessPointId = requiredString(row, "access_point_id");
  const cycleNetworkId = nullableNonNegativeInteger(row, "cycle_network_id");
  const connectorKey = nullableString(row, "connector_key");
  const connectorDecisionEdgeIds = integerArray(
    row.connector_decision_edge_ids,
    "connector decision edge IDs",
  );
  const portalDecisionNodeId = nullableNonNegativeInteger(row, "portal_decision_node_id");
  const minimumStemDistanceMeters = nullableNonNegativeNumber(row, "minimum_stem_distance_m");
  const canReachCycle = booleanInteger(row, "can_reach_cycle");

  if (canReachCycle !== (cycleNetworkId !== null)) {
    throw corruption(`${profile} access ${accessPointId} has inconsistent cycle reachability`);
  }
  if (!canReachCycle && (
    connectorKey !== null || connectorDecisionEdgeIds.length !== 0 || portalDecisionNodeId !== null ||
    minimumStemDistanceMeters !== null
  )) {
    throw corruption(`${profile} access ${accessPointId} has stale unreachable connector data`);
  }
  if (canReachCycle && (
    connectorKey === null || portalDecisionNodeId === null || minimumStemDistanceMeters === null
  )) {
    throw corruption(`${profile} access ${accessPointId} has incomplete reachable connector data`);
  }

  return Object.freeze({
    profile: profile as TopologyProfile,
    accessPointId,
    attachmentDecisionNodeId: nonNegativeInteger(row, "attachment_decision_node_id"),
    cycleNetworkId,
    connectorKey,
    connectorDecisionEdgeIds,
    portalDecisionNodeId,
    minimumStemDistanceMeters,
    canReachCycle,
  });
}

function metadata(database: DatabaseSync): Map<string, string> {
  const rows = database.prepare("SELECT key, value FROM metadata ORDER BY key").all() as SqliteRow[];
  const result = new Map<string, string>();
  for (const row of rows) {
    const key = requiredString(row, "key");
    if (result.has(key)) throw corruption(`duplicate metadata key ${key}`);
    result.set(key, requiredString(row, "value"));
  }
  return result;
}

export class SQLiteClosedRouteFeasibilityRepository implements ClosedRouteFeasibilityRepository {
  readonly packId: string;
  readonly dataVersion: string;
  readonly #manifest: PackManifestV3;
  readonly #database: DatabaseSync;
  #closed = false;

  constructor(options: SQLiteClosedRouteFeasibilityRepositoryOptions) {
    this.#manifest = packManifestV3Schema.parse(options.manifest);
    if (this.#manifest.closedRouteTopology.runtimeMode !== "reachable-graph-fallback") {
      throw new Error("Closed-route feasibility repository requires a reachable-graph fallback pack");
    }
    this.packId = this.#manifest.id;
    this.dataVersion = this.#manifest.dataVersion;
    this.#database = new DatabaseSync(options.databasePath, { readOnly: true });
    try {
      this.#validatePack();
    } catch (error) {
      this.#closed = true;
      this.#database.close();
      throw error;
    }
  }

  async getAccessTopology(
    profile: TopologyProfile,
    accessPointIds: readonly string[],
  ): Promise<AccessTopology[]> {
    this.#assertOpen();
    this.#assertProfile(profile);
    for (const accessPointId of accessPointIds) {
      if (typeof accessPointId !== "string" || accessPointId.length === 0) {
        throw new Error("accessPointIds must contain non-empty strings");
      }
    }
    if (accessPointIds.length === 0) return [];

    const uniqueIds = [...new Set(accessPointIds)];
    const byId = new Map<string, AccessTopology>();
    for (let index = 0; index < uniqueIds.length; index += BATCH_SIZE) {
      const batch = uniqueIds.slice(index, index + BATCH_SIZE);
      const placeholders = batch.map(() => "?").join(", ");
      const rows = this.#database.prepare(`
        SELECT * FROM access_topology
        WHERE profile = ? AND access_point_id IN (${placeholders})
      `).all(profile, ...batch) as SqliteRow[];
      for (const row of rows) {
        const parsed = freezeAccessTopology(row);
        if (byId.has(parsed.accessPointId)) {
          throw corruption(`duplicate ${profile} access topology for ${parsed.accessPointId}`);
        }
        byId.set(parsed.accessPointId, parsed);
      }
    }
    return accessPointIds.flatMap((accessPointId) => {
      const access = byId.get(accessPointId);
      return access ? [access] : [];
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#database.close();
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("Closed-route feasibility repository is closed");
  }

  #assertProfile(profile: TopologyProfile): void {
    if (!PROFILES.includes(profile)) throw new Error(`Unsupported topology profile ${profile}`);
  }

  #validatePack(): void {
    const tableRows = this.#database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    ).all() as SqliteRow[];
    const tables = new Set(tableRows.map((row) => requiredString(row, "name")));
    for (const table of REQUIRED_TABLES) {
      if (!tables.has(table)) throw corruption(`missing table ${table}`);
    }

    const migrations = (this.#database.prepare(
      "SELECT version FROM schema_migrations ORDER BY version",
    ).all() as SqliteRow[]).map((row) => requiredInteger(row, "version"));
    if (migrations.length !== 3 || migrations.some((version, index) => version !== index + 1)) {
      throw corruption(`expected schema migrations 1, 2, 3; got ${migrations.join(", ") || "none"}`);
    }

    const values = metadata(this.#database);
    const expectedMetadata = {
      schemaVersion: "3",
      packId: this.packId,
      dataVersion: this.dataVersion,
      builtAt: this.#manifest.builtAt,
      compilerVersion: this.#manifest.compilerVersion,
      metricAlgorithmVersion: this.#manifest.metricAlgorithmVersion,
    };
    for (const [key, expected] of Object.entries(expectedMetadata)) {
      const actual = values.get(key);
      if (actual !== expected) {
        const kind = key === "dataVersion" ? "stale data version" : `metadata ${key}`;
        throw corruption(`${kind}: expected ${expected}, got ${actual ?? "missing"}`);
      }
    }
    const topologyContentHash = values.get("topologyContentHash");
    if (!topologyContentHash || !SHA256_PATTERN.test(topologyContentHash)) {
      throw corruption("invalid topologyContentHash metadata");
    }

    const profiles = this.#validateProfiles();
    const accessTopology = this.#validateAccessTopology();
    const profileHashes = PROFILES.map((profile) => {
      const row = profiles.get(profile)!;
      const contentHash = topologyHash({
        profile,
        formatVersion: requiredInteger(row, "format_version"),
        nodeCount: requiredInteger(row, "node_count"),
        physicalEdgeCount: requiredInteger(row, "physical_edge_count"),
        decisionNodeCount: requiredInteger(row, "decision_node_count"),
        decisionEdgeCount: requiredInteger(row, "decision_edge_count"),
        nodes: [],
        decisionEdges: [],
        blocks: [],
        blockLinks: [],
        networks: [],
        accessTopology: accessTopology.filter((access) => access.profile === profile).map((access) => ({
          accessPointId: access.accessPointId,
          attachmentDecisionNodeId: access.attachmentDecisionNodeId,
          cycleNetworkId: access.cycleNetworkId,
          connectorKey: access.connectorKey,
          connectorDecisionEdgeIds: [...access.connectorDecisionEdgeIds],
          portalDecisionNodeId: access.portalDecisionNodeId,
          minimumStemDistanceM: access.minimumStemDistanceMeters,
          canReachCycle: access.canReachCycle,
        })),
      });
      if (contentHash !== requiredString(row, "content_hash")) {
        throw corruption(`${profile} profile content hash mismatch`);
      }
      return { profile, contentHash };
    });
    const combinedHash = topologyHash({
      runtimeMode: this.#manifest.closedRouteTopology.runtimeMode,
      algorithmVersion: this.#manifest.closedRouteTopology.algorithmVersion,
      policyVersion: this.#manifest.closedRouteTopology.policyVersion,
      profiles: profileHashes,
    });
    if (topologyContentHash !== combinedHash) throw corruption("combined topology content hash mismatch");
  }

  #validateProfiles(): Map<TopologyProfile, SqliteRow> {
    const rows = this.#database.prepare("SELECT * FROM topology_profiles ORDER BY profile").all() as SqliteRow[];
    if (rows.length !== PROFILES.length) throw corruption("topology profile count mismatch");
    const seen = new Set<string>();
    const byProfile = new Map<TopologyProfile, SqliteRow>();
    for (const row of rows) {
      const profile = requiredString(row, "profile");
      if (!PROFILES.includes(profile as TopologyProfile)) throw corruption(`unsupported topology profile ${profile}`);
      if (seen.has(profile)) throw corruption(`duplicate ${profile} topology profile`);
      seen.add(profile);
      byProfile.set(profile as TopologyProfile, row);
      if (requiredInteger(row, "format_version") !== TOPOLOGY_FORMAT_VERSION) {
        throw corruption(`unsupported ${profile} topology format version`);
      }
      for (const column of ["node_count", "physical_edge_count", "decision_node_count", "decision_edge_count"]) {
        nonNegativeInteger(row, column);
      }
      if (requiredInteger(row, "node_count") !== 0
        || requiredInteger(row, "decision_node_count") !== 0
        || requiredInteger(row, "decision_edge_count") !== 0) {
        throw corruption(`${profile} fallback profile contains primitive topology counts`);
      }
      if (requiredString(row, "built_at") !== this.#manifest.builtAt) {
        throw corruption(`${profile} topology build timestamp does not match the manifest`);
      }
      if (!SHA256_PATTERN.test(requiredString(row, "content_hash"))) {
        throw corruption(`invalid ${profile} topology content hash`);
      }
    }
    for (const profile of PROFILES) {
      if (!seen.has(profile)) throw corruption(`missing ${profile} topology profile`);
    }
    return byProfile;
  }

  #validateAccessTopology(): AccessTopology[] {
    const accessPointRows = this.#database.prepare("SELECT id FROM access_points ORDER BY id").all() as SqliteRow[];
    const accessPointIds = new Set<string>();
    for (const row of accessPointRows) {
      const id = requiredString(row, "id");
      if (accessPointIds.has(id)) throw corruption(`duplicate access point ${id}`);
      accessPointIds.add(id);
    }

    const rows = this.#database.prepare(
      "SELECT * FROM access_topology ORDER BY profile, access_point_id",
    ).all() as SqliteRow[];
    const seen = new Set<string>();
    for (const row of rows) {
      const access = freezeAccessTopology(row);
      if (access.connectorDecisionEdgeIds.length !== 0) {
        throw corruption(`${access.profile} access ${access.accessPointId} contains primitive connector edges`);
      }
      if (!accessPointIds.has(access.accessPointId)) {
        throw corruption(`${access.profile} access topology references unknown access point ${access.accessPointId}`);
      }
      const key = `${access.profile}\u0000${access.accessPointId}`;
      if (seen.has(key)) {
        throw corruption(`duplicate ${access.profile} access topology for ${access.accessPointId}`);
      }
      seen.add(key);
    }

    for (const profile of PROFILES) {
      for (const accessPointId of accessPointIds) {
        if (!seen.has(`${profile}\u0000${accessPointId}`)) {
          throw corruption(`missing ${profile} access topology for ${accessPointId}`);
        }
      }
    }
    return rows.map(freezeAccessTopology);
  }
}
