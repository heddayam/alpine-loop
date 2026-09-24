import { defaultCoverageJobService } from "@/lib/coverage-jobs/default";
import { handleCoverageJobs } from "@/lib/coverage-jobs/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request): Promise<Response> {
  return handleCoverageJobs(request, defaultCoverageJobService());
}
export async function POST(request: Request): Promise<Response> {
  return handleCoverageJobs(request, defaultCoverageJobService());
}
