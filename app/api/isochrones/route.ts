import {
  GOOGLE_ISOCHRONE_MONTHLY_LIMIT,
  reserveGoogleIsochroneRequest,
  secondsUntilNextUtcMonth,
} from "@/db/isochrone-usage";
import { parseIsochroneRequest } from "./request";

const GOOGLE_ISOCHRONE_ENDPOINT =
  "https://isochrones.googleapis.com/v1/isochrones:generate";
const MAX_REQUEST_BYTES = 16_384;

function quotaHeaders(remaining: number) {
  return {
    "Cache-Control": "no-store",
    "X-RateLimit-Limit": String(GOOGLE_ISOCHRONE_MONTHLY_LIMIT),
    "X-RateLimit-Remaining": String(Math.max(0, remaining)),
  };
}

export async function POST(request: Request) {
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (declaredLength > MAX_REQUEST_BYTES) {
    return Response.json({ error: "Request body is too large." }, { status: 413 });
  }

  let input: unknown;
  try {
    input = await request.json();
  } catch {
    return Response.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  const parsed = parseIsochroneRequest(input);
  if (!parsed.ok) {
    return Response.json({ error: parsed.error }, { status: 400 });
  }

  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    return Response.json(
      { error: "Isochrone service is not configured." },
      { status: 503 },
    );
  }

  let reservation;
  try {
    reservation = await reserveGoogleIsochroneRequest();
  } catch {
    return Response.json(
      { error: "Isochrone usage could not be verified, so the request was blocked." },
      { status: 503, headers: quotaHeaders(0) },
    );
  }

  if (!reservation) {
    return Response.json(
      {
        error: "The monthly free-tier safety limit has been reached.",
        retryAfter: "next UTC month",
      },
      {
        status: 429,
        headers: {
          ...quotaHeaders(0),
          "Retry-After": String(secondsUntilNextUtcMonth()),
        },
      },
    );
  }

  try {
    const upstream = await fetch(GOOGLE_ISOCHRONE_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
      },
      body: JSON.stringify(parsed.body),
    });

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: {
        "Content-Type": upstream.headers.get("content-type") ?? "application/json",
        ...quotaHeaders(reservation.remaining),
      },
    });
  } catch {
    return Response.json(
      { error: "The isochrone provider could not be reached." },
      { status: 502, headers: quotaHeaders(reservation.remaining) },
    );
  }
}
