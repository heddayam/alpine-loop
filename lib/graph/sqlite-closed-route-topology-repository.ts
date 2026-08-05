import { createHash } from "node:crypto";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { packManifestV3Schema, type PackManifestV3, type TopologyProfile } from "@/lib/contracts";
import type {
  AccessTopology,
  ClosedRouteTopologyRepository,
  CycleNetworkSummary,
  DecisionNetwork,
  ReconstructedDirectedEdge,
  TopologyBlock,
  TopologyBlockLink,
  TopologyCacheDiagnostics,
  TopologyDecisionEdge,
  TopologyDecisionEdgeMember,
  TopologyDecisionNode,
} from "./closed-route-topology";
import type { AccessState } from "./types-internal";

type SqliteRow = Record<string, SQLInputValue>;

export type SQLiteClosedRouteTopologyRepositoryOptions = {
  databasePath: string;
  manifest: unknown;
  maximumCacheBytes?: number;
};

const DEFAULT_MAXIMUM_CACHE_BYTES = 64 * 1024 * 1024;
const TOPOLOGY_FORMAT_VERSION = 1;
const PROFILES = ["known", "inclusive"] as const satisfies readonly TopologyProfile[];
const REQUIRED_TABLES = [
  "metadata",
  "nodes",
  "edges",
  "physical_edges",
  "topology_profiles",
  "topology_networks",
  "topology_nodes",
  "topology_decision_edges",
  "topology_decision_edge_members",
  "topology_blocks",
  "topology_block_nodes",
  "topology_block_edges",
  "topology_block_links",
  "access_topology",
] as const;

function corruption(message: string): Error {
  return new Error(`Closed-route topology corruption: ${message}`);
}

function requiredString(row: SqliteRow, column: string): string {
  const value = row[column];
  if (typeof value !== "string" || value.length === 0) throw corruption(`invalid ${column}`);
  return value;
}

function nullableString(row: SqliteRow, column: string): string | null {
  const value = row[column];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw corruption(`invalid ${column}`);
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

function nullableNumber(row: SqliteRow, column: string): number | null {
  const value = row[column];
  return value === null || value === undefined ? null : requiredNumber(row, column);
}

function booleanInteger(row: SqliteRow, column: string): boolean {
  const value = requiredInteger(row, column);
  if (value !== 0 && value !== 1) throw corruption(`invalid boolean ${column}`);
  return value === 1;
}

function parseJson(value: SQLInputValue | undefined, label: string): unknown {
  if (typeof value !== "string") throw corruption(`invalid ${label}`);
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw corruption(`invalid JSON in ${label}`);
  }
}

function stringArray(value: SQLInputValue | undefined, label: string): readonly string[] {
  const parsed = parseJson(value, label);
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
    throw corruption(`invalid string array in ${label}`);
  }
  return Object.freeze([...parsed]);
}

function integerArray(value: SQLInputValue | undefined, label: string): readonly number[] {
  const parsed = parseJson(value, label);
  if (!Array.isArray(parsed) || !parsed.every((item) => Number.isSafeInteger(item))) {
    throw corruption(`invalid integer array in ${label}`);
  }
  return Object.freeze([...parsed]);
}

function coordinates(value: SQLInputValue | undefined): Array<readonly [number, number]> {
  const parsed = parseJson(value, "edge geometry");
  if (
    !Array.isArray(parsed) || parsed.length < 2 ||
    !parsed.every((point) => Array.isArray(point) && point.length >= 2 &&
      typeof point[0] === "number" && Number.isFinite(point[0]) &&
      typeof point[1] === "number" && Number.isFinite(point[1]))
  ) throw corruption("invalid edge geometry");
  return parsed.map((point) => Object.freeze([point[0] as number, point[1] as number] as const));
}

function accessState(value: string): AccessState {
  if (["public", "unknown", "private", "closed", "prohibited"].includes(value)) return value as AccessState;
  throw corruption(`invalid access state ${value}`);
}

function topologyAccessState(value: unknown): "public" | "unknown" {
  if (value === "public" || value === "unknown") return value;
  throw corruption("decision edge has an invalid access state");
}

function metadata(database: DatabaseSync): Map<string, string> {
  const rows = database.prepare("SELECT key, value FROM metadata ORDER BY key").all() as SqliteRow[];
  return new Map(rows.map((row) => [requiredString(row, "key"), requiredString(row, "value")]));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalize(item)]));
  }
  return value;
}

export function canonicalTopologyHash(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex")}`;
}

type PersistedDecisionEdge = {
  decisionEdgeKey: number;
  networkId: number;
  fromDecisionNodeId: number;
  toDecisionNodeId: number;
  lengthM: number;
  gainM: number;
  lossM: number;
  isBridge: boolean;
  twoEdgeComponentId: number;
  vertexBlockId: number | null;
  metricsAndFlags: string;
  members: Array<{ sequenceIndex: number; edgeKey: number; physicalEdgeKey: number }>;
};

type PersistedBlock = {
  blockId: number;
  networkId: number;
  blockKind: string;
  nodeCount: number;
  edgeCount: number;
  cycleRank: number;
  totalPhysicalLengthM: number;
  minimumCycleLengthM: number | null;
  elevationSummary: string;
  trailSummary: string;
  decisionNodeIds: number[];
  decisionEdgeKeys: number[];
};

