import { defaultCoverageJobService } from "@/lib/coverage-jobs/default";
import { handleCoveragePlan } from "@/lib/coverage-jobs/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request): Promise<Response> {
  return handleCoveragePlan(request, defaultCoverageJobService());
}
