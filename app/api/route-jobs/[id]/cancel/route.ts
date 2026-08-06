import { createRouteJobCancelHandler, type RouteJobContext } from "@/lib/route-jobs";
import { defaultRouteJobService } from "@/lib/server/route-job-composition";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: RouteJobContext): Promise<Response> {
  return createRouteJobCancelHandler(defaultRouteJobService())(request, context);
}
