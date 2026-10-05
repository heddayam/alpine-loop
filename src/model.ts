/** Map bounds describe prepared footprints and camera views; search selects section IDs. */
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
  /** Derived from the section's physical classification when loading topology. */
  connector: boolean;
};
export type TrailStart = { id: string; node: number; name: string; access: Access };
export type Attribution = { name: string; url: string; license: string };
export type DatasetInfo = {
  id: string;
  name: string;
  bounds: Bounds;
  sourceDate: string;
  attribution: Attribution[];
  limitations: string[];
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
  /** Exactly the prepared sections to explore, including every eligible start. */
  sections: string[];
  distance: [minimum: number, maximum: number];
  gain: [minimum: number, maximum: number];
  repetition: number;
  includeUnknown: boolean;
  /** Omission uses the adjustable defaults; search snapshots record resolved limits. */
  roads?: RoadLimits;
};
export type RoadLimits = { distance: number; fraction: number };
export const DEFAULT_ROAD_LIMITS: RoadLimits = { distance: 1609.344, fraction: 0.1 };
export type RouteCandidate = {
  id: string;
  start: number;
  edges: number[];
  distance: number;
  gain: number;
  roadDistance: number;
  repetition: number;
  kind: 'loop' | 'lollipop';
  uncertain: boolean;
};
export type RouteSummary = Pick<RouteCandidate, 'id' | 'distance' | 'gain' | 'roadDistance' | 'repetition' | 'kind' | 'uncertain'> & {
  startId: string;
  startName: string;
  startPosition: Position;
  trailNames: string[];
};
export type HikeRoute = RouteSummary & { geometry: Position[] };
/** One qualifying connection from a start to a distinct hike; reverse facts remain independent. */
export type RouteChoice = RouteSummary & { groupId: string; groupSize: number; reverseId?: string };
export type RouteView = HikeRoute & RouteChoice;
export const ROUTES_PER_PAGE = 50;
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
  routes: RouteChoice[];
  routeCount: number;
  groupCount: number;
  /** Omitted for the group overview; set when browsing the routes in one group. */
  groupId?: string;
  pageTotal: number;
  offset: number;
  selectionNote?: string;
  reason?: string;
};
export type SearchEvent =
  | { type: 'route'; route: RouteCandidate }
  | { type: 'progress'; progress: SearchProgress }
  | { type: 'done'; status: Exclude<SearchStatus, 'running' | 'failed'>; progress: SearchProgress; reason?: string };
