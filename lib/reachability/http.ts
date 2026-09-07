import {
  geocodingResolveRequestSchema,
  geocodingSuggestRequestSchema,
  type Origin,
} from "@/lib/contracts";
import { ESRI_ATTRIBUTION, type GeocodingSuggestion } from "./types";
import { ReachabilityError, toReachabilityError } from "./errors";
import { secondsUntilNextUtcMonth } from "./usage";

const MAXIMUM_BODY_BYTES = 16_384;

export interface GeocodingApi {
  suggest(text: string, signal?: AbortSignal): Promise<GeocodingSuggestion[]>;
  resolve(text: string, magicKey: string, signal?: AbortSignal): Promise<Origin>;
}

function providerHeaders(): Headers {
  return new Headers({
    "Cache-Control": "no-store",
    "X-Reachability-Provider": "arcgis",
    "X-Data-Attribution": ESRI_ATTRIBUTION.label,
    Link: `<${ESRI_ATTRIBUTION.url}>; rel="attribution"`,
  });
}

function errorResponse(error: unknown): Response {
  const normalized = toReachabilityError(error);
  const headers = providerHeaders();
  if (normalized.code === "USAGE_LIMIT_REACHED") {
    headers.set("Retry-After", String(secondsUntilNextUtcMonth(new Date())));
  }
  return Response.json({
    error: {
      code: normalized.code,
      message: normalized.message,
      retryable: normalized.retryable,
      ...(normalized.details ? { details: normalized.details } : {}),
    },
  }, { status: normalized.status, headers });
}

async function jsonBody(request: Request): Promise<unknown> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAXIMUM_BODY_BYTES) {
    throw new ReachabilityError("INVALID_REQUEST", "Request body is too large.", 413);
  }
  let text: string;
  try {
    text = await request.text();
  } catch (error) {
    throw toReachabilityError(error);
  }
  if (new TextEncoder().encode(text).byteLength > MAXIMUM_BODY_BYTES) {
    throw new ReachabilityError("INVALID_REQUEST", "Request body is too large.", 413);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ReachabilityError("MALFORMED_JSON", "Request body must be valid JSON.", 400);
  }
}

function validationError(issues: Array<{ path: PropertyKey[]; message: string }>): ReachabilityError {
  return new ReachabilityError(
    "INVALID_REQUEST",
    "The request is invalid.",
    400,
    false,
    { issues: issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })) },
  );
}

export function createGeocodingSuggestHandler(service: GeocodingApi) {
  return async function POST(request: Request): Promise<Response> {
    try {
      const parsed = geocodingSuggestRequestSchema.safeParse(await jsonBody(request));
      if (!parsed.success) throw validationError(parsed.error.issues);
      const suggestions = await service.suggest(parsed.data.text, request.signal);
      return Response.json({ suggestions, attribution: ESRI_ATTRIBUTION }, { headers: providerHeaders() });
    } catch (error) {
      return errorResponse(error);
    }
  };
}

export function createGeocodingResolveHandler(service: GeocodingApi) {
  return async function POST(request: Request): Promise<Response> {
    try {
      const parsed = geocodingResolveRequestSchema.safeParse(await jsonBody(request));
      if (!parsed.success) throw validationError(parsed.error.issues);
      const origin = await service.resolve(parsed.data.text, parsed.data.magicKey, request.signal);
      return Response.json({ origin, attribution: ESRI_ATTRIBUTION }, { headers: providerHeaders() });
    } catch (error) {
      return errorResponse(error);
    }
  };
}
