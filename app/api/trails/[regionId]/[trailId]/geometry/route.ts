import {
  getRegionalTrailCatalog,
  loadRegionalTrailGeometry,
} from "@/app/trails/catalog";
import {
  findUserFacingTrail,
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
  let catalog;
  try {
    catalog = await getRegionalTrailCatalog(regionId, request.url);
  } catch (error) {
    console.error("Trail catalog loading failed", error);
    return errorResponse("Trail geometry is temporarily unavailable.", 503);
  }
  const trail = catalog ? findUserFacingTrail(catalog, trailId) : null;
  if (!catalog || !trail) return errorResponse("Trail geometry was not found.", 404);

  const artifactVersion = catalog.manifest.buildId ?? catalog.manifest.generatedAt;
  const etag = `"${artifactVersion}:${trail.id}"`;
  if (request.headers.get("if-none-match") === etag) {
    return new Response(null, {
      status: 304,
      headers: { ETag: etag, "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400" },
    });
  }

  try {
    const segments = await loadRegionalTrailGeometry(catalog, trail, request.url);
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
