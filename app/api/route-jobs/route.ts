import { createRouteJobCollectionHandlers } from "@/lib/route-jobs";
import { defaultRouteJobService } from "@/lib/server/route-job-composition";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return createRouteJobCollectionHandlers(defaultRouteJobService()).POST(request);
}

export async function GET(): Promise<Response> {
  return createRouteJobCollectionHandlers(defaultRouteJobService()).GET();
}
