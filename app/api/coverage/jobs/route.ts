import { handleDownload } from "@/lib/coverage-install/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) { return handleDownload(request, "jobs"); }
export async function POST(request: Request) { return handleDownload(request, "jobs"); }
