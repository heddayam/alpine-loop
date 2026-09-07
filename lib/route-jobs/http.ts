import { apiFailure, readJsonBody } from "@/lib/server/http";
import { apiErrorResponse, ServerApiError } from "@/lib/server/api-error";
import type { RouteJobService } from "./service";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function handle(error: unknown): Response {
  return apiFailure(error, "The full-search request failed unexpectedly.");
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
      try { return Response.json(await service.create(await readJsonBody(request), request.signal), { status: 202 }); }
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
