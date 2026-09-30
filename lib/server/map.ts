import type { FeatureCollection, LineString } from "geojson";
import { bboxSchema, mapRequestSchema } from "@/lib/contracts";
import { PreparedGraphRepository, areaBounds, type AccessState } from "@/lib/graph";
import { groupContiguousTrailFeatures } from "./trail-network";
import { namespacedId } from "@/lib/search/identity";
import { listEligibleAccessPointCandidates } from "@/lib/solver";
import { readJsonBody } from "./http";
import { ServerApiError } from "./api-error";
import { boundsOverlap, withPinnedSearchInstallation } from "./search-area";

type MapPoint = {
  id: string; name: string; lon: number; lat: number; kind: string;
  accessState: AccessState;
  confidence: "high" | "medium" | "low";
  knownEntranceFamilyId?: string;
  inclusiveEntranceFamilyId?: string;
};

export async function mapData(request: Request) {
  const params = new URL(request.url).searchParams;
  const input = request.method === "POST"
    ? mapRequestSchema.safeParse(await readJsonBody(request, 2_000_000))
    : mapRequestSchema.safeParse({ bbox: bboxSchema.safeParse(params.get("bbox")?.split(",").map(Number)).data, trails: params.get("trails") !== "0" });
  if (!input.success) throw new ServerApiError("INVALID_MAP_FILTER", "A valid map area and starting-point filter are required.", 400);
  const { bbox, trails, startFilter } = input.data;
  return withPinnedSearchInstallation(async (installed) => {
    const accessPoints: MapPoint[] = [];
    const features: FeatureCollection<LineString>["features"] = [];
    const seenGeometry = new Set<string>();
    if (installed) {
      const { installation, release, artifacts, routingGeometry } = installed;
      if (request.signal.aborted) throw request.signal.reason;
      if (!boundsOverlap(bbox, areaBounds(routingGeometry))) return { accessPoints, trailNetwork: { type: "FeatureCollection" as const, features } };
      const repository = new PreparedGraphRepository({ installationId: installation.id, releaseId: release.id, artifacts, coverage: routingGeometry });
      try {
        const filter=startFilter??{includeUncertainAccess:true,predicates:[]};
        const points = startFilter===null ? [] : (await listEligibleAccessPointCandidates({repository,
          accessFilter:{...filter,coverage:routingGeometry},includeUncertainAccess:filter.includeUncertainAccess,viewportBbox:bbox,signal:request.signal})).eligible;
        accessPoints.push(...points.map((point) => ({
          id: namespacedId(installation.id, point.id), name: point.name, lon: point.lon, lat: point.lat,
          kind: point.kind, accessState: point.accessState, confidence: point.confidence,
          ...(point.knownEntranceFamilyId ? { knownEntranceFamilyId: namespacedId(installation.id, point.knownEntranceFamilyId) } : {}),
          ...(point.inclusiveEntranceFamilyId ? { inclusiveEntranceFamilyId: namespacedId(installation.id, point.inclusiveEntranceFamilyId) } : {}),
        })));
        if (trails) {
          for await (const edge of repository.iterateMapTrails({ bbox, includeUncertainAccess: true, signal: request.signal })) {
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
