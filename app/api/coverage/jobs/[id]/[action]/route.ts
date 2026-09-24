import { defaultCoverageJobService } from "@/lib/coverage-jobs/default";
import { handleCoverageAction } from "@/lib/coverage-jobs/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request, context: { params: Promise<{ id: string; action: string }> }): Promise<Response> {
  const { id, action } = await context.params;
  return handleCoverageAction(request, id, action, defaultCoverageJobService());
}
