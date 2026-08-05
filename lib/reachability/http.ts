import {
  geocodingResolveRequestSchema,
  geocodingSuggestRequestSchema,
  reachabilityRequestSchema,
  type Origin,
  type ReachabilityRequest,
  type ReachabilityResponse,
} from "@/lib/contracts";
import { ESRI_ATTRIBUTION, type GeocodingSuggestion } from "./types";
import { ReachabilityError, toReachabilityError } from "./errors";
import { secondsUntilNextUtcMonth } from "./usage";

const MAXIMUM_BODY_BYTES = 16_384;
const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface ReachabilityApi {
  suggest(text: string, signal?: AbortSignal): Promise<GeocodingSuggestion[]>;
  resolve(text: string, magicKey: string, signal?: AbortSignal): Promise<Origin>;
  submit(request: ReachabilityRequest, signal?: AbortSignal): Promise<ReachabilityResponse>;
  poll(id: string, signal?: AbortSignal): Promise<ReachabilityResponse>;
  cancel(id: string, signal?: AbortSignal): Promise<void>;
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

export function createGeocodingSuggestHandler(service: ReachabilityApi) {
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

export function createGeocodingResolveHandler(service: ReachabilityApi) {
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

export function createReachabilitySubmitHandler(service: ReachabilityApi) {
  return async function POST(request: Request): Promise<Response> {
    try {
      const parsed = reachabilityRequestSchema.safeParse(await jsonBody(request));
      if (!parsed.success) throw validationError(parsed.error.issues);
      const response = await service.submit(parsed.data, request.signal);
      return Response.json(response, { status: response.status === "pending" ? 202 : 200, headers: providerHeaders() });
    } catch (error) {
      return errorResponse(error);
    }
  };
}

type RouteContext = { params: Promise<{ requestId: string }> };

async function requestId(context: RouteContext): Promise<string> {
  const { requestId } = await context.params;
  if (!REQUEST_ID_PATTERN.test(requestId)) {
    throw new ReachabilityError("INVALID_REQUEST", "That reachability identifier is invalid.", 400);
  }
  return requestId;
}

export function createReachabilityPollHandler(service: ReachabilityApi) {
  return async function GET(request: Request, context: RouteContext): Promise<Response> {
    try {
      const response = await service.poll(await requestId(context), request.signal);
      return Response.json(response, { headers: providerHeaders() });
    } catch (error) {
      return errorResponse(error);
    }
  };
}

export function createReachabilityCancelHandler(service: ReachabilityApi) {
  return async function DELETE(request: Request, context: RouteContext): Promise<Response> {
    try {
      await service.cancel(await requestId(context), request.signal);
      return new Response(null, { status: 204, headers: providerHeaders() });
    } catch (error) {
      return errorResponse(error);
    }
  };
}
