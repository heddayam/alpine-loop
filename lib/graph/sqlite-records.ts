import type { SQLInputValue } from "node:sqlite";
import type { AccessState, GraphAccessPoint, GraphEdge, EdgeClass, GraphNode } from "./types";
export type SqliteRow = Record<string, SQLInputValue>;

export type MapTrailEdge = Pick<GraphEdge, "id" | "physicalEdgeKey" | "coordinates" | "lengthMeters" | "trailName" | "accessState" | "sourceIds" | "edgeClass" | "flags">;

export function requiredString(row: SqliteRow, column: string): string {
  const value = row[column];
  if (typeof value !== "string" || value.length === 0) throw new Error(`Graph database corruption: invalid ${column}`);
  return value;
}

export function requiredNumber(row: SqliteRow, column: string): number {
  const value = row[column];
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Graph database corruption: invalid ${column}`);
  return value;
}

export function nullableNumber(row: SqliteRow, column: string): number | null {
  const value = row[column];
  return value === null ? null : requiredNumber(row, column);
}

function numberOrZero(row: SqliteRow, column: string): number {
  return nullableNumber(row, column) ?? 0;
}

export function jsonArray<T>(value: SQLInputValue | undefined, label: string): T[] {
  if (typeof value !== "string") throw new Error(`Graph database corruption: invalid ${label}`);
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error(`Graph database corruption: invalid ${label} JSON`); }
  if (!Array.isArray(parsed)) throw new Error(`Graph database corruption: invalid ${label}`);
  return parsed as T[];
}

export function parseCoordinates(value: SQLInputValue | undefined): Array<readonly [number, number]> {
  const coordinates = jsonArray<unknown>(value, "geometry");
  if (
    coordinates.length < 2 ||
    !coordinates.every(
      (coordinate) =>
        Array.isArray(coordinate) &&
        coordinate.length >= 2 &&
        typeof coordinate[0] === "number" &&
        Number.isFinite(coordinate[0]) &&
        typeof coordinate[1] === "number" &&
        Number.isFinite(coordinate[1]),
    )
  ) {
    throw new Error("Graph database corruption: invalid edge geometry");
  }
  return coordinates.map((coordinate) => {
    const pair = coordinate as number[];
    return [pair[0], pair[1]] as const;
  });
}

export function parseAccessState(value: string): AccessState {
  if (["public", "unknown", "private", "closed", "prohibited"].includes(value)) return value as AccessState;
  throw new Error(`Invalid access state: ${value}`);
}

export function parseEdgeClass(value: SQLInputValue | undefined): EdgeClass {
  if (["trail", "service-road", "street", "sidewalk"].includes(String(value))) return value as EdgeClass;
  throw new Error(`Invalid edge class: ${String(value)}`);
}

function parsePortalRoadClass(value: SQLInputValue | undefined): "street" | "service-road" {
  if (value === "street" || value === "service-road") return value;
  throw new Error("Graph database corruption: invalid portal road class");
}


export function parseNode(row: SqliteRow): GraphNode {
  return {
    id: requiredString(row, "id"),
    lon: requiredNumber(row, "lon"),
    lat: requiredNumber(row, "lat"),
    elevationMeters: nullableNumber(row, "elevation_m"),
    flags: jsonArray<string>(row.flags, "node flags"),
  };
}

export function parseEdge(row: SqliteRow): GraphEdge {
  const flags = jsonArray<string>(row.flags, "edge flags");
  const encodedTrailName = flags.find((flag) => flag.startsWith("trail-name:"))?.slice("trail-name:".length);
  const encodedElevationProfile = row.elevation_profile === null ? [] : jsonArray<unknown>(row.elevation_profile, "edge elevation_profile");
  if (encodedElevationProfile.some((sample) => !Array.isArray(sample) || sample.length !== 2
    || sample.some((value) => typeof value !== "number" || !Number.isFinite(value)))) {
    throw new Error("Graph database corruption: invalid edge elevation_profile");
  }
  const elevationProfile = (encodedElevationProfile as Array<[number, number]>).map(
    ([distanceMeters, elevationMeters]) => ({ distanceMeters, elevationMeters }),
  );
  for (const column of ["edge_key", "physical_edge_key"]) {
    const key = requiredNumber(row, column);
    if (!Number.isSafeInteger(key) || key <= 0) throw new Error(`Graph database corruption: invalid ${column}`);
  }
  if (requiredNumber(row, "length_m") <= 0) throw new Error("Graph database corruption: invalid length_m");
  return {
    id: requiredString(row, "id"),
    edgeKey: requiredNumber(row, "edge_key"),
    physicalEdgeKey: requiredNumber(row, "physical_edge_key"),
    fromNodeId: requiredString(row, "from_node"),
    toNodeId: requiredString(row, "to_node"),
    coordinates: parseCoordinates(row.geometry),
    lengthMeters: requiredNumber(row, "length_m"),
    gainMeters: numberOrZero(row, "gain_m"),
    lossMeters: numberOrZero(row, "loss_m"),
    maximumElevationMeters: nullableNumber(row, "max_elevation_m"),
    maximumSustainedGradePct: nullableNumber(row, "max_sustained_grade_pct"),
    ...(elevationProfile.length > 0 ? { elevationProfile } : {}),
    accessState: parseAccessState(requiredString(row, "access_state")),
    edgeClass: parseEdgeClass(row.edge_class),
    trailName: encodedTrailName || null,
    sourceIds: jsonArray<string>(row.source_refs, "edge source_refs"),
    flags,
  };
}

export function parseAccessPoint(row: SqliteRow): GraphAccessPoint {
  const kind = requiredString(row, "kind");
  const confidence = requiredString(row, "confidence");
  if (!["trailhead", "parking", "transit"].includes(kind)) throw new Error(`Invalid access point kind: ${kind}`);
  if (!["high", "medium", "low"].includes(confidence)) throw new Error(`Invalid confidence: ${confidence}`);
  return {
    id: requiredString(row, "id"),
    nodeId: requiredString(row, "node_id"),
    name: requiredString(row, "name"),
    kind: kind as GraphAccessPoint["kind"],
    accessState: parseAccessState(requiredString(row, "access_state")),
    confidence: confidence as GraphAccessPoint["confidence"],
    parkingEvidence: typeof row.parking_evidence === "string" ? row.parking_evidence : null,
    sourceIds: jsonArray<string>(row.source_refs, "access point source_refs"),
    nearbyBuildingCount: requiredNumber(row, "nearby_building_count"),
    reachableTrailKm: requiredNumber(row, "reachable_trail_km"),
    trailComponentId: requiredString(row, "trail_component_id"),
    portalRoadClass: parsePortalRoadClass(row.portal_road_class),
    parkingDistanceM: nullableNumber(row, "parking_distance_m"),
  };
}

export function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Graph query was cancelled", "AbortError");
}

type DistanceEntry = { nodeId: string; distance: number };

export class DistanceQueue {
  readonly #items: DistanceEntry[] = [];

  push(entry: DistanceEntry): void {
    this.#items.push(entry);
    let index = this.#items.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (!this.#before(this.#items[index], this.#items[parent])) break;
      [this.#items[index], this.#items[parent]] = [this.#items[parent], this.#items[index]];
      index = parent;
    }
  }

  pop(): DistanceEntry | undefined {
    const first = this.#items[0];
    const last = this.#items.pop();
    if (!first || !last || this.#items.length === 0) return first;
    this.#items[0] = last;
    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      let next = index;
      if (left < this.#items.length && this.#before(this.#items[left], this.#items[next])) next = left;
      if (right < this.#items.length && this.#before(this.#items[right], this.#items[next])) next = right;
      if (next === index) break;
      [this.#items[index], this.#items[next]] = [this.#items[next], this.#items[index]];
      index = next;
    }
    return first;
  }

  get size(): number {
    return this.#items.length;
  }

  #before(left: DistanceEntry, right: DistanceEntry): boolean {
    return left.distance < right.distance ||
      (left.distance === right.distance && left.nodeId.localeCompare(right.nodeId) < 0);
  }
}


/** Null proves no cycle in the complete release; absent/malformed hints are corruption. */
export function parseMinimumStem(row: SqliteRow, column: string): number | null {
  const value = nullableNumber(row, column);
  if (value !== null && value < 0) throw new Error(`Graph database corruption: invalid ${column}`);
  return value;
}
