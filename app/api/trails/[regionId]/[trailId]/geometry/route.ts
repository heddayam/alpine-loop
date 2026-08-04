import {
  getRegionalTrailCatalog,
  loadRegionalSegmentShard,
} from "@/app/trails/catalog";
import {
  findUserFacingTrail,
  loadTrailSegments,
  trailAccessPointDetails,
  trailGeometryFeatureCollection,
} from "@/app/trails/search";

type RouteContext = {
  params: Promise<{ regionId: string; trailId: string }>;
};

function errorResponse(error: string, status: number) {
  return Response.json(
    { error },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

export async function GET(request: Request, context: RouteContext) {
  const { regionId, trailId } = await context.params;
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(regionId) ||
      !/^named-trail_[0-9a-f]+$/.test(trailId)) {
    return errorResponse("Trail geometry was not found.", 404);
  }
  const catalog = getRegionalTrailCatalog(regionId);
  const trail = catalog ? findUserFacingTrail(catalog, trailId) : null;
  if (!catalog || !trail) return errorResponse("Trail geometry was not found.", 404);

  const etag = `"${catalog.manifest.generatedAt}:${trail.id}"`;
  if (request.headers.get("if-none-match") === etag) {
    return new Response(null, {
      status: 304,
      headers: { ETag: etag, "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400" },
    });
  }

  try {
    const segments = await loadTrailSegments(
      catalog,
      trail.id,
      (shard, selectedIds) => loadRegionalSegmentShard(regionId, shard, selectedIds, request.url),
    );
    if (!segments) return errorResponse("Trail geometry was not found.", 404);
    return Response.json(trailGeometryFeatureCollection(
      regionId,
      trail,
      segments,
      trailAccessPointDetails(catalog, trail),
    ), {
      headers: {
        ETag: etag,
        "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400",
      },
    });
  } catch (error) {
    console.error("Trail geometry loading failed", error);
    return errorResponse("Trail geometry is temporarily unavailable.", 503);
  }
}
