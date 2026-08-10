import { describe, expect, it, vi } from "vitest";
import type { RouteJobService } from "./service";
import {
  createRouteJobCancelHandler,
  createRouteJobCollectionHandlers,
  createRouteJobDetailHandlers,
  createRouteJobResultsHandler,
} from "./http";

const id = "00000000-0000-4000-8000-000000000020";
const context = { params: Promise.resolve({ id }) };

function service(methods: Record<string, unknown> = {}): RouteJobService {
  return {
    create: vi.fn(), list: vi.fn(async () => []), get: vi.fn(async () => null),
    cancel: vi.fn(), delete: vi.fn(), results: vi.fn(),
    ...methods,
  } as unknown as RouteJobService;
}

describe("route-job HTTP handlers", () => {
  it("returns structured validation errors and lists jobs", async () => {
    const runtime = service({
      create: vi.fn(async () => { throw Object.assign(new Error("invalid"), { code: "INVALID_REQUEST", status: 400 }); }),
    });
    const handlers = createRouteJobCollectionHandlers(runtime);
    expect((await handlers.POST(new Request("http://local/api/route-jobs", { method: "POST", body: "{" }))).status).toBe(400);
    const listed = await handlers.GET();
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({ version: 1, jobs: [] });
  });

  it("rejects oversized request bodies before buffering them", async () => {
    const runtime = service();
    const request = new Request("http://local/api/route-jobs", {
      method: "POST",
      headers: { "content-length": "32769" },
      body: "{}",
    });

    const response = await createRouteJobCollectionHandlers(runtime).POST(request);

    expect(response.status).toBe(413);
    expect(runtime.create).not.toHaveBeenCalled();
  });

  it("stops reading chunked request bodies at the size limit", async () => {
    const response = await createRouteJobCollectionHandlers(service()).POST(new Request(
      "http://local/api/route-jobs",
      { method: "POST", body: "x".repeat(32_769) },
    ));

    expect(response.status).toBe(413);
  });

  it("routes detail, cancel, delete, and cursor requests to the service", async () => {
    const runtime = service({
      get: vi.fn(async () => ({ id })),
      cancel: vi.fn(async () => ({ id, status: "cancelled" })),
      delete: vi.fn(async () => undefined),
      results: vi.fn(async () => ({ version: 1, results: [] })),
    });
    expect((await createRouteJobDetailHandlers(runtime).GET(new Request("http://local"), context)).status).toBe(200);
    expect((await createRouteJobCancelHandler(runtime)(new Request("http://local", { method: "POST" }), context)).status).toBe(200);
    expect((await createRouteJobResultsHandler(runtime)(new Request("http://local?cursor=abc"), context)).status).toBe(200);
    expect(vi.mocked(runtime.results)).toHaveBeenCalledWith(id, "abc");
    expect((await createRouteJobDetailHandlers(runtime).DELETE(new Request("http://local", { method: "DELETE" }), context)).status).toBe(204);
  });

  it("rejects malformed identifiers before service access", async () => {
    const runtime = service();
    const response = await createRouteJobDetailHandlers(runtime).GET(
      new Request("http://local"),
      { params: Promise.resolve({ id: "not-a-uuid" }) },
    );
    expect(response.status).toBe(400);
    expect(runtime.get).not.toHaveBeenCalled();
  });
});
