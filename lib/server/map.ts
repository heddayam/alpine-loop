import type { FeatureCollection, LineString } from "geojson";
import { bboxSchema } from "@/lib/contracts";
import { accessPointIsWildEnough } from "@/lib/data/wilderness";
import { SQLiteGraphRepository, type AccessState } from "@/lib/graph";
import { groupContiguousTrailFeatures } from "@/lib/packs/trail-network";
import { namespacedId } from "@/lib/search/identity";
import { accessPointCanStartClosedRoute } from "@/lib/solver";
import { ServerApiError } from "./api-error";
import { boundsOverlap, installedSearchPacks } from "./search-area";

type MapPoint = {
  id: string; name: string; lon: number; lat: number; kind: string;
  accessState: AccessState;
  confidence: "high" | "medium" | "low";
};

export async function mapData(request: Request) {
  const params = new URL(request.url).searchParams;
  const bbox = bboxSchema.safeParse(params.get("bbox")?.split(",").map(Number));
  if (!bbox.success) throw new ServerApiError("INVALID_BOUNDS", "A valid map bounding box is required.", 400);
  const accessPoints: MapPoint[] = [];
  const features: FeatureCollection<LineString>["features"] = [];
  const seenGeometry = new Set<string>();
  for (const { manifest, databasePath } of (await installedSearchPacks()).values()) {
    if (request.signal.aborted) throw request.signal.reason;
    if (!boundsOverlap(bbox.data, manifest.coverage.bbox)) continue;
    const repository = new SQLiteGraphRepository(databasePath, manifest.id);
    try {
      const [points, graph] = await Promise.all([
        repository.getAccessPointCandidates({ bbox: bbox.data, includeUncertainAccess: true, signal: request.signal }),
        params.get("trails") === "0" ? { edges: [] } : repository.getInducedGraph({ bbox: bbox.data, includeUncertainAccess: true, signal: request.signal }),
      ]);
      accessPoints.push(...points.filter(accessPointCanStartClosedRoute).filter(accessPointIsWildEnough).map((point) => ({
        id: namespacedId(manifest.id, point.id), name: point.name, lon: point.lon, lat: point.lat,
        kind: point.kind, accessState: point.accessState, confidence: point.confidence,
      })));
      const physicalEdges = new Set<number>();
      for (const edge of graph.edges) {
        if (edge.physicalEdgeKey !== undefined) {
          if (physicalEdges.has(edge.physicalEdgeKey)) continue;
          physicalEdges.add(edge.physicalEdgeKey);
        }
        const forward = JSON.stringify(edge.coordinates);
        const reverse = JSON.stringify([...edge.coordinates].reverse());
        const key = forward < reverse ? forward : reverse;
        if (seenGeometry.has(key)) continue;
        seenGeometry.add(key);
        if (features.length >= 75_000) throw new ServerApiError("MAP_TOO_LARGE", "Zoom in to load detailed trails.", 422);
        features.push({
          type: "Feature",
          properties: {
            id: namespacedId(manifest.id, edge.id), name: edge.trailName, distanceMeters: edge.lengthMeters,
            role: "available-trail", accessState: edge.accessState, sourceIds: edge.sourceIds,
          },
          geometry: { type: "LineString", coordinates: edge.coordinates.map((position) => [...position]) },
        });
      }
    } finally {
      await repository.close();
    }
  }
  return { accessPoints, trailNetwork: groupContiguousTrailFeatures({ type: "FeatureCollection", features }) };
}
