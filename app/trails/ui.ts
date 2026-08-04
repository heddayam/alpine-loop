import type { SourceRef } from "./search";

export type TrailAccessPoint = {
  id: string;
  name?: string;
  type: "trailhead" | "entrance" | "parking" | "derived";
  confidence: "official" | "mapped" | "derived";
  longitude: number;
  latitude: number;
  sourceRefs: SourceRef[];
};

export type ReachableTrail = {
  id: string;
  name: string;
  manager?: string;
  bounds: [number, number, number, number];
  lengthMeters?: number;
  dataConfidence: "high" | "medium" | "low";
  hiking: "allowed" | "unknown";
  access: "public" | "unknown";
  status: "open" | "seasonal" | "unknown";
  surfaces?: string[];
  elevation?: { minMeters: number; maxMeters: number };
  notices: string[];
  accessPointCount: number;
  accessPoints: TrailAccessPoint[];
  sourceRefs: SourceRef[];
  geometryUrl: string;
};

export type TrailSearchResponse = {
  schemaVersion: 1;
  artifactVersion: string;
  region: {
    id: string;
    label: string;
    bounds: [number, number, number, number];
  };
  count: number;
  trails: ReachableTrail[];
};

export type TrailAccessMarkerModel = TrailAccessPoint & {
  trailIds: string[];
  trailNames: string[];
  selected: boolean;
};

export const LOW_ZOOM_ACCESS_MARKER_THRESHOLD = 10;
export const MAX_LOW_ZOOM_ACCESS_MARKERS = 200;

const ACCESS_EVIDENCE_RANK = Object.freeze({ official: 0, mapped: 1, derived: 2 });

export function buildTrailAccessMarkerModels(
  trails: ReachableTrail[],
  selectedTrailId: string | null,
) {
  const markers = new Map<string, TrailAccessMarkerModel>();
  for (const trail of trails) {
    for (const accessPoint of trail.accessPoints) {
      const existing = markers.get(accessPoint.id);
      if (existing) {
        if (!existing.trailIds.includes(trail.id)) {
          existing.trailIds.push(trail.id);
          existing.trailNames.push(trail.name);
        }
        if (trail.id === selectedTrailId) existing.selected = true;
        continue;
      }
      markers.set(accessPoint.id, {
        ...accessPoint,
        trailIds: [trail.id],
        trailNames: [trail.name],
        selected: trail.id === selectedTrailId,
      });
    }
  }
  return [...markers.values()];
}

export function visibleTrailAccessMarkerModels(
  trails: ReachableTrail[],
  selectedTrailId: string | null,
  zoom: number,
) {
  const markers = buildTrailAccessMarkerModels(trails, selectedTrailId);
  if (zoom > LOW_ZOOM_ACCESS_MARKER_THRESHOLD ||
      markers.length <= MAX_LOW_ZOOM_ACCESS_MARKERS) return markers;
  return markers.sort((left, right) =>
    Number(right.selected) - Number(left.selected) ||
    ACCESS_EVIDENCE_RANK[left.confidence] - ACCESS_EVIDENCE_RANK[right.confidence] ||
    left.id.localeCompare(right.id)
  ).slice(0, MAX_LOW_ZOOM_ACCESS_MARKERS);
}

export function formatTrailLength(lengthMeters?: number) {
  if (lengthMeters === undefined) return "Unavailable";
  if (lengthMeters < 1_000) return `${Math.round(lengthMeters)} m`;
  return `${(lengthMeters / 1_609.344).toFixed(1)} mi`;
}

export function formatElevationRange(elevation?: ReachableTrail["elevation"]) {
  if (!elevation) return "Unavailable";
  return `${Math.round(elevation.minMeters).toLocaleString("en-US")}–${Math.round(elevation.maxMeters).toLocaleString("en-US")} m`;
}

export function formatContractValue(value: string) {
  return value.replaceAll("-", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function formatSourceDate(value: string) {
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(value);
  return match?.[1] ?? value;
}
