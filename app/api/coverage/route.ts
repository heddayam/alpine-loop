import { handleDownload } from "@/lib/coverage-install/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) { return handleDownload(request, "catalog"); }
export async function DELETE(request: Request) { return handleDownload(request, "catalog"); }
