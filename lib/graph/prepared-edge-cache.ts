import { parseEdge, requiredString, type SqliteRow } from "./sqlite-records";
import type { GraphEdge } from "./types";

const MAXIMUM_ENTRIES = 16_384;
const MAXIMUM_BYTES = 32 * 1024 * 1024;
type Entry = { artifact: string; edge: GraphEdge; bytes: number };

/**
 * Decoded rows belong to one immutable repository and artifact, never just an
 * OSM edge ID. Account conservatively for strings, arrays and sample objects;
 * this bounds retained payload, not a promise about the JS engine's heap size.
 */
export class PreparedEdgeCache {
  readonly #entries = new Map<string, Entry>();
  readonly #maximumBytes: number;
  #bytes = 0;

  constructor(maximumBytes = MAXIMUM_BYTES) { this.#maximumBytes = maximumBytes; }

  /** Internal read-only value: copy before returning it to a graph consumer. */
  read(artifact: string, row: SqliteRow): GraphEdge {
    const key = JSON.stringify([artifact, requiredString(row, "id")]);
    const cached = this.#entries.get(key);
    if (cached) {
      this.#entries.delete(key);
      this.#entries.set(key, cached);
      return cached.edge;
    }
    const edge = parseEdge(row);
    const strings = [key, artifact, edge.id, edge.fromNodeId, edge.toNodeId, edge.trailName ?? "", ...edge.sourceIds, ...edge.flags];
    // The shared row decoder currently accepts untyped JSON metadata arrays.
    // Such a record must not turn byte accounting into NaN or retain an
    // unaccounted nested object; preserve decoder behavior without caching it.
    if (strings.some(value => typeof value !== "string")) return edge;
    const bytes = 512 + strings.reduce((sum, value) => sum + 32 + 2 * value.length, 0)
      + 64 * edge.coordinates.length + 64 * (edge.elevationProfile?.length ?? 0);
    // An unusually detailed corridor can be read without evicting all useful
    // ordinary corridors, or retaining an object larger than the entire budget.
    if (bytes > this.#maximumBytes) return edge;
    while (this.#bytes + bytes > this.#maximumBytes || this.#entries.size >= MAXIMUM_ENTRIES) {
      const oldest = this.#entries.keys().next().value!;
      this.#bytes -= this.#entries.get(oldest)!.bytes;
      this.#entries.delete(oldest);
    }
    this.#entries.set(key, { artifact, edge, bytes });
    this.#bytes += bytes;
    return edge;
  }

  forget(artifact: string): void {
    for (const [key, entry] of this.#entries) {
      if (entry.artifact !== artifact) continue;
      this.#bytes -= entry.bytes;
      this.#entries.delete(key);
    }
  }

  clear(): void { this.#entries.clear(); this.#bytes = 0; }
}
