const TRAVEL_MODES = ["DRIVE", "BICYCLE", "WALK"] as const;
const TRAVEL_DIRECTIONS = ["FROM", "TO"] as const;
const ROUTING_PREFERENCES = ["TRAFFIC_UNAWARE", "TRAFFIC_AWARE"] as const;
const POLYGON_FIDELITIES = ["LOW", "MEDIUM", "HIGH"] as const;

type TravelMode = (typeof TRAVEL_MODES)[number];
type TravelDirection = (typeof TRAVEL_DIRECTIONS)[number];
type RoutingPreference = (typeof ROUTING_PREFERENCES)[number];
type PolygonFidelity = (typeof POLYGON_FIDELITIES)[number];

type GoogleIsochroneRequest = {
  travelDuration: string;
  travelMode: TravelMode;
  travelDirection: TravelDirection;
  routingPreference?: RoutingPreference;
  enableSmoothing?: boolean;
  polygonFidelity?: PolygonFidelity;
  location?: { latitude: number; longitude: number };
  place?: string;
};

type ParseResult =
  | { ok: true; body: GoogleIsochroneRequest }
  | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOneOf<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === "string" && values.includes(value as T);
}

export function parseIsochroneRequest(input: unknown): ParseResult {
  if (!isRecord(input)) {
    return { ok: false, error: "Request body must be a JSON object." };
  }

  if (!isOneOf(input.travelMode, TRAVEL_MODES)) {
    return { ok: false, error: "travelMode must be DRIVE, BICYCLE, or WALK." };
  }

  if (!isOneOf(input.travelDirection, TRAVEL_DIRECTIONS)) {
    return { ok: false, error: "travelDirection must be FROM or TO." };
  }

  if (typeof input.travelDuration !== "string") {
    return { ok: false, error: "travelDuration must be expressed in seconds, such as 1800s." };
  }

  const durationMatch = /^(\d+(?:\.\d{1,9})?)s$/.exec(input.travelDuration);
  const durationSeconds = durationMatch ? Number(durationMatch[1]) : Number.NaN;
  const maximumDuration = input.travelMode === "DRIVE" ? 3_600 : 7_200;

  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > maximumDuration) {
    return {
      ok: false,
      error: `travelDuration must be greater than 0 and no more than ${maximumDuration}s for ${input.travelMode}.`,
    };
  }

  const hasLocation = isRecord(input.location);
  const hasPlace = typeof input.place === "string";
  if (hasLocation === hasPlace) {
    return { ok: false, error: "Provide exactly one origin: location or place." };
  }

  const body: GoogleIsochroneRequest = {
    travelDuration: input.travelDuration,
    travelMode: input.travelMode,
    travelDirection: input.travelDirection,
  };

  if (hasLocation) {
    const { latitude, longitude } = input.location;
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
      return { ok: false, error: "location must contain valid latitude and longitude values." };
    }
    body.location = { latitude, longitude };
  } else {
    const place = input.place as string;
    if (!/^places\/[A-Za-z0-9_-]+$/.test(place)) {
      return { ok: false, error: "place must use the places/PLACE_ID resource format." };
    }
    body.place = place;
  }

  if (input.routingPreference !== undefined) {
    if (!isOneOf(input.routingPreference, ROUTING_PREFERENCES)) {
      return { ok: false, error: "routingPreference must be TRAFFIC_UNAWARE or TRAFFIC_AWARE." };
    }
    body.routingPreference = input.routingPreference;
  }

  if (input.enableSmoothing !== undefined) {
    if (typeof input.enableSmoothing !== "boolean") {
      return { ok: false, error: "enableSmoothing must be a boolean." };
    }
    body.enableSmoothing = input.enableSmoothing;
  }

  if (input.polygonFidelity !== undefined) {
    if (!isOneOf(input.polygonFidelity, POLYGON_FIDELITIES)) {
      return { ok: false, error: "polygonFidelity must be LOW, MEDIUM, or HIGH." };
    }
    body.polygonFidelity = input.polygonFidelity;
  }

  return { ok: true, body };
}
