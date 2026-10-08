import type { Bounds, DatasetInfo, Position, RouteSummary, TrailGraph, TrailGeometry, TrailStart } from './model.js';

export type Boundary = { type: 'MultiPolygon'; coordinates: number[][][][] };
export type DataFile = { path: string; url?: string; bytes: number; jsonBytes: number; sha256: string };
/** Explicit display geography comes from preparation, never parsed from a label. */
export type Area = {
  state: string; regionId: string; regionName: string; name: string; description?: string;
  bounds: Bounds; boundary: Boundary;
};
/** Complete, independently compiled mountain sections. IDs never join across sections. */
export type PreparedSection = Area & {
  id: string;
  sourceSegments: number; startCount: number;
  files: { graph: DataFile; starts: DataFile; geometry: DataFile };
};
export type UnavailableSection = Area & { reason: string };
export type SectionCatalog = { version: 2; info: DatasetInfo; baseUrl?: string; sections: PreparedSection[]; unavailable?: UnavailableSection[] };
export type SectionView = PreparedSection & { installed: boolean; bytes: number; needsRepair?: boolean };
export type CatalogView = DatasetInfo & { sections: SectionView[]; unavailable?: UnavailableSection[]; hosted?: boolean };
export type Coverage = { sections: string[]; missing: string[]; bytes: number };
export type DownloadSnapshot = {
  status: 'running' | 'complete' | 'stopped' | 'failed'; sections: string[];
  completedBytes: number; totalBytes: number; reason?: string;
};
export type SectionGraph = { graph: TrailGraph; trails: { name: string | null; kind: 'trail' | 'connector' }[] };
export type SectionStarts = [start: TrailStart, position: Position][];
export type SectionGeometry = TrailGeometry[];
export type StoredRoute = { summary: RouteSummary; sections: { section: string; id: number; reverse: boolean; name?: string | null }[] };
