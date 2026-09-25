import { handleDownload } from "@/lib/coverage-install/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: {params: Promise<{id: string}>}) {
 const params = await context.params; return handleDownload(request, "job", params.id);
}