function persistedProfileHashState(database: DatabaseSync, profile: TopologyProfile) {
  const profileRow = database.prepare("SELECT * FROM topology_profiles WHERE profile = ?").get(profile) as SqliteRow;
  const memberRows = database.prepare(`
    SELECT decision_edge_key, sequence_index, edge_key, physical_edge_key
    FROM topology_decision_edge_members WHERE profile = ?
    ORDER BY decision_edge_key, sequence_index
  `).all(profile) as SqliteRow[];
  const members = new Map<number, PersistedDecisionEdge["members"]>();
  for (const row of memberRows) {
    const id = requiredInteger(row, "decision_edge_key");
    members.set(id, [...(members.get(id) ?? []), {
      sequenceIndex: requiredInteger(row, "sequence_index"),
      edgeKey: requiredInteger(row, "edge_key"),
      physicalEdgeKey: requiredInteger(row, "physical_edge_key"),
    }]);
  }
  const decisionEdges: PersistedDecisionEdge[] = (database.prepare(
    "SELECT * FROM topology_decision_edges WHERE profile = ? ORDER BY decision_edge_key",
  ).all(profile) as SqliteRow[]).map((row) => ({
    decisionEdgeKey: requiredInteger(row, "decision_edge_key"),
    networkId: requiredInteger(row, "network_id"),
    fromDecisionNodeId: requiredInteger(row, "from_decision_node_id"),
    toDecisionNodeId: requiredInteger(row, "to_decision_node_id"),
    lengthM: requiredNumber(row, "length_m"),
    gainM: requiredNumber(row, "gain_m"),
    lossM: requiredNumber(row, "loss_m"),
    isBridge: booleanInteger(row, "is_bridge"),
    twoEdgeComponentId: requiredInteger(row, "two_edge_component_id"),
    vertexBlockId: nullableNumber(row, "vertex_block_id"),
    metricsAndFlags: requiredString(row, "metrics_and_flags"),
    members: members.get(requiredInteger(row, "decision_edge_key")) ?? [],
  }));
  const memberships = (
    table: "topology_block_nodes" | "topology_block_edges",
    column: "decision_node_id" | "decision_edge_key",
  ): Map<number, number[]> => {
    const result = new Map<number, number[]>();
    const rows = database.prepare(
      `SELECT block_id, ${column} FROM ${table} WHERE profile = ? ORDER BY block_id, ${column}`,
    ).all(profile) as SqliteRow[];
    for (const row of rows) {
      const id = requiredInteger(row, "block_id");
      result.set(id, [...(result.get(id) ?? []), requiredInteger(row, column)]);
    }
    return result;
  };
  const blockNodes = memberships("topology_block_nodes", "decision_node_id");
  const blockEdges = memberships("topology_block_edges", "decision_edge_key");
  const blocks: PersistedBlock[] = (database.prepare(
    "SELECT * FROM topology_blocks WHERE profile = ? ORDER BY block_id",
  ).all(profile) as SqliteRow[]).map((row) => {
    const blockId = requiredInteger(row, "block_id");
    return {
      blockId,
      networkId: requiredInteger(row, "network_id"),
      blockKind: requiredString(row, "block_kind"),
      nodeCount: requiredInteger(row, "node_count"),
      edgeCount: requiredInteger(row, "edge_count"),
      cycleRank: requiredInteger(row, "cycle_rank"),
      totalPhysicalLengthM: requiredNumber(row, "total_physical_length_m"),
      minimumCycleLengthM: nullableNumber(row, "minimum_cycle_length_m"),
      elevationSummary: requiredString(row, "elevation_summary"),
      trailSummary: requiredString(row, "trail_summary"),
      decisionNodeIds: blockNodes.get(blockId) ?? [],
      decisionEdgeKeys: blockEdges.get(blockId) ?? [],
    };
  });
  const blockLinks = (database.prepare(`
    SELECT * FROM topology_block_links WHERE profile = ?
    ORDER BY rowid
  `).all(profile) as SqliteRow[]).map((row) => ({
    networkId: requiredInteger(row, "network_id"),
    fromBlockId: requiredInteger(row, "from_block_id"),
    toBlockId: requiredInteger(row, "to_block_id"),
    articulationDecisionNodeId: requiredInteger(row, "articulation_decision_node_id"),
    connectorDistanceM: requiredNumber(row, "connector_distance_m"),
  }));
  const nodes = (database.prepare(
    "SELECT * FROM topology_nodes WHERE profile = ? ORDER BY dense_id",
  ).all(profile) as SqliteRow[]).map((row) => ({
    denseId: requiredInteger(row, "dense_id"),
    sourceNodeId: requiredString(row, "source_node_id"),
    decisionNodeId: nullableNumber(row, "decision_node_id"),
    connectedComponentId: requiredInteger(row, "connected_component_id"),
    directedSccId: requiredInteger(row, "directed_scc_id"),
    twoEdgeComponentId: requiredInteger(row, "two_edge_component_id"),
    isArticulation: booleanInteger(row, "is_articulation"),
    nearestCycleNetworkId: nullableNumber(row, "nearest_cycle_network_id"),
    cyclePortalDecisionNodeId: nullableNumber(row, "cycle_portal_decision_node_id"),
    minimumStemDistanceM: nullableNumber(row, "minimum_stem_distance_m"),
  }));
  const networks = (database.prepare(
    "SELECT * FROM topology_networks WHERE profile = ? ORDER BY network_id",
  ).all(profile) as SqliteRow[]).map((row) => ({
    networkId: requiredInteger(row, "network_id"),
    decisionNodeCount: requiredInteger(row, "decision_node_count"),
    decisionEdgeCount: requiredInteger(row, "decision_edge_count"),
    cycleBlockCount: requiredInteger(row, "cycle_block_count"),
    minimumCycleLengthM: nullableNumber(row, "minimum_cycle_length_m"),
    maximumCycleLengthM: nullableNumber(row, "maximum_cycle_length_m"),
    minimumElevationM: nullableNumber(row, "minimum_elevation_m"),
    maximumElevationM: nullableNumber(row, "maximum_elevation_m"),
  }));
  const accessTopology = (database.prepare(
    "SELECT * FROM access_topology WHERE profile = ? ORDER BY access_point_id",
  ).all(profile) as SqliteRow[]).map((row) => ({
    accessPointId: requiredString(row, "access_point_id"),
    attachmentDecisionNodeId: requiredInteger(row, "attachment_decision_node_id"),
    cycleNetworkId: nullableNumber(row, "cycle_network_id"),
    connectorKey: nullableString(row, "connector_key"),
    connectorDecisionEdgeIds: [...integerArray(row.connector_decision_edge_ids, "connector decision edge IDs")],
    portalDecisionNodeId: nullableNumber(row, "portal_decision_node_id"),
    minimumStemDistanceM: nullableNumber(row, "minimum_stem_distance_m"),
    canReachCycle: booleanInteger(row, "can_reach_cycle"),
  }));
  return {
    profileHashInput: {
      profile,
      formatVersion: requiredInteger(profileRow, "format_version"),
      nodeCount: requiredInteger(profileRow, "node_count"),
      physicalEdgeCount: requiredInteger(profileRow, "physical_edge_count"),
      decisionNodeCount: requiredInteger(profileRow, "decision_node_count"),
      decisionEdgeCount: requiredInteger(profileRow, "decision_edge_count"),
      nodes,
      decisionEdges,
      blocks,
      blockLinks,
      networks,
      accessTopology,
    },
    networkHashInputs: networks.map(({ networkId }) => ({
      networkId,
      input: {
        networkId,
        decisionNodeIds: [...new Set(decisionEdges.filter((edge) => edge.networkId === networkId)
          .flatMap((edge) => [edge.fromDecisionNodeId, edge.toDecisionNodeId]))].sort((a, b) => a - b),
        decisionEdges: decisionEdges.filter((edge) => edge.networkId === networkId),
        blocks: blocks.filter((block) => block.networkId === networkId),
        blockLinks: blockLinks.filter((link) => link.networkId === networkId),
      },
    })),
  };
}

