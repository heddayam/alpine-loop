import { beforeEach, describe, expect, it, vi } from "vitest";
import { ReachabilityError } from "./errors";
import {
  createGeocodingResolveHandler,
  createGeocodingSuggestHandler,
  type GeocodingApi,
} from "./http";

const ORIGIN = { lon: -122.1, lat: 37.2, label: "Current location" };

function api(): GeocodingApi {
  return {
    suggest: vi.fn(async () => [{ id: "one", label: "One", magicKey: "key" }]),
    resolve: vi.fn(async () => ORIGIN),
  };
}

function request(path: string, body: unknown, raw = false): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: raw ? String(body) : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(() => {
    throw new Error("Automated reachability tests prohibit network access");
  }));
});

describe("geocoding HTTP API", () => {
  it("returns normalized suggestions and visible Esri attribution", async () => {
    const service = api();
    const response = await createGeocodingSuggestHandler(service)(request(
      "/api/geocoding/suggest",
      { text: "Castle Rock" },
    ));
    expect(response.status).toBe(200);
    expect(response.headers.get("x-data-attribution")).toBe("Esri");
    await expect(response.json()).resolves.toEqual({
      suggestions: [{ id: "one", label: "One", magicKey: "key" }],
      attribution: { provider: "arcgis", label: "Esri", url: "https://www.esri.com/" },
    });
    expect(service.suggest).toHaveBeenCalledWith("Castle Rock", expect.any(AbortSignal));
    expect(fetch).not.toHaveBeenCalled();
  });

  it("stops oversized chunked input before calling the provider and keeps its error contract", async () => {
    const service = api();
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new Uint8Array(16_385)); },
      cancel,
    }, { highWaterMark: 0 });
    const response = await createGeocodingSuggestHandler(service)(new Request("http://local/api/geocoding/suggest", {
      method: "POST", body, duplex: "half",
    } as RequestInit));
    expect(response.status).toBe(413);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-data-attribution")).toBe("Esri");
    expect(await response.json()).toEqual({ error: {
      code: "INVALID_REQUEST", message: "Request body is too large.", retryable: false,
    } });
    expect(cancel).toHaveBeenCalledOnce();
    expect(service.suggest).not.toHaveBeenCalled();
  });

  it("resolves only an explicit suggestion selection", async () => {
    const service = api();
    const handler = createGeocodingResolveHandler(service);
    const invalid = await handler(request(
      "/api/geocoding/resolve",
      { text: "Castle Rock" },
    ));
    expect(invalid.status).toBe(400);
    expect(service.resolve).not.toHaveBeenCalled();

    const valid = await handler(request(
      "/api/geocoding/resolve",
      { text: "Castle Rock", magicKey: "key" },
    ));
    expect(valid.status).toBe(200);
    await expect(valid.json()).resolves.toMatchObject({ origin: ORIGIN });
  });

  it("rejects malformed bodies and preserves quota errors", async () => {
    const service = api();
    const handler = createGeocodingSuggestHandler(service);
    const malformed = await handler(request("/api/geocoding/suggest", "{", true));
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ error: { code: "MALFORMED_JSON", message: "Request body must be valid JSON.", retryable: false } });
    expect(service.suggest).not.toHaveBeenCalled();
    vi.mocked(service.suggest).mockRejectedValue(new ReachabilityError(
      "USAGE_LIMIT_REACHED", "The monthly ArcGIS safety limit has been reached.", 429,
    ));
    const limited = await handler(request("/api/geocoding/suggest", { text: "Castle Rock" }));
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    await expect(limited.json()).resolves.toMatchObject({ error: { code: "USAGE_LIMIT_REACHED" } });
  });
});
