import type { Bounds, DatasetInfo, Position, RouteSummary, SearchEvent, TrailEdge, TrailGeometry, TrailStart } from './model.js';

/** A snapshot is partitioned after its topology is compiled. Numeric identities
 * are shared by all files in that snapshot, never joined across snapshots. */
export type NetworkManifest = {
  version: 2;
  cellDegrees: 0.1;
  distanceMetric: 'haversine-6371008.8';
  info: DatasetInfo;
  files: Record<string, { bytes: number; jsonBytes: number; sha256: string }>;
};

/** Full sections are repeated in every cell touched by their bounding box.
 * Geometry has one owner: the cell containing the bounding-box midpoint.
 * Cell names are floor(longitude*10)_floor(latitude*10), including negatives.
 * Files are graph/<cell>.json.gz, starts/<cell>.json.gz, geometry/<cell>.json.gz.
 * An absent entry inside info.bounds means processed and empty. A declared
 * but absent/bad file is an error; outside bounds coverage is unknown. */
export type NetworkSection = {
  id: number;
  bounds: Bounds;
  name: string | null;
  kind: 'trail' | 'connector';
  edges: [id: number, edge: Omit<TrailEdge, 'connector'>][];
};
export type NetworkCell = { nodes: [id: number, position: Position][]; sections: NetworkSection[] };
export type NetworkStarts = [index: number, start: TrailStart, position: Position][];
export type NetworkGeometry = [id: number, geometry: TrailGeometry][];

/** A retained route needs no copy of the search graph or all its drawings. */
export type StoredRoute = {
  summary: RouteSummary;
  sections: { cell: string; id: number; reverse: boolean }[];
};

export type WorkerEvent = Exclude<SearchEvent, { type: 'route' }>
  | { type: 'route'; route: StoredRoute }
  | { type: 'coverage'; note?: string };
