import {
  geocodingResolveRequestSchema,
  geocodingSuggestRequestSchema,
  type Origin,
} from "@/lib/contracts";
import { ESRI_ATTRIBUTION, type GeocodingSuggestion } from "./types";
import { ReachabilityError, toReachabilityError } from "./errors";
import { secondsUntilNextUtcMonth } from "./usage";
import { readJsonBody } from "@/lib/server/http";
import { ServerApiError } from "@/lib/server/api-error";

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
  try {
    return await readJsonBody(request, 16_384);
  } catch (error) {
    if (error instanceof ServerApiError && ["REQUEST_TOO_LARGE", "MALFORMED_JSON"].includes(error.code)) throw new ReachabilityError(
      error.code === "REQUEST_TOO_LARGE" ? "INVALID_REQUEST" : "MALFORMED_JSON",
      error.message, error.status,
    );
    throw error;
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
