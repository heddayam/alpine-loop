import { apiErrorResponse, isCancellationError, ServerApiError } from "@/lib/server/api-error";
import type { RouteJobService } from "./service";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_BODY_BYTES = 32_768;

function handle(error: unknown): Response {
  if (error instanceof ServerApiError) return apiErrorResponse(error);
  if (isCancellationError(error)) return apiErrorResponse(new ServerApiError("REQUEST_CANCELLED", "The request was cancelled.", 499));
  return apiErrorResponse(new ServerApiError("INTERNAL_ERROR", "The batch route-job request failed unexpectedly.", 500));
}

async function body(request: Request): Promise<unknown> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null && /^\d+$/.test(contentLength) && Number(contentLength) > MAX_BODY_BYTES) {
    throw new ServerApiError("REQUEST_TOO_LARGE", "Request body is too large.", 413);
  }

  const reader = request.body?.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let bytes = 0;
  if (reader) {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_BODY_BYTES) {
          void reader.cancel().catch(() => undefined);
          throw new ServerApiError("REQUEST_TOO_LARGE", "Request body is too large.", 413);
        }
        chunks.push(decoder.decode(value, { stream: true }));
      }
      chunks.push(decoder.decode());
    } finally {
      reader.releaseLock();
    }
  }
  const text = chunks.join("");
  try { return JSON.parse(text); } catch { throw new ServerApiError("MALFORMED_JSON", "Request body must be valid JSON.", 400); }
}

export type RouteJobContext = { params: Promise<{ id: string }> };

async function jobId(context: RouteJobContext): Promise<string> {
  const { id } = await context.params;
  if (!UUID.test(id)) throw new ServerApiError("INVALID_ROUTE_JOB_ID", "That batch route-job identifier is invalid.", 400);
  return id;
}

export function createRouteJobCollectionHandlers(service: RouteJobService) {
  return {
    async POST(request: Request): Promise<Response> {
      try { return Response.json(await service.create(await body(request), request.signal), { status: 202 }); }
      catch (error) { return handle(error); }
    },
    async GET(): Promise<Response> {
      try { return Response.json({ version: 2, jobs: await service.list() }); }
      catch (error) { return handle(error); }
    },
  };
}

export function createRouteJobDetailHandlers(service: RouteJobService) {
  return {
    async GET(_request: Request, context: RouteJobContext): Promise<Response> {
      try {
        const job = await service.get(await jobId(context));
        return job ? Response.json(job) : apiErrorResponse(new ServerApiError("ROUTE_JOB_NOT_FOUND", "That batch route job was not found.", 404));
      } catch (error) { return handle(error); }
    },
    async DELETE(_request: Request, context: RouteJobContext): Promise<Response> {
      try { await service.delete(await jobId(context)); return new Response(null, { status: 204 }); }
      catch (error) { return handle(error); }
    },
  };
}

export function createRouteJobCancelHandler(service: RouteJobService) {
  return async function POST(_request: Request, context: RouteJobContext): Promise<Response> {
    try { return Response.json(await service.cancel(await jobId(context))); }
    catch (error) { return handle(error); }
  };
}

export function createRouteJobResultsHandler(service: RouteJobService) {
  return async function GET(request: Request, context: RouteJobContext): Promise<Response> {
    try {
      const cursor = new URL(request.url).searchParams.get("cursor") ?? undefined;
      return Response.json(await service.results(await jobId(context), cursor));
    } catch (error) { return handle(error); }
  };
}
