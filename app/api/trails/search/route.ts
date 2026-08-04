import { getRegionalTrailCatalog } from "@/app/trails/catalog";
import {
  MAX_TRAIL_SEARCH_REQUEST_BYTES,
  parseTrailSearchRequest,
  searchTrails,
} from "@/app/trails/search";

const RESPONSE_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
};

function errorResponse(error: string, status: number) {
  return Response.json({ error }, { status, headers: RESPONSE_HEADERS });
}

export async function POST(request: Request) {
  const declaredBytes = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredBytes) && declaredBytes > MAX_TRAIL_SEARCH_REQUEST_BYTES) {
    return errorResponse("The trail search geometry is too detailed.", 413);
  }

  let text: string;
  try {
    text = await request.text();
  } catch {
    return errorResponse("The request body could not be read.", 400);
  }
  if (new TextEncoder().encode(text).byteLength > MAX_TRAIL_SEARCH_REQUEST_BYTES) {
    return errorResponse("The trail search geometry is too detailed.", 413);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return errorResponse("The request body must be valid JSON.", 400);
  }
  const parsed = parseTrailSearchRequest(payload);
  if (!parsed.ok) return errorResponse(parsed.error, 400);

  let catalog;
  try {
    catalog = await getRegionalTrailCatalog(parsed.request.regionId, request.url);
  } catch (error) {
    console.error("Trail catalog loading failed", error);
    return errorResponse("Trail search is temporarily unavailable.", 503);
  }
  if (!catalog) return errorResponse("That trail region is not available.", 404);
  try {
    return Response.json(searchTrails(catalog, parsed.request), { headers: RESPONSE_HEADERS });
  } catch (error) {
    console.error("Trail search execution failed", error);
    return errorResponse("Trail search is temporarily unavailable.", 503);
  }
}
