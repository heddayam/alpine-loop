import type { FeatureCollection, LineString } from "geojson";
import { bboxSchema } from "@/lib/contracts";
import { accessPointIsWildEnough } from "@/lib/data/wilderness";
import { PreparedGraphRepository, areaBounds, type AccessState } from "@/lib/graph";
import { groupContiguousTrailFeatures } from "./trail-network";
import { namespacedId } from "@/lib/search/identity";
import { accessPointCanStartClosedRoute } from "@/lib/solver";
import { ServerApiError } from "./api-error";
import { boundsOverlap, withPinnedSearchInstallation } from "./search-area";

type MapPoint = {
  id: string; name: string; lon: number; lat: number; kind: string;
  accessState: AccessState;
  confidence: "high" | "medium" | "low";
};

export async function mapData(request: Request) {
  const params = new URL(request.url).searchParams;
  const bbox = bboxSchema.safeParse(params.get("bbox")?.split(",").map(Number));
  if (!bbox.success) throw new ServerApiError("INVALID_BOUNDS", "A valid map bounding box is required.", 400);
  return withPinnedSearchInstallation(async (installed) => {
    const accessPoints: MapPoint[] = [];
    const features: FeatureCollection<LineString>["features"] = [];
    const seenGeometry = new Set<string>();
    if (installed) {
      const { installation, release, artifacts } = installed;
      if (request.signal.aborted) throw request.signal.reason;
      if (!boundsOverlap(bbox.data, areaBounds(installation.geometry))) return { accessPoints, trailNetwork: { type: "FeatureCollection" as const, features } };
      const repository = new PreparedGraphRepository({ installationId: installation.id, releaseId: release.id, artifacts, coverage: installation.geometry });
      try {
        const points = await repository.getAccessPointCandidates({ bbox: bbox.data, includeUncertainAccess: true, signal: request.signal });
        accessPoints.push(...points.filter(accessPointCanStartClosedRoute).filter(accessPointIsWildEnough).map((point) => ({
          id: namespacedId(installation.id, point.id), name: point.name, lon: point.lon, lat: point.lat,
          kind: point.kind, accessState: point.accessState, confidence: point.confidence,
        })));
        if (params.get("trails") !== "0") {
          for await (const edge of repository.iterateMapTrails({ bbox: bbox.data, includeUncertainAccess: true, signal: request.signal })) {
            const forward = JSON.stringify(edge.coordinates);
            const reverse = JSON.stringify([...edge.coordinates].reverse());
            const key = forward < reverse ? forward : reverse;
            if (seenGeometry.has(key)) continue;
            seenGeometry.add(key);
            if (features.length >= 75_000) throw new ServerApiError("MAP_TOO_LARGE", "Zoom in to load detailed trails.", 422);
            features.push({
              type: "Feature",
              properties: {
                id: namespacedId(installation.id, edge.id), name: edge.trailName, distanceMeters: edge.lengthMeters,
                role: "available-trail", accessState: edge.accessState, sourceIds: edge.sourceIds,
              },
              geometry: { type: "LineString", coordinates: edge.coordinates.map((position) => [...position]) },
            });
          }
          }
      } finally {
        await repository.close();
      }
    }
    return { accessPoints, trailNetwork: groupContiguousTrailFeatures({ type: "FeatureCollection", features }) };
  });
}
