import { defaultCoverageJobService } from "@/lib/coverage-jobs/default";
import { handleCoverageJob } from "@/lib/coverage-jobs/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  return handleCoverageJob((await context.params).id, defaultCoverageJobService());
}
