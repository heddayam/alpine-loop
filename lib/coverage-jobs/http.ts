import { z } from "zod";
import { coverageActionSchema, coverageRequestSchema } from "@/lib/contracts/coverage";
import { CoverageJobStateError } from "./store";
import type { CoverageJobService } from "./service";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function assertLocalMutation(request: Request): void {
  const url = new URL(request.url);
  const hostHeader = request.headers.get("host");
  // Next.js may use the container's bind address in request.url. The Host
  // authority is the browser-facing origin, including its mapped port.
  const target = hostHeader ? new URL(`${url.protocol}//${hostHeader}`) : url;
  const origin = request.headers.get("origin");
  if (!LOOPBACK.has(target.hostname) || target.username || target.password
    || (origin && origin !== target.origin)
    || request.headers.get("sec-fetch-site") === "cross-site") {
    throw new CoverageJobStateError(403, "Coverage changes require a same-origin local request");
  }
}
async function jsonBody(request: Request): Promise<unknown> {
  const value = await request.text();
  if (value.length > 1_000_000) throw new CoverageJobStateError(413, "Coverage request is too large");
  try { return JSON.parse(value); }
  catch { throw new CoverageJobStateError(400, "Invalid JSON request"); }
}
export function coverageHttpError(error: unknown): Response {
  const status = error instanceof CoverageJobStateError ? error.status : error instanceof z.ZodError ? 400 : 500;
  return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status });
}
export async function handleCoverageCatalog(service: CoverageJobService): Promise<Response> {
  try { return Response.json(await service.catalog()); }
  catch (error) { return coverageHttpError(error); }
}
export async function handleCoveragePlan(request: Request, service: CoverageJobService): Promise<Response> {
  try {
    assertLocalMutation(request);
    const input = coverageRequestSchema.parse(await jsonBody(request));
    return Response.json(await service.plan(input));
  } catch (error) { return coverageHttpError(error); }
}
export async function handleCoverageJobs(request: Request, service: CoverageJobService): Promise<Response> {
  try {
    if (request.method === "GET") return Response.json(service.list());
    assertLocalMutation(request);
    const input = z.object({ planId: z.string().min(1) }).strict().parse(await jsonBody(request));
    return Response.json(service.build(input.planId), { status: 202 });
  } catch (error) { return coverageHttpError(error); }
}
export async function handleCoverageJob(id: string, service: CoverageJobService): Promise<Response> {
  try {
    const job = service.get(id);
    return job ? Response.json(job) : Response.json({ error: "Coverage job was not found" }, { status: 404 });
  } catch (error) { return coverageHttpError(error); }
}
export async function handleCoverageAction(request: Request, id: string, action: string, service: CoverageJobService): Promise<Response> {
  try {
    assertLocalMutation(request);
    return Response.json(service.action(id, coverageActionSchema.parse(action)));
  } catch (error) { return coverageHttpError(error); }
}
