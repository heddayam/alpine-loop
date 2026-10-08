import type { Bounds, DatasetInfo, Position, RouteSummary, TrailGraph, TrailGeometry, TrailStart } from './model.js';

export type Boundary = { type: 'MultiPolygon'; coordinates: number[][][][] };
export type DataFile = { path: string; url?: string; bytes: number; jsonBytes: number; sha256: string };
/** Complete, independently compiled mountain sections. IDs never join across sections. */
export type PreparedSection = {
  id: string; regionId: string; name: string; bounds: Bounds; boundary: Boundary;
  sourceSegments: number; startCount: number;
  files: { graph: DataFile; starts: DataFile; geometry: DataFile };
};
export type UnavailableSection = { name: string; bounds: Bounds; boundary: Boundary; reason: string };
export type SectionCatalog = { version: 2; info: DatasetInfo; baseUrl?: string; sections: PreparedSection[]; unavailable?: UnavailableSection[] };
export type SectionView = PreparedSection & { installed: boolean; bytes: number; needsRepair?: boolean };
export type CatalogView = DatasetInfo & { sections: SectionView[]; unavailable?: UnavailableSection[] };
export type Coverage = { sections: string[]; missing: string[]; bytes: number };
export type DownloadSnapshot = {
  status: 'running' | 'complete' | 'stopped' | 'failed'; sections: string[];
  completedBytes: number; totalBytes: number; reason?: string;
};
export type SectionGraph = { graph: TrailGraph; trails: { name: string | null; kind: 'trail' | 'connector' }[] };
export type SectionStarts = [start: TrailStart, position: Position][];
export type SectionGeometry = TrailGeometry[];
export type StoredRoute = { summary: RouteSummary; sections: { section: string; id: number; reverse: boolean }[] };