/** Computes semantic hashes from persisted rows; useful to pack audits and deterministic fixtures. */
export function computePersistedTopologyHashes(
  database: DatabaseSync,
  algorithmVersion: string,
  policyVersion: string,
): {
  profiles: Array<{ profile: TopologyProfile; contentHash: string }>;
  networks: Array<{ profile: TopologyProfile; networkId: number; contentHash: string }>;
  contentHash: string;
} {
  const profiles: Array<{ profile: TopologyProfile; contentHash: string }> = [];
  const networks: Array<{ profile: TopologyProfile; networkId: number; contentHash: string }> = [];
  for (const profile of PROFILES) {
    const state = persistedProfileHashState(database, profile);
    profiles.push({ profile, contentHash: canonicalTopologyHash(state.profileHashInput) });
    networks.push(...state.networkHashInputs.map(({ networkId, input }) => ({
      profile, networkId, contentHash: canonicalTopologyHash(input),
    })));
  }
  return {
    profiles,
    networks,
    contentHash: canonicalTopologyHash({ algorithmVersion, policyVersion, profiles }),
  };
}

function freezeRecord<T extends object>(value: T): Readonly<T> {
  return Object.freeze(value);
}

class ImmutableMap<K, V> implements ReadonlyMap<K, V> {
  readonly #values: Map<K, V>;

  constructor(entries: Iterable<readonly [K, V]>) {
    this.#values = new Map(entries);
    Object.freeze(this);
  }

