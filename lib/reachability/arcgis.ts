import type { Origin, ReachabilityRequest } from "@/lib/contracts";
import { cancelledError, ReachabilityError, toReachabilityError } from "./errors";
import { normalizeArcGisArea } from "./geometry";
import type {
  ArcGisProvider,
  AreaGeometry,
  Clock,
  GeocodingSuggestion,
} from "./types";

export const ARCGIS_GEOCODING_ENDPOINT =
  "https://geocode-api.arcgis.com/arcgis/rest/services/World/GeocodeServer";
export const ARCGIS_SERVICE_AREA_ENDPOINT =
  "https://logistics.arcgis.com/arcgis/rest/services/World/ServiceAreas/GPServer/GenerateServiceAreas";

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

type FetchLike = typeof fetch;

type ArcGisClientOptions = {
  fetch: FetchLike;
  clock: Clock;
  geocodingApiKey?: string;
  routingApiKey?: string;
  geocodingEndpoint?: string;
  serviceAreaEndpoint?: string;
  maximumAttempts?: number;
};

function requireKey(value: string | undefined, service: string, configuration: string): string {
  if (value) return value;
  throw new ReachabilityError(
    "PROVIDER_NOT_CONFIGURED",
    `${service} is not configured. Set ${configuration} in .env.local, then restart the development server.`,
    503,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function providerFailure(status: number): ReachabilityError {
  if (status === 401 || status === 403 || status === 498 || status === 499) {
    return new ReachabilityError(
      "PROVIDER_UNAUTHORIZED",
      "ArcGIS rejected the configured server credential.",
      502,
    );
  }
  if (status === 429) {
    return new ReachabilityError(
      "PROVIDER_RATE_LIMITED",
      "ArcGIS is temporarily rate limited. Try again shortly.",
      429,
      true,
    );
  }
  if (status >= 500) {
    return new ReachabilityError(
      "PROVIDER_UNAVAILABLE",
      "ArcGIS is temporarily unavailable.",
      502,
      true,
    );
  }
  return new ReachabilityError(
    "PROVIDER_REJECTED",
    "ArcGIS could not complete that request.",
    502,
  );
}

function payloadFailure(payload: unknown): ReachabilityError | null {
  if (!isRecord(payload) || !isRecord(payload.error)) return null;
  const code = payload.error.code;
  return providerFailure(typeof code === "number" ? code : 502);
}

function invalidResponse(message: string): ReachabilityError {
  return new ReachabilityError("INVALID_PROVIDER_RESPONSE", message, 502);
}

function aborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw cancelledError();
}

function appendToken(url: URL, apiKey: string): URL {
  url.searchParams.set("token", apiKey);
  url.searchParams.set("f", "json");
  return url;
}

export function buildServiceAreaSubmitBody(
  request: ReachabilityRequest,
  apiKey: string,
): URLSearchParams {
  const body = new URLSearchParams();
  body.set("f", "json");
  body.set("token", apiKey);
  body.set("facilities", JSON.stringify({
    geometryType: "esriGeometryPoint",
    spatialReference: { wkid: 4326 },
    features: [{
      geometry: { x: request.origin.lon, y: request.origin.lat },
      attributes: { Name: "Origin" },
    }],
  }));
  body.set("break_values", String(request.durationMinutes));
  body.set("break_units", "Minutes");
  body.set("travel_direction", "Away from Facility");
  body.set("impedance", "Minutes");
  body.set("time_impedance", "Minutes");
  body.set("use_hierarchy", "true");
  body.set("detailed_Polygons", "false");
  body.set("polygon_detail", "Standard");
  body.set("output_format", "Feature Set");
  body.set("context", JSON.stringify({ outSR: { wkid: 4326 } }));
  return body;
}

function jobState(status: unknown): "pending" | "complete" | "failed" {
  if (status === "esriJobSucceeded") return "complete";
  if (status === "esriJobFailed" || status === "esriJobCancelled" || status === "esriJobTimedOut") {
    return "failed";
  }
  return "pending";
}

function resultFeatureSet(payload: unknown): unknown {
  if (!isRecord(payload)) return null;
  const value = payload.value;
  if (isRecord(value) && Array.isArray(value.features)) return value;
  if (isRecord(value) && isRecord(value.service_areas)) return value.service_areas;
  if (isRecord(payload.service_areas)) return payload.service_areas;
  return null;
}

export class ArcGisClient implements ArcGisProvider {
  private readonly fetcher: FetchLike;
  private readonly clock: Clock;
  private readonly geocodingApiKey?: string;
  private readonly routingApiKey?: string;
  private readonly geocodingEndpoint: string;
  private readonly serviceAreaEndpoint: string;
  private readonly maximumAttempts: number;

  constructor(options: ArcGisClientOptions) {
    this.fetcher = options.fetch;
    this.clock = options.clock;
    this.geocodingApiKey = options.geocodingApiKey;
    this.routingApiKey = options.routingApiKey;
    this.geocodingEndpoint = options.geocodingEndpoint ?? ARCGIS_GEOCODING_ENDPOINT;
    this.serviceAreaEndpoint = options.serviceAreaEndpoint ?? ARCGIS_SERVICE_AREA_ENDPOINT;
    this.maximumAttempts = options.maximumAttempts ?? 3;
  }

  private async json(
    url: string | URL,
    init: RequestInit,
    signal: AbortSignal | undefined,
    retry: boolean,
  ): Promise<unknown> {
    const attempts = retry ? this.maximumAttempts : 1;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      aborted(signal);
      try {
        const response = await this.fetcher(url, { ...init, signal });
        if (!response.ok) {
          if (RETRYABLE_STATUS.has(response.status) && attempt < attempts) {
            await this.clock.sleep(100 * 2 ** (attempt - 1), signal);
            continue;
          }
          throw providerFailure(response.status);
        }
        let payload: unknown;
        try {
          payload = await response.json() as unknown;
        } catch {
          throw invalidResponse("ArcGIS returned malformed JSON.");
        }
        const failure = payloadFailure(payload);
        if (failure) {
          if (failure.retryable && attempt < attempts) {
            await this.clock.sleep(100 * 2 ** (attempt - 1), signal);
            continue;
          }
          throw failure;
        }
        return payload;
      } catch (error) {
        const normalized = toReachabilityError(error);
        if (normalized.code === "REQUEST_CANCELLED") throw normalized;
        if (normalized.retryable && attempt < attempts) {
          await this.clock.sleep(100 * 2 ** (attempt - 1), signal);
          continue;
        }
        throw normalized;
      }
    }
    throw new ReachabilityError("PROVIDER_UNAVAILABLE", "ArcGIS is temporarily unavailable.", 502, true);
  }

  async suggest(text: string, signal?: AbortSignal): Promise<GeocodingSuggestion[]> {
    const key = requireKey(this.geocodingApiKey, "ArcGIS geocoding", "ARCGIS_GEOCODING_API_KEY (or ARCGIS_API_KEY)");
    const url = appendToken(new URL(`${this.geocodingEndpoint}/suggest`), key);
    url.searchParams.set("text", text);
    url.searchParams.set("maxSuggestions", "8");
    const payload = await this.json(url, { headers: { Accept: "application/json" } }, signal, true);
    if (!isRecord(payload) || !Array.isArray(payload.suggestions)) {
      throw invalidResponse("ArcGIS returned invalid geocoding suggestions.");
    }
    const suggestions: GeocodingSuggestion[] = [];
    for (const candidate of payload.suggestions) {
      if (!isRecord(candidate) || typeof candidate.text !== "string" || !candidate.text.trim()
        || typeof candidate.magicKey !== "string" || !candidate.magicKey) {
        throw invalidResponse("ArcGIS returned invalid geocoding suggestions.");
      }
      suggestions.push({ id: candidate.magicKey, label: candidate.text, magicKey: candidate.magicKey });
    }
    return suggestions;
  }

  async resolve(text: string, magicKey: string, signal?: AbortSignal): Promise<Origin> {
    const key = requireKey(this.geocodingApiKey, "ArcGIS geocoding", "ARCGIS_GEOCODING_API_KEY (or ARCGIS_API_KEY)");
    const url = appendToken(new URL(`${this.geocodingEndpoint}/findAddressCandidates`), key);
    url.searchParams.set("SingleLine", text);
    url.searchParams.set("magicKey", magicKey);
    url.searchParams.set("outFields", "Match_addr");
    url.searchParams.set("outSR", "4326");
    url.searchParams.set("forStorage", "false");
    const payload = await this.json(url, { headers: { Accept: "application/json" } }, signal, true);
    if (!isRecord(payload) || !Array.isArray(payload.candidates)) {
      throw invalidResponse("ArcGIS returned an invalid geocoding result.");
    }
    const first = payload.candidates[0];
    if (!isRecord(first) || !isRecord(first.location)
      || typeof first.location.x !== "number" || !Number.isFinite(first.location.x)
      || first.location.x < -180 || first.location.x > 180
      || typeof first.location.y !== "number" || !Number.isFinite(first.location.y)
      || first.location.y < -90 || first.location.y > 90) {
      throw new ReachabilityError(
        "PROVIDER_REJECTED",
        "No matching drivable origin was found.",
        422,
      );
    }
    const address = typeof first.address === "string" && first.address.trim()
      ? first.address.trim()
      : text;
    return { lon: first.location.x, lat: first.location.y, label: address.slice(0, 240) };
  }

  async submitServiceArea(request: ReachabilityRequest, signal?: AbortSignal): Promise<string> {
    const key = requireKey(this.routingApiKey, "ArcGIS reachability", "ARCGIS_ROUTING_API_KEY (or ARCGIS_API_KEY)");
    const payload = await this.json(
      `${this.serviceAreaEndpoint}/submitJob`,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: buildServiceAreaSubmitBody(request, key),
      },
      signal,
      false,
    );
    if (!isRecord(payload) || typeof payload.jobId !== "string" || !payload.jobId) {
      throw invalidResponse("ArcGIS did not return a service-area job identifier.");
    }
    return payload.jobId;
  }

  async pollServiceArea(
    providerJobId: string,
    signal?: AbortSignal,
  ): Promise<
    | { state: "pending" }
    | { state: "failed"; message: string }
    | { state: "complete"; geometry: AreaGeometry }
  > {
    const key = requireKey(this.routingApiKey, "ArcGIS reachability", "ARCGIS_ROUTING_API_KEY (or ARCGIS_API_KEY)");
    const base = `${this.serviceAreaEndpoint}/jobs/${encodeURIComponent(providerJobId)}`;
    const statusUrl = appendToken(new URL(base), key);
    const statusPayload = await this.json(
      statusUrl,
      { headers: { Accept: "application/json" } },
      signal,
      true,
    );
    if (!isRecord(statusPayload) || typeof statusPayload.jobStatus !== "string") {
      throw invalidResponse("ArcGIS returned an invalid service-area job status.");
    }
    const state = jobState(statusPayload.jobStatus);
    if (state === "pending") return { state };
    if (state === "failed") {
      return { state, message: "ArcGIS could not calculate that drive-time area." };
    }

    const resultUrl = appendToken(new URL(`${base}/results/service_areas`), key);
    const resultPayload = await this.json(
      resultUrl,
      { headers: { Accept: "application/json" } },
      signal,
      true,
    );
    const geometry = normalizeArcGisArea(resultFeatureSet(resultPayload));
    if (!geometry) throw invalidResponse("ArcGIS returned invalid service-area geometry.");
    return { state: "complete", geometry };
  }

  async cancelServiceArea(providerJobId: string, signal?: AbortSignal): Promise<void> {
    const key = requireKey(this.routingApiKey, "ArcGIS reachability", "ARCGIS_ROUTING_API_KEY (or ARCGIS_API_KEY)");
    const url = appendToken(
      new URL(`${this.serviceAreaEndpoint}/jobs/${encodeURIComponent(providerJobId)}/cancel`),
      key,
    );
    await this.json(url, { method: "POST", headers: { Accept: "application/json" } }, signal, true);
  }
}
