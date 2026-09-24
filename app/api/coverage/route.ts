import { defaultCoverageJobService } from "@/lib/coverage-jobs/default";
import { handleCoverageCatalog } from "@/lib/coverage-jobs/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(): Promise<Response> {
  return handleCoverageCatalog(defaultCoverageJobService());
}
