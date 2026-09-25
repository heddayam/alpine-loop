import { handleDownload } from "@/lib/coverage-install/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request, context: {params: Promise<{id: string; action: string}>}) {
 const params = await context.params; return handleDownload(request, "action", params.id, params.action);
}
