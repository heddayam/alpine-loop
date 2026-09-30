/** Geographic selection chooses starting points, never clips a route. */
export type Bounds = [west: number, south: number, east: number, north: number];
export type Position = [longitude: number, latitude: number, elevationMeters?: number];
export type Access = 'public' | 'unknown';

export type TrailEdge = {
  from: number;
  to: number;
  trail: number;
  reverse: boolean;
  distance: number;
  gain: number;
  access: Access;
};
export type TrailStart = { id: string; node: number; name: string; access: Access };
export type Place = { name: string; bounds: Bounds };
export type Attribution = { name: string; url: string; license: string };
export type DatasetInfo = {
  id: string;
  name: string;
  bounds: Bounds;
  sourceDate: string;
  attribution: Attribution[];
  limitations: string[];
  places: Place[];
  startCount: number;
};

/** Immutable search facts; rich drawing geometry lives in a separate file. */
export type TrailGraph = {
  version: 1;
  info: DatasetInfo;
  nodes: Position[];
  edges: TrailEdge[];
  starts: TrailStart[];
};
export type TrailGeometry = { id: string; name: string | null; coordinates: Position[] };

/** Engine/transport measurements use meters and fractions; UI converts units. */
export type SearchQuery = {
  area: Bounds;
  distance: [minimum: number, maximum: number];
  gain: [minimum: number, maximum: number];
  repetition: number;
  includeUnknown: boolean;
};
export type RouteCandidate = {
  id: string;
  start: number;
  edges: number[];
  distance: number;
  gain: number;
  repetition: number;
  kind: 'loop' | 'lollipop';
  uncertain: boolean;
};
export type HikeRoute = RouteCandidate & {
  startId: string;
  startName: string;
  geometry: Position[];
  trailNames: string[];
};
export type SearchStatus = 'running' | 'complete' | 'stopped' | 'limited' | 'failed';
export type SearchProgress = {
  totalStarts: number;
  attemptedStarts: number;
  completedStarts: number;
  expansions: number;
  elapsedMs: number;
};
export type SearchSnapshot = {
  id: string;
  datasetId: string;
  query: SearchQuery;
  status: SearchStatus;
  progress: SearchProgress;
  routes: HikeRoute[];
  reason?: string;
};
export type SearchEvent =
  | { type: 'route'; route: RouteCandidate }
  | { type: 'progress'; progress: SearchProgress }
  | { type: 'done'; status: Exclude<SearchStatus, 'running' | 'failed'>; progress: SearchProgress; reason?: string };