  get size(): number { return this.#values.size; }
  get(key: K): V | undefined { return this.#values.get(key); }
  has(key: K): boolean { return this.#values.has(key); }
  entries(): MapIterator<[K, V]> { return this.#values.entries(); }
  keys(): MapIterator<K> { return this.#values.keys(); }
  values(): MapIterator<V> { return this.#values.values(); }
  forEach(callbackfn: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown): void {
    for (const [key, value] of this.#values) callbackfn.call(thisArg, value, key, this);
  }
  [Symbol.iterator](): MapIterator<[K, V]> { return this.#values[Symbol.iterator](); }
}

type CachedNetwork = { network: DecisionNetwork; byteSize: number };

export class SQLiteClosedRouteTopologyRepository implements ClosedRouteTopologyRepository {
  readonly packId: string;
  readonly dataVersion: string;
  readonly #manifest: PackManifestV3;
  readonly #database: DatabaseSync;
  readonly #maximumCacheBytes: number;
  readonly #cache = new Map<string, CachedNetwork>();
  readonly #inFlight = new Map<string, Promise<DecisionNetwork>>();
  #closed = false;
  #generation = 0;
  #diagnostics: TopologyCacheDiagnostics = {
    hits: 0,
    misses: 0,
    concurrentLoadJoins: 0,
    loads: 0,
    loadedBytes: 0,
    residentBytes: 0,
    evictions: 0,
  };

  constructor(options: SQLiteClosedRouteTopologyRepositoryOptions) {
    this.#manifest = packManifestV3Schema.parse(options.manifest);
    this.packId = this.#manifest.id;
    this.dataVersion = this.#manifest.dataVersion;
    this.#maximumCacheBytes = options.maximumCacheBytes ?? DEFAULT_MAXIMUM_CACHE_BYTES;
    if (!Number.isSafeInteger(this.#maximumCacheBytes) || this.#maximumCacheBytes < 0) {
      throw new Error("maximumCacheBytes must be a non-negative safe integer");
    }
    this.#database = new DatabaseSync(options.databasePath, { readOnly: true });
    try {
      this.#validatePack();
    } catch (error) {
      this.#database.close();
      this.#closed = true;
      throw error;
    }
  }

  async getAccessTopology(
    profile: TopologyProfile,
    accessPointIds: readonly string[],
  ): Promise<AccessTopology[]> {
    this.#assertOpen();
    this.#assertProfile(profile);
    if (accessPointIds.length === 0) return [];
    const result: AccessTopology[] = [];
    const statement = this.#database.prepare(`
      SELECT * FROM access_topology WHERE profile = ? AND access_point_id = ?
    `);
    for (const accessPointId of accessPointIds) {
      const row = statement.get(profile, accessPointId) as SqliteRow | undefined;
      if (!row) continue;
      result.push(this.#parseAccessTopology(row));
    }
    return result;
  }

  async getNetworkSummary(profile: TopologyProfile, networkId: number): Promise<CycleNetworkSummary> {
    this.#assertOpen();
    this.#assertProfile(profile);
    if (!Number.isSafeInteger(networkId) || networkId < 0) throw new Error("networkId must be a non-negative integer");
    const row = this.#database.prepare(
      "SELECT * FROM topology_networks WHERE profile = ? AND network_id = ?",
    ).get(profile, networkId) as SqliteRow | undefined;
    if (!row) throw new Error(`Topology network ${profile}/${networkId} does not exist`);
    return freezeRecord({
      profile,
      networkId,
      decisionNodeCount: requiredInteger(row, "decision_node_count"),
      decisionEdgeCount: requiredInteger(row, "decision_edge_count"),
      cycleBlockCount: requiredInteger(row, "cycle_block_count"),
      minimumCycleLengthMeters: nullableNumber(row, "minimum_cycle_length_m"),
      maximumCycleLengthMeters: nullableNumber(row, "maximum_cycle_length_m"),
      minimumElevationMeters: nullableNumber(row, "minimum_elevation_m"),
      maximumElevationMeters: nullableNumber(row, "maximum_elevation_m"),
    });
  }

  async loadDecisionNetwork(profile: TopologyProfile, networkId: number): Promise<DecisionNetwork> {
    this.#assertOpen();
    this.#assertProfile(profile);
    if (!Number.isSafeInteger(networkId) || networkId < 0) throw new Error("networkId must be a non-negative integer");
    const key = this.#cacheKey(profile, networkId);
    const cached = this.#cache.get(key);
    if (cached) {
      this.#diagnostics.hits += 1;
      this.#cache.delete(key);
      this.#cache.set(key, cached);
      return cached.network;
    }
    const pending = this.#inFlight.get(key);
    if (pending) {
      this.#diagnostics.concurrentLoadJoins += 1;
      return pending;
    }
    this.#diagnostics.misses += 1;
    const generation = this.#generation;
    const load = Promise.resolve().then(() => {
      this.#assertOpen();
      const network = this.#loadNetwork(profile, networkId);
      this.#diagnostics.loads += 1;
      this.#diagnostics.loadedBytes += network.estimatedByteSize;
      if (generation === this.#generation) this.#retain(key, network);
      return network;
    }).finally(() => {
      if (this.#inFlight.get(key) === load) this.#inFlight.delete(key);
    });
    this.#inFlight.set(key, load);
    return load;
  }

  async reconstructDirectedEdges(compressedEdgeIds: readonly number[]): Promise<ReconstructedDirectedEdge[]> {
    this.#assertOpen();
    const memberStatement = this.#database.prepare(`
      SELECT m.profile, m.sequence_index, m.edge_key, m.physical_edge_key,
             e.*, p.stable_physical_id
      FROM topology_decision_edge_members m
      JOIN edges e ON e.edge_key = m.edge_key
      JOIN physical_edges p ON p.physical_edge_key = m.physical_edge_key
      WHERE m.decision_edge_key = ?
      ORDER BY m.profile, m.sequence_index
    `);
    const result: ReconstructedDirectedEdge[] = [];
    for (const compressedEdgeId of compressedEdgeIds) {
      if (!Number.isSafeInteger(compressedEdgeId) || compressedEdgeId < 0) {
        throw new Error("compressed edge IDs must be non-negative integers");
      }
      const rows = memberStatement.all(compressedEdgeId) as SqliteRow[];
      if (rows.length === 0) throw corruption(`decision edge ${compressedEdgeId} has no reconstruction members`);
      const profiles = new Set(rows.map((row) => requiredString(row, "profile")));
      if (profiles.size !== 1) throw corruption(`decision edge key ${compressedEdgeId} is not globally unique`);
      rows.forEach((row, sequenceIndex) => {
        if (requiredInteger(row, "sequence_index") !== sequenceIndex) {
          throw corruption(`decision edge ${compressedEdgeId} has a non-contiguous member sequence`);
        }
        const flags = stringArray(row.flags, "edge flags");
        const encodedTrailName = flags.find((flag) => flag.startsWith("trail-name:"))?.slice("trail-name:".length);
        const physicalEdgeKey = requiredInteger(row, "physical_edge_key");
        result.push(freezeRecord({
          edgeKey: requiredInteger(row, "edge_key"),
          physicalEdgeKey,
          stablePhysicalEdgeId: requiredString(row, "stable_physical_id"),
          id: requiredString(row, "id"),
          fromNodeId: requiredString(row, "from_node"),
          toNodeId: requiredString(row, "to_node"),
          coordinates: coordinates(row.geometry),
          lengthMeters: requiredNumber(row, "length_m"),
          gainMeters: nullableNumber(row, "gain_m") ?? 0,
          lossMeters: nullableNumber(row, "loss_m") ?? 0,
          maximumElevationMeters: nullableNumber(row, "max_elevation_m"),
          maximumSustainedGradePct: nullableNumber(row, "max_sustained_grade_pct"),
          accessState: accessState(requiredString(row, "access_state")),
          trailName: typeof row.trail_name === "string" && row.trail_name.length > 0
            ? row.trail_name
            : encodedTrailName || null,
          sourceIds: [...stringArray(row.source_refs, "edge source_refs")],
          flags: [...flags],
        }));
      });
    }
    return result;
  }

  getCacheDiagnostics(): TopologyCacheDiagnostics {
    return freezeRecord({ ...this.#diagnostics });
  }

  invalidate(): void {
    this.#generation += 1;
    this.#cache.clear();
    this.#inFlight.clear();
    this.#diagnostics.residentBytes = 0;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.invalidate();
    this.#closed = true;
    this.#database.close();
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("Closed-route topology repository is closed");
  }

  #assertProfile(profile: TopologyProfile): void {
    if (!PROFILES.includes(profile)) throw new Error(`Unsupported topology profile ${profile}`);
  }

  #cacheKey(profile: TopologyProfile, networkId: number): string {
    return `${this.dataVersion}\u0000${profile}\u0000${networkId}`;
  }

  #retain(key: string, network: DecisionNetwork): void {
    if (network.estimatedByteSize > this.#maximumCacheBytes) return;
    while (this.#diagnostics.residentBytes + network.estimatedByteSize > this.#maximumCacheBytes) {
      const oldest = this.#cache.entries().next().value as [string, CachedNetwork] | undefined;
      if (!oldest) break;
      this.#cache.delete(oldest[0]);
      this.#diagnostics.residentBytes -= oldest[1].byteSize;
      this.#diagnostics.evictions += 1;
    }
    this.#cache.set(key, { network, byteSize: network.estimatedByteSize });
    this.#diagnostics.residentBytes += network.estimatedByteSize;
  }

  #validatePack(): void {
    const tableRows = this.#database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    ).all() as SqliteRow[];
    const tables = new Set(tableRows.map((row) => requiredString(row, "name")));
    for (const table of REQUIRED_TABLES) if (!tables.has(table)) throw corruption(`missing table ${table}`);

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

    const profileRows = this.#database.prepare("SELECT * FROM topology_profiles ORDER BY profile").all() as SqliteRow[];
    if (profileRows.length !== PROFILES.length) throw corruption("topology profile count mismatch");
    for (const profile of PROFILES) {
      const row = profileRows.find((candidate) => candidate.profile === profile);
      if (!row) throw corruption(`missing ${profile} topology profile`);
      if (requiredInteger(row, "format_version") !== TOPOLOGY_FORMAT_VERSION) {
        throw corruption(`unsupported ${profile} topology format version`);
      }
      if (requiredString(row, "built_at") !== this.#manifest.builtAt) {
        throw corruption(`${profile} topology build timestamp does not match the manifest`);
      }
      this.#validateProfileCounts(profile, row);
      this.#validateProfileMembers(profile);
      this.#validateAccessTopology(profile);
    }
    this.#validateGlobalDecisionEdgeKeys();
    this.#validateContentHashes(values);
  }

  #validateProfileCounts(profile: TopologyProfile, profileRow: SqliteRow): void {
    const count = (sql: string): number => {
      const row = this.#database.prepare(sql).get(profile) as SqliteRow;
      return requiredInteger(row, "count");
    };
    const expected = {
      node_count: count("SELECT COUNT(*) AS count FROM topology_nodes WHERE profile = ?"),
      physical_edge_count: count("SELECT COUNT(DISTINCT physical_edge_key) AS count FROM topology_decision_edge_members WHERE profile = ?"),
      decision_node_count: count("SELECT COUNT(*) AS count FROM topology_nodes WHERE profile = ? AND decision_node_id IS NOT NULL"),
      decision_edge_count: count("SELECT COUNT(*) AS count FROM topology_decision_edges WHERE profile = ?"),
    };
    for (const [column, actual] of Object.entries(expected)) {
      if (requiredInteger(profileRow, column) !== actual) throw corruption(`${profile} ${column} mismatch`);
    }

    const networkRows = this.#database.prepare("SELECT * FROM topology_networks WHERE profile = ? ORDER BY network_id")
      .all(profile) as SqliteRow[];
    for (const network of networkRows) {
      const networkId = requiredInteger(network, "network_id");
      const parameters = [profile, networkId] as const;
      const networkCount = (sql: string): number => requiredInteger(
        this.#database.prepare(sql).get(...parameters) as SqliteRow,
        "count",
      );
      const nodeCount = requiredInteger(this.#database.prepare(`
        SELECT COUNT(*) AS count FROM (
          SELECT from_decision_node_id AS id FROM topology_decision_edges WHERE profile = ? AND network_id = ?
          UNION
          SELECT to_decision_node_id AS id FROM topology_decision_edges WHERE profile = ? AND network_id = ?
        )
      `).get(profile, networkId, profile, networkId) as SqliteRow, "count");
      const networkExpected = {
        decision_node_count: nodeCount,
        decision_edge_count: networkCount(
          "SELECT COUNT(*) AS count FROM topology_decision_edges WHERE profile = ? AND network_id = ?",
        ),
        cycle_block_count: networkCount(
          "SELECT COUNT(*) AS count FROM topology_blocks WHERE profile = ? AND network_id = ? AND block_kind = 'vertex-cycle'",
        ),
      };
      for (const [column, actual] of Object.entries(networkExpected)) {
        if (requiredInteger(network, column) !== actual) {
          throw corruption(`${profile} network ${networkId} ${column} mismatch`);
        }
      }
    }
  }

  #validateContentHashes(values: Map<string, string>): void {
    const expected = computePersistedTopologyHashes(
      this.#database,
      this.#manifest.closedRouteTopology.algorithmVersion,
      this.#manifest.closedRouteTopology.policyVersion,
    );
    const profileStatement = this.#database.prepare(
      "SELECT content_hash FROM topology_profiles WHERE profile = ?",
    );
    for (const profile of expected.profiles) {
      const row = profileStatement.get(profile.profile) as SqliteRow;
      if (requiredString(row, "content_hash") !== profile.contentHash) {
        throw corruption(`${profile.profile} profile content hash mismatch`);
      }
    }
    const networkStatement = this.#database.prepare(
      "SELECT content_hash FROM topology_networks WHERE profile = ? AND network_id = ?",
    );
    for (const network of expected.networks) {
      const row = networkStatement.get(network.profile, network.networkId) as SqliteRow;
      if (requiredString(row, "content_hash") !== network.contentHash) {
        throw corruption(`${network.profile} network ${network.networkId} content hash mismatch`);
      }
    }
    if (values.get("topologyContentHash") !== expected.contentHash) {
      throw corruption("combined topology content hash mismatch");
    }
  }

  #validateProfileMembers(profile: TopologyProfile): void {
    const missing = this.#database.prepare(`
      SELECT COUNT(*) AS count
      FROM topology_decision_edge_members m
      LEFT JOIN topology_decision_edges d
        ON d.profile = m.profile AND d.decision_edge_key = m.decision_edge_key
      LEFT JOIN edges e ON e.edge_key = m.edge_key
      LEFT JOIN physical_edges p ON p.physical_edge_key = m.physical_edge_key
      WHERE m.profile = ? AND (
        d.decision_edge_key IS NULL OR e.edge_key IS NULL OR p.physical_edge_key IS NULL OR
        e.physical_edge_key != m.physical_edge_key
      )
    `).get(profile) as SqliteRow;
    if (requiredInteger(missing, "count") !== 0) throw corruption(`${profile} has dangling reconstruction members`);

    const decisionEdges = this.#database.prepare(
      "SELECT * FROM topology_decision_edges WHERE profile = ? ORDER BY decision_edge_key",
    ).all(profile) as SqliteRow[];
    const memberStatement = this.#database.prepare(`
      SELECT m.sequence_index, m.edge_key, m.physical_edge_key,
             e.from_node, e.to_node, e.length_m, e.gain_m, e.loss_m, e.access_state
      FROM topology_decision_edge_members m
      JOIN edges e ON e.edge_key = m.edge_key
      WHERE m.profile = ? AND m.decision_edge_key = ?
      ORDER BY m.sequence_index
    `);
    const sourceNodeStatement = this.#database.prepare(`
      SELECT source_node_id FROM topology_nodes
      WHERE profile = ? AND decision_node_id = ?
    `);
    for (const edge of decisionEdges) {
      const edgeId = requiredInteger(edge, "decision_edge_key");
      const members = memberStatement.all(profile, edgeId) as SqliteRow[];
      if (members.length === 0) throw corruption(`${profile} decision edge ${edgeId} has no members`);
      members.forEach((member, index) => {
        if (requiredInteger(member, "sequence_index") !== index) {
          throw corruption(`${profile} decision edge ${edgeId} member sequence is not contiguous`);
        }
        if (profile === "known" && requiredString(member, "access_state") !== "public") {
          throw corruption(`known decision edge ${edgeId} contains a non-public member`);
        }
        if (profile === "inclusive" && !["public", "unknown"].includes(requiredString(member, "access_state"))) {
          throw corruption(`inclusive decision edge ${edgeId} contains a prohibited member`);
        }
        if (index > 0 && requiredString(members[index - 1]!, "to_node") !== requiredString(member, "from_node")) {
          throw corruption(`${profile} decision edge ${edgeId} member continuity failure`);
        }
      });
      const fromNode = sourceNodeStatement.get(profile, requiredInteger(edge, "from_decision_node_id")) as SqliteRow | undefined;
      const toNode = sourceNodeStatement.get(profile, requiredInteger(edge, "to_decision_node_id")) as SqliteRow | undefined;
      if (!fromNode || !toNode) throw corruption(`${profile} decision edge ${edgeId} references an unknown decision node`);
      if (requiredString(members[0]!, "from_node") !== requiredString(fromNode, "source_node_id") ||
          requiredString(members.at(-1)!, "to_node") !== requiredString(toNode, "source_node_id")) {
        throw corruption(`${profile} decision edge ${edgeId} endpoint reconstruction failure`);
      }
      const totals = members.reduce<{ length: number; gain: number; loss: number }>((sum, member) => ({
        length: sum.length + requiredNumber(member, "length_m"),
        gain: sum.gain + (nullableNumber(member, "gain_m") ?? 0),
        loss: sum.loss + (nullableNumber(member, "loss_m") ?? 0),
      }), { length: 0, gain: 0, loss: 0 });
      const close = (left: number, right: number): boolean => Math.abs(left - right) <= 1e-6 * Math.max(1, left, right);
      if (!close(totals.length, requiredNumber(edge, "length_m")) ||
          !close(totals.gain, requiredNumber(edge, "gain_m")) ||
          !close(totals.loss, requiredNumber(edge, "loss_m"))) {
        throw corruption(`${profile} decision edge ${edgeId} aggregate length or elevation mismatch`);
      }
    }

    const badBlockMembers = this.#database.prepare(`
      SELECT COUNT(*) AS count FROM (
        SELECT bn.block_id FROM topology_block_nodes bn
        LEFT JOIN topology_blocks b ON b.profile = bn.profile AND b.block_id = bn.block_id
        LEFT JOIN topology_nodes n
          ON n.profile = bn.profile AND n.decision_node_id = bn.decision_node_id
        WHERE bn.profile = ? AND (b.block_id IS NULL OR n.decision_node_id IS NULL)
        UNION ALL
        SELECT be.block_id FROM topology_block_edges be
        LEFT JOIN topology_blocks b ON b.profile = be.profile AND b.block_id = be.block_id
        LEFT JOIN topology_decision_edges d
          ON d.profile = be.profile AND d.decision_edge_key = be.decision_edge_key
        WHERE be.profile = ? AND (b.block_id IS NULL OR d.decision_edge_key IS NULL)
      )
    `).get(profile, profile) as SqliteRow;
    if (requiredInteger(badBlockMembers, "count") !== 0) throw corruption(`${profile} has dangling block members`);
  }

  #validateAccessTopology(profile: TopologyProfile): void {
    const rows = this.#database.prepare("SELECT * FROM access_topology WHERE profile = ? ORDER BY access_point_id")
      .all(profile) as SqliteRow[];
    const accessPointCount = requiredInteger(
      this.#database.prepare("SELECT COUNT(*) AS count FROM access_points").get() as SqliteRow,
      "count",
    );
    if (rows.length !== accessPointCount) throw corruption(`${profile} access topology count mismatch`);
    const decisionEdge = this.#database.prepare(
      "SELECT network_id FROM topology_decision_edges WHERE profile = ? AND decision_edge_key = ?",
    );
    const decisionNode = this.#database.prepare(
      "SELECT 1 AS present FROM topology_nodes WHERE profile = ? AND decision_node_id = ?",
    );
    const network = this.#database.prepare(
      "SELECT 1 AS present FROM topology_networks WHERE profile = ? AND network_id = ?",
    );
    const attachedSourceNode = this.#database.prepare(`
      SELECT n.source_node_id
      FROM access_points a
      JOIN topology_nodes n ON n.profile = ? AND n.source_node_id = a.node_id
      WHERE a.id = ? AND n.decision_node_id = ?
    `);
    for (const row of rows) {
      const canReachCycle = booleanInteger(row, "can_reach_cycle");
      const networkId = nullableNumber(row, "cycle_network_id");
      const connectorIds = integerArray(row.connector_decision_edge_ids, "connector decision edge IDs");
      const accessPointId = requiredString(row, "access_point_id");
      if (canReachCycle !== (networkId !== null)) {
        throw corruption(`${profile} access ${accessPointId} has inconsistent cycle reachability`);
      }
      if (!decisionNode.get(profile, requiredInteger(row, "attachment_decision_node_id"))) {
        throw corruption(`${profile} access ${accessPointId} has an unknown attachment node`);
      }
      if (!attachedSourceNode.get(profile, accessPointId, requiredInteger(row, "attachment_decision_node_id"))) {
        throw corruption(`${profile} access ${accessPointId} attachment does not match its source node`);
      }
      const connectorKey = nullableString(row, "connector_key");
      const portalId = nullableNumber(row, "portal_decision_node_id");
      const stemDistance = nullableNumber(row, "minimum_stem_distance_m");
      if (!canReachCycle && (connectorKey !== null || portalId !== null || stemDistance !== null || connectorIds.length !== 0)) {
        throw corruption(`${profile} access ${accessPointId} has stale unreachable connector data`);
      }
      if (canReachCycle && (connectorKey === null || portalId === null || stemDistance === null ||
          !network.get(profile, networkId!) || !decisionNode.get(profile, portalId))) {
        throw corruption(`${profile} access ${accessPointId} has incomplete reachable connector data`);
      }
      for (const edgeId of connectorIds) {
        const edge = decisionEdge.get(profile, edgeId) as SqliteRow | undefined;
        if (!edge) throw corruption(`${profile} access connector references unknown decision edge ${edgeId}`);
        if (networkId !== null && requiredInteger(edge, "network_id") !== networkId) {
          throw corruption(`${profile} access connector edge ${edgeId} belongs to another network`);
        }
      }
    }
  }

  #validateGlobalDecisionEdgeKeys(): void {
    const row = this.#database.prepare(`
      SELECT COUNT(*) AS count FROM (
        SELECT decision_edge_key FROM topology_decision_edges
        GROUP BY decision_edge_key HAVING COUNT(*) > 1
      )
    `).get() as SqliteRow;
    if (requiredInteger(row, "count") !== 0) throw corruption("decision edge keys are not globally unique");
  }

  #parseAccessTopology(row: SqliteRow): AccessTopology {
    const profile = requiredString(row, "profile") as TopologyProfile;
    this.#assertProfile(profile);
    return freezeRecord({
      profile,
      accessPointId: requiredString(row, "access_point_id"),
      attachmentDecisionNodeId: requiredInteger(row, "attachment_decision_node_id"),
      cycleNetworkId: nullableNumber(row, "cycle_network_id"),
      connectorKey: nullableString(row, "connector_key"),
      connectorDecisionEdgeIds: integerArray(row.connector_decision_edge_ids, "connector decision edge IDs"),
      portalDecisionNodeId: nullableNumber(row, "portal_decision_node_id"),
      minimumStemDistanceMeters: nullableNumber(row, "minimum_stem_distance_m"),
      canReachCycle: booleanInteger(row, "can_reach_cycle"),
    });
  }

  #loadNetwork(profile: TopologyProfile, networkId: number): DecisionNetwork {
    const summaryRow = this.#database.prepare(
      "SELECT * FROM topology_networks WHERE profile = ? AND network_id = ?",
    ).get(profile, networkId) as SqliteRow | undefined;
    if (!summaryRow) throw new Error(`Topology network ${profile}/${networkId} does not exist`);

    const blockNodeRows = this.#database.prepare(`
      SELECT bn.decision_node_id, bn.block_id
      FROM topology_block_nodes bn
      JOIN topology_blocks b ON b.profile = bn.profile AND b.block_id = bn.block_id
      WHERE bn.profile = ? AND b.network_id = ?
      ORDER BY bn.decision_node_id, bn.block_id
    `).all(profile, networkId) as SqliteRow[];
    const blockIdsByNode = new Map<number, number[]>();
    for (const row of blockNodeRows) {
      const nodeId = requiredInteger(row, "decision_node_id");
      blockIdsByNode.set(nodeId, [...(blockIdsByNode.get(nodeId) ?? []), requiredInteger(row, "block_id")]);
    }

    const nodeRows = this.#database.prepare(`
      SELECT n.decision_node_id, n.source_node_id, n.connected_component_id,
             n.two_edge_component_id, n.is_articulation
      FROM topology_nodes n
      WHERE n.profile = ? AND n.decision_node_id IN (
        SELECT from_decision_node_id FROM topology_decision_edges WHERE profile = ? AND network_id = ?
        UNION
        SELECT to_decision_node_id FROM topology_decision_edges WHERE profile = ? AND network_id = ?
      )
      ORDER BY n.decision_node_id
    `).all(profile, profile, networkId, profile, networkId) as SqliteRow[];
    const nodes = nodeRows.map((row): readonly [number, TopologyDecisionNode] => {
      const id = requiredInteger(row, "decision_node_id");
      return [id, freezeRecord({
        id,
        sourceNodeId: requiredString(row, "source_node_id"),
        connectedComponentId: requiredInteger(row, "connected_component_id"),
        twoEdgeComponentId: requiredInteger(row, "two_edge_component_id"),
        isArticulation: booleanInteger(row, "is_articulation"),
        vertexBlockIds: Object.freeze([...(blockIdsByNode.get(id) ?? [])]),
      })];
    });

    const membersByEdge = new Map<number, readonly TopologyDecisionEdgeMember[]>();
    const memberRows = this.#database.prepare(`
      SELECT m.decision_edge_key, m.sequence_index, m.edge_key, m.physical_edge_key
      FROM topology_decision_edge_members m
      JOIN topology_decision_edges d
        ON d.profile = m.profile AND d.decision_edge_key = m.decision_edge_key
      WHERE m.profile = ? AND d.network_id = ?
      ORDER BY m.decision_edge_key, m.sequence_index
    `).all(profile, networkId) as SqliteRow[];
    for (const row of memberRows) {
      const edgeId = requiredInteger(row, "decision_edge_key");
      const members = [...(membersByEdge.get(edgeId) ?? []), freezeRecord({
        sequenceIndex: requiredInteger(row, "sequence_index"),
        edgeKey: requiredInteger(row, "edge_key"),
        physicalEdgeKey: requiredInteger(row, "physical_edge_key"),
      })];
      membersByEdge.set(edgeId, Object.freeze(members));
    }

    const edgeRows = this.#database.prepare(`
      SELECT * FROM topology_decision_edges
      WHERE profile = ? AND network_id = ? ORDER BY decision_edge_key
    `).all(profile, networkId) as SqliteRow[];
    const edges = edgeRows.map((row): TopologyDecisionEdge => {
      const id = requiredInteger(row, "decision_edge_key");
      const metrics = parseJson(row.metrics_and_flags, "decision edge metrics");
      if (!metrics || typeof metrics !== "object" || Array.isArray(metrics)) {
        throw corruption(`${profile} decision edge ${id} has invalid metrics`);
      }
      const values = metrics as Record<string, unknown>;
      const optionalMetric = (key: string): number | null => {
        const value = values[key];
        if (value === null || value === undefined) return null;
        if (typeof value !== "number" || !Number.isFinite(value)) throw corruption(`invalid decision edge ${key}`);
        return value;
      };
      const metricStrings = (key: string): readonly string[] => {
        const value = values[key];
        if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
          throw corruption(`invalid decision edge ${key}`);
        }
        return Object.freeze([...value]);
      };
      return freezeRecord({
        id,
        fromDecisionNodeId: requiredInteger(row, "from_decision_node_id"),
        toDecisionNodeId: requiredInteger(row, "to_decision_node_id"),
        lengthMeters: requiredNumber(row, "length_m"),
        gainMeters: requiredNumber(row, "gain_m"),
        lossMeters: requiredNumber(row, "loss_m"),
        maximumElevationMeters: optionalMetric("maximumElevationMeters"),
        maximumSustainedGradePct: optionalMetric("maximumSustainedGradePct"),
        accessState: topologyAccessState(values.accessState),
        trailNames: metricStrings("trailNames"),
        sourceIds: metricStrings("sourceIds"),
        flags: metricStrings("flags"),
        isBridge: booleanInteger(row, "is_bridge"),
        twoEdgeComponentId: requiredInteger(row, "two_edge_component_id"),
        vertexBlockId: nullableNumber(row, "vertex_block_id"),
        members: membersByEdge.get(id) ?? Object.freeze([]),
      });
    });

    const blockNodes = this.#groupMembership("topology_block_nodes", "decision_node_id", profile, networkId);
    const blockEdges = this.#groupMembership("topology_block_edges", "decision_edge_key", profile, networkId);
    const blockRows = this.#database.prepare(
      "SELECT * FROM topology_blocks WHERE profile = ? AND network_id = ? ORDER BY block_id",
    ).all(profile, networkId) as SqliteRow[];
    const blocks = blockRows.map((row): TopologyBlock => {
      const id = requiredInteger(row, "block_id");
      const kind = requiredString(row, "block_kind");
      if (kind !== "vertex-cycle" && kind !== "bridge") throw corruption(`invalid topology block kind ${kind}`);
      const elevation = parseJson(row.elevation_summary, "block elevation summary");
      const trails = parseJson(row.trail_summary, "block trail summary");
      if (!elevation || typeof elevation !== "object" || Array.isArray(elevation)) {
        throw corruption(`block ${id} has invalid elevation summary`);
      }
      const elevationValues = elevation as Record<string, unknown>;
      const elevationValue = (key: string): number | null => {
        const value = elevationValues[key];
        if (value === null || value === undefined) return null;
        if (typeof value !== "number" || !Number.isFinite(value)) throw corruption(`block ${id} has invalid ${key}`);
        return value;
      };
      if (!Array.isArray(trails) || !trails.every((item) => typeof item === "string")) {
        throw corruption(`block ${id} has invalid trail summary`);
      }
      const decisionNodeIds = blockNodes.get(id) ?? Object.freeze([]);
      const decisionEdgeIds = blockEdges.get(id) ?? Object.freeze([]);
      return freezeRecord({
        id,
        kind,
        decisionNodeIds,
        decisionEdgeIds,
        cycleRank: requiredInteger(row, "cycle_rank"),
        totalPhysicalLengthMeters: requiredNumber(row, "total_physical_length_m"),
        minimumCycleLengthMeters: nullableNumber(row, "minimum_cycle_length_m"),
        minimumElevationMeters: elevationValue("minimumElevationMeters"),
        maximumElevationMeters: elevationValue("maximumElevationMeters"),
        trailNames: Object.freeze([...trails]),
      });
    });

    const linkRows = this.#database.prepare(`
      SELECT * FROM topology_block_links
      WHERE profile = ? AND network_id = ?
      ORDER BY from_block_id, to_block_id, articulation_decision_node_id
    `).all(profile, networkId) as SqliteRow[];
    const blockLinks = linkRows.map((row): TopologyBlockLink => freezeRecord({
      fromBlockId: requiredInteger(row, "from_block_id"),
      toBlockId: requiredInteger(row, "to_block_id"),
      articulationDecisionNodeId: requiredInteger(row, "articulation_decision_node_id"),
      connectorDistanceMeters: requiredNumber(row, "connector_distance_m"),
    }));

    const contentHash = requiredString(summaryRow, "content_hash");
    const measured = Buffer.byteLength(JSON.stringify({
      profile,
      networkId,
      nodes: nodes.map(([, node]) => node),
      edges,
      blocks,
      blockLinks,
      contentHash,
    }), "utf8");
    return freezeRecord({
      profile,
      networkId,
      nodes: new ImmutableMap(nodes),
      edges: Object.freeze(edges),
      blocks: Object.freeze(blocks),
      blockLinks: Object.freeze(blockLinks),
      estimatedByteSize: measured,
      contentHash,
    });
  }

  #groupMembership(
    table: "topology_block_nodes" | "topology_block_edges",
    column: "decision_node_id" | "decision_edge_key",
    profile: TopologyProfile,
    networkId: number,
  ): Map<number, readonly number[]> {
    const rows = this.#database.prepare(`
      SELECT m.block_id, m.${column}
      FROM ${table} m
      JOIN topology_blocks b ON b.profile = m.profile AND b.block_id = m.block_id
      WHERE m.profile = ? AND b.network_id = ?
      ORDER BY m.block_id, m.${column}
    `).all(profile, networkId) as SqliteRow[];
    const result = new Map<number, readonly number[]>();
    for (const row of rows) {
      const blockId = requiredInteger(row, "block_id");
      result.set(blockId, Object.freeze([...(result.get(blockId) ?? []), requiredInteger(row, column)]));
    }
    return result;
  }
}
