import { createRouteJobDetailHandlers, type RouteJobContext } from "@/lib/route-jobs";
import { defaultRouteJobService } from "@/lib/server/route-job-composition";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: RouteJobContext): Promise<Response> {
  return createRouteJobDetailHandlers(defaultRouteJobService()).GET(request, context);
}

export async function DELETE(request: Request, context: RouteJobContext): Promise<Response> {
  return createRouteJobDetailHandlers(defaultRouteJobService()).DELETE(request, context);
}
