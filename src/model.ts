/** Map bounds describe prepared footprints, drawn areas and camera views. */
export type Bounds = [west: number, south: number, east: number, north: number];
export type Position = [longitude: number, latitude: number, elevationMeters?: number];
/** A simple polygon's vertices, without a duplicate closing vertex. */
export type SearchBoundary = [longitude: number, latitude: number][];
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
export type StartKind = 'trailhead' | 'parking' | 'road-contact';
export type TrailStart = { id: string; node: number; name: string; access: Access; kind: StartKind };
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
  /** Exactly the prepared sections to search, considering every eligible start. */
  sections: string[];
  /** Restrict starting points only. Routes may leave this boundary. */
  boundary?: SearchBoundary;
  /** Internal discovery plans. Public jobs always use the deep plan. */
  effort?: 'normal' | 'deep';
  distance: [minimum: number, maximum: number];
  gain: [minimum: number, maximum: number];
  /** Maximum one-way approach distance in meters. Both stem limits apply when supplied. */
  stem?: number;
  /** Maximum one-way stem as a fraction of total hike distance. */
  repetition?: number;
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
  startKind: StartKind;
  startPosition: Position;
  trailNames: string[];
};
export type HikeRoute = RouteSummary & { geometry: Position[] };
/** The preferred qualifying walk for one displayed hike. */
export type RouteChoice = RouteSummary & {
  groupId: string;
};
export type RouteView = HikeRoute & RouteChoice;
export const ROUTES_PER_PAGE = 50;
export type JobStatus = 'queued' | 'running' | 'completed' | 'cancelled' | 'failed' | 'interrupted';
export type JobProgress = {
  stage: 'preparing' | 'searching' | 'saving';
  currentRegion?: { id: string; name: string };
  completedRegions: string[];
  totalRegions: number;
  elapsedMs: number;
  expansions: number;
  totalStarts: number;
  completedStarts: number;
  totalSearchPoints?: number;
  completedSearchPoints?: number;
};
export type JobInputs = {
  version: string;
  sections: {
    id: string; name: string; bounds: Bounds;
    boundary: { type: 'MultiPolygon'; coordinates: number[][][][] };
    files: Record<'graph' | 'starts' | 'geometry', { path: string; sha256: string; bytes: number; jsonBytes: number }>;
  }[];
};
/** Status/history contains metadata only. Results are readable only after durable completion. */
export type JobSnapshot = {
  id: string;
  query: SearchQuery;
  status: JobStatus;
  /** Identifies the saved result set, including previously completed local jobs. */
  resultsRevision?: number;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  queuePosition?: number;
  progress: JobProgress;
  reason?: string;
  regions?: { id: string; name: string }[];
  inputs?: JobInputs;
  storageBytes: number;
  groupCount?: number;
  routeCount?: number;
};
/** Newest-first durable history; the cursor is the last returned job's ID. */
export type JobHistoryPage = { jobs: JobSnapshot[]; nextCursor?: string };
export type ResultSort = 'distance' | 'gain' | 'repetition' | 'roadDistance';
export type SortOrder = 'asc' | 'desc';
export type JobResults = {
  routes: RouteChoice[];
  pageTotal: number;
  offset: number;
  groupCount: number;
  routeCount: number;
  sort: ResultSort;
  order: SortOrder;
  selectionNote: string;
};
export type RouteLocation = Pick<RouteChoice, 'id' | 'groupId' | 'startId' | 'startName' | 'startPosition' | 'trailNames' | 'distance' | 'gain' | 'repetition'> & { bounds: Bounds };
/** Each shared physical trail is drawn once, with its preferred hikes in distance order. */
export type RoutePath = { id: string; routeIds: string[]; geometry: [number, number][] };
export type SearchProgress = {
  totalStarts: number;
  attemptedStarts: number;
  completedStarts: number;
  expansions: number;
  elapsedMs: number;
  totalSearchPoints?: number;
  completedSearchPoints?: number;
};
export type SearchEvent =
  | { type: 'route'; route: RouteCandidate }
  | { type: 'progress'; progress: SearchProgress }
  | { type: 'done'; status: 'complete' | 'stopped' | 'limited'; progress: SearchProgress; reason?: string };
