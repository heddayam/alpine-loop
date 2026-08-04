type GoogleIsochroneRequest = {
  location: { latitude: number; longitude: number };
  travelDuration: string;
  travelMode: "DRIVE";
  travelDirection: "FROM";
  routingPreference: "TRAFFIC_UNAWARE";
  enableSmoothing: true;
  polygonFidelity: "MEDIUM";
};

type ParseResult =
  | { ok: true; body: GoogleIsochroneRequest }
  | { ok: false; error: string };

export function parseIsochroneRequest(input: unknown): ParseResult {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "Request body must be a JSON object." };
  }

  const candidate = input as Record<string, unknown>;
  const latitude = candidate.latitude;
  const longitude = candidate.longitude;
  const durationMinutes = candidate.durationMinutes;

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
    !Number.isInteger(durationMinutes) ||
    durationMinutes < 5 ||
    durationMinutes > 60 ||
    durationMinutes % 5 !== 0
  ) {
    return {
      ok: false,
      error: "Travel time must be a five-minute increment from 5 to 60 minutes.",
    };
  }

  return {
    ok: true,
    body: {
      location: { latitude, longitude },
      travelDuration: `${durationMinutes * 60}s`,
      travelMode: "DRIVE",
      travelDirection: "FROM",
      routingPreference: "TRAFFIC_UNAWARE",
      enableSmoothing: true,
      polygonFidelity: "MEDIUM",
    },
  };
}
