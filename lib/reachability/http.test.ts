import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DRIVE_TIME_DURATIONS_MINUTES,
  type ReachabilityRequest,
  type ReachabilityResponse,
} from "@/lib/contracts";
import { ReachabilityError } from "./errors";
import {
  createGeocodingResolveHandler,
  createGeocodingSuggestHandler,
  createReachabilityCancelHandler,
  createReachabilityPollHandler,
  createReachabilitySubmitHandler,
  type ReachabilityApi,
} from "./http";

const ID = "db52ceda-c6ef-47f1-9153-dba294a9eccc";
const REQUEST: ReachabilityRequest = {
  version: 1,
  packId: "fixture",
  origin: { lon: -122.1, lat: 37.2, label: "Current location" },
  durationMinutes: 30,
};

function api(): ReachabilityApi {
  const pending: ReachabilityResponse = { status: "pending", requestId: ID, pollAfterMs: 1_000 };
  return {
    suggest: vi.fn(async () => [{ id: "one", label: "One", magicKey: "key" }]),
    resolve: vi.fn(async () => REQUEST.origin),
    submit: vi.fn(async () => pending),
    poll: vi.fn(async () => pending),
    cancel: vi.fn(async () => undefined),
  };
}

function request(path: string, body: unknown, raw = false): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: raw ? String(body) : JSON.stringify(body),
  });
}

function context(id = ID) {
  return { params: Promise.resolve({ requestId: id }) };
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
      { packId: "fixture", text: "Castle Rock" },
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

  it("resolves only an explicit suggestion selection", async () => {
    const service = api();
    const handler = createGeocodingResolveHandler(service);
    const invalid = await handler(request(
      "/api/geocoding/resolve",
      { packId: "fixture", text: "Castle Rock" },
    ));
    expect(invalid.status).toBe(400);
    expect(service.resolve).not.toHaveBeenCalled();

    const valid = await handler(request(
      "/api/geocoding/resolve",
      { packId: "fixture", text: "Castle Rock", magicKey: "key" },
    ));
    expect(valid.status).toBe(200);
    await expect(valid.json()).resolves.toMatchObject({ origin: REQUEST.origin });
  });
});

describe("reachability HTTP API", () => {
  it("validates supported durations and malformed JSON before service calls", async () => {
    const service = api();
    const handler = createReachabilitySubmitHandler(service);
    const unsupported = await handler(request(
      "/api/reachability",
      { ...REQUEST, durationMinutes: 31 },
    ));
    expect(unsupported.status).toBe(400);
    await expect(unsupported.json()).resolves.toMatchObject({ error: { code: "INVALID_REQUEST" } });

    const malformed = await handler(request("/api/reachability", "{", true));
    expect(malformed.status).toBe(400);
    await expect(malformed.json()).resolves.toMatchObject({ error: { code: "MALFORMED_JSON" } });
    expect(service.submit).not.toHaveBeenCalled();
  });

  it("returns 202 for asynchronous submission and provider attribution metadata", async () => {
    const service = api();
    const response = await createReachabilitySubmitHandler(service)(request("/api/reachability", REQUEST));
    expect(response.status).toBe(202);
    expect(response.headers.get("x-reachability-provider")).toBe("arcgis");
    await expect(response.json()).resolves.toMatchObject({ status: "pending", requestId: ID });
  });

  it("accepts every supported 5–300 minute value", async () => {
    const service = api();
    const handler = createReachabilitySubmitHandler(service);
    for (const durationMinutes of DRIVE_TIME_DURATIONS_MINUTES) {
      const response = await handler(request("/api/reachability", { ...REQUEST, durationMinutes }));
      expect(response.status).toBe(202);
    }
    expect(service.submit).toHaveBeenCalledTimes(DRIVE_TIME_DURATIONS_MINUTES.length);
  });

  it("polls and cancels by UUID", async () => {
    const service = api();
    const poll = await createReachabilityPollHandler(service)(
      new Request(`http://localhost/api/reachability/${ID}`),
      context(),
    );
    expect(poll.status).toBe(200);
    expect(service.poll).toHaveBeenCalledWith(ID, expect.any(AbortSignal));

    const cancel = await createReachabilityCancelHandler(service)(
      new Request(`http://localhost/api/reachability/${ID}`, { method: "DELETE" }),
      context(),
    );
    expect(cancel.status).toBe(204);
    expect(service.cancel).toHaveBeenCalledWith(ID, expect.any(AbortSignal));
  });

  it("maps stable provider and expiry errors without sensitive details", async () => {
    const service = api();
    vi.mocked(service.poll).mockRejectedValue(new ReachabilityError(
      "REACHABILITY_EXPIRED",
      "That drive-time request expired. Calculate it again.",
      410,
    ));
    const response = await createReachabilityPollHandler(service)(
      new Request(`http://localhost/api/reachability/${ID}`),
      context(),
    );
    expect(response.status).toBe(410);
    await expect(response.json()).resolves.toEqual({ error: {
      code: "REACHABILITY_EXPIRED",
      message: "That drive-time request expired. Calculate it again.",
      retryable: false,
    } });

    const invalid = await createReachabilityPollHandler(service)(
      new Request("http://localhost/api/reachability/not-a-uuid"),
      context("not-a-uuid"),
    );
    expect(invalid.status).toBe(400);
    expect(service.poll).toHaveBeenCalledOnce();
  });
});
