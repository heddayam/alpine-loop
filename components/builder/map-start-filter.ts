import type { MapStartFilter, SearchArea, RouteJobV2 } from "@/lib/contracts";
import { boundsPolygon } from "../map/geometry";

/** Full's named membership and exact drawn/driving predicates, without outlines. */
export function mapStartFilterForArea(
  area: SearchArea | undefined,
  includeUncertainAccess: boolean,
  resolvedDrivingGeometry?: MapStartFilter["predicates"][number],
): MapStartFilter | null {
  if (!area) return null;
  if (area.mode === "drawn-area") {
    // Coordinates here are generated from the same validated bounds as Full.
    return { includeUncertainAccess, predicates: [boundsPolygon(area.bbox).geometry as MapStartFilter["predicates"][number]] };
  }
  if (area.mode === "named-regions") return area.regionIds.length
    ? { includeUncertainAccess, predicates: [], namedRegionIds: area.regionIds } : null;
  if (!resolvedDrivingGeometry) return null;
  return { includeUncertainAccess, predicates: [resolvedDrivingGeometry], ...(area.regionIds.length ? { namedRegionIds: area.regionIds } : {}) };
}

export function mapStartFilterForJob(job: RouteJobV2): MapStartFilter | null {
  if (job.request.area.mode === "drive-time" && ["queued", "resolving-drive-time", "failed"].includes(job.status)) return null;
  return mapStartFilterForArea(job.request.area, job.request.criteria.includeUncertainAccess, job.area.filterGeometry);
}
