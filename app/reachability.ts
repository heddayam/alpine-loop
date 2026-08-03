export const REACHABILITY_DURATIONS = [
  5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60,
  75, 90, 105, 120, 135, 150, 165, 180,
  210, 240, 270, 300,
] as const;

export type ReachabilityDuration = (typeof REACHABILITY_DURATIONS)[number];
export type ReachabilityProvider = "google" | "arcgis";

export type ReachabilityRequest = {
  latitude: number;
  longitude: number;
  durationMinutes: ReachabilityDuration;
  provider: ReachabilityProvider;
};

export type ReachabilityParseResult =
  | { ok: true; request: ReachabilityRequest }
  | { ok: false; error: string };

export function providerForDuration(durationMinutes: number): ReachabilityProvider {
  return durationMinutes <= 60 ? "google" : "arcgis";
}

export function formatDuration(durationMinutes: number): string {
  if (durationMinutes < 60) return `${durationMinutes} min`;
  const hours = Math.floor(durationMinutes / 60);
  const minutes = durationMinutes % 60;
  return minutes ? `${hours} hr ${minutes} min` : `${hours} hr`;
}

export function parseReachabilityRequest(input: unknown): ReachabilityParseResult {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "Request body must be a JSON object." };
  }

  const candidate = input as Record<string, unknown>;
  const { latitude, longitude, durationMinutes } = candidate;
  if (
    typeof latitude !== "number" ||
    !Number.isFinite(latitude) ||
    latitude < -90 ||
    latitude > 90 ||
    typeof longitude !== "number" ||
    !Number.isFinite(longitude) ||
    longitude < -180 ||
    longitude > 180
  ) {
    return { ok: false, error: "Choose a valid starting location." };
  }

  if (
    typeof durationMinutes !== "number" ||
    !REACHABILITY_DURATIONS.includes(durationMinutes as ReachabilityDuration)
  ) {
    return { ok: false, error: "Choose a supported travel time from 5 minutes to 5 hours." };
  }

  return {
    ok: true,
    request: {
      latitude,
      longitude,
      durationMinutes: durationMinutes as ReachabilityDuration,
      provider: providerForDuration(durationMinutes),
    },
  };
}

export function reachabilityRequestKey(request: ReachabilityRequest): string {
  return [
    request.latitude.toFixed(5),
    request.longitude.toFixed(5),
    request.durationMinutes,
  ].join(":");
}
