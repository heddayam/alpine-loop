import {
  ARCGIS_SERVICE_AREA_MONTHLY_LIMIT,
  ARCGIS_SERVICE_AREA_PROVIDER,
  GOOGLE_ISOCHRONE_MONTHLY_LIMIT,
  getProviderUsage,
  reserveGoogleIsochroneRequest,
  reserveProviderRequest,
  secondsUntilNextUtcMonth,
} from "@/db/isochrone-usage";
import {
  createReachabilityJob,
  deleteExpiredReachabilityJobs,
  deleteReachabilityJob,
  findReachabilityJob,
  updateReachabilityJob,
} from "@/db/reachability-jobs";
import {
  parseReachabilityRequest,
  reachabilityRequestKey,
  type ReachabilityRequest,
} from "@/app/reachability";
import { buildArcGisSubmitBody, ARCGIS_SERVICE_AREA_ENDPOINT, arcGisError } from "./arcgis";
import { MAX_REQUEST_BYTES, pendingResponse, providerHeaders } from "./shared";

const GOOGLE_ISOCHRONE_ENDPOINT =
  "https://isochrones.googleapis.com/v1/isochrones:generate";

function googleBody(request: ReachabilityRequest) {
  return {
    location: { latitude: request.latitude, longitude: request.longitude },
    travelDuration: `${request.durationMinutes * 60}s`,
    travelMode: "DRIVE",
    travelDirection: "FROM",
    routingPreference: "TRAFFIC_UNAWARE",
    enableSmoothing: true,
    polygonFidelity: "MEDIUM",
  };
}

async function handleGoogle(request: ReachabilityRequest) {
  const apiKey =
    process.env.GOOGLE_MAPS_SERVER_API_KEY ??
    (process.env.NODE_ENV === "development" ? process.env.GOOGLE_MAPS_API_KEY : undefined);
  if (!apiKey) {
    return Response.json(
      { error: "Google reachability is not configured." },
      { status: 503, headers: providerHeaders("google") },
    );
  }

  let usage;
  try {
    usage = await reserveGoogleIsochroneRequest();
  } catch {
    return Response.json(
      { error: "Reachability usage could not be verified, so the request was blocked." },
      { status: 503, headers: providerHeaders("google") },
    );
  }
  if (!usage) {
    return Response.json(
      { error: "The monthly Google reachability safety limit has been reached." },
      {
        status: 429,
        headers: providerHeaders("google", {
          limit: GOOGLE_ISOCHRONE_MONTHLY_LIMIT,
          period: "",
          remaining: 0,
          used: GOOGLE_ISOCHRONE_MONTHLY_LIMIT,
        }, { "Retry-After": String(secondsUntilNextUtcMonth()) }),
      },
    );
  }

  try {
    const upstream = await fetch(GOOGLE_ISOCHRONE_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Goog-Api-Key": apiKey },
      body: JSON.stringify(googleBody(request)),
    });
    if (!upstream.ok) {
      const messages: Record<number, string> = {
        400: "Google could not calculate that travel area.",
        401: "The Google reachability key is not authorized.",
        403: "Enable the Isochrones API and check the server-key restrictions.",
        404: "Move the starting point closer to a drivable road and try again.",
        429: "Google's short-term request quota has been reached. Try again soon.",
      };
      return Response.json(
        { error: messages[upstream.status] ?? "Google could not complete the request." },
        {
          status: upstream.status === 429 ? 429 : 502,
          headers: providerHeaders("google", usage),
        },
      );
    }
    const payload = (await upstream.json()) as { isochrone?: { geoJson?: unknown } };
    return Response.json(
      {
        status: "complete",
        provider: "google",
        durationMinutes: request.durationMinutes,
        geoJson: payload.isochrone?.geoJson,
      },
      { headers: providerHeaders("google", usage) },
    );
  } catch {
    return Response.json(
      { error: "Google's reachability service could not be reached." },
      { status: 502, headers: providerHeaders("google", usage) },
    );
  }
}

async function handleArcGis(request: ReachabilityRequest) {
  const apiKey = process.env.ARCGIS_API_KEY;
  if (!apiKey) {
    return Response.json(
      { error: "Long-range reachability is not configured." },
      { status: 503, headers: providerHeaders("arcgis") },
    );
  }

  const now = Math.floor(Date.now() / 1_000);
  const requestKey = reachabilityRequestKey(request);
  try {
    await deleteExpiredReachabilityJobs(now);
    const reusable = await findReachabilityJob(requestKey, now);
    if (reusable) {
      const usage = await getProviderUsage(
        ARCGIS_SERVICE_AREA_PROVIDER,
        ARCGIS_SERVICE_AREA_MONTHLY_LIMIT,
      );
      return pendingResponse(reusable.id, usage);
    }
  } catch {
    return Response.json(
      { error: "Long-range job storage is unavailable, so the request was blocked." },
      { status: 503, headers: providerHeaders("arcgis") },
    );
  }

  const id = crypto.randomUUID();
  try {
    const created = await createReachabilityJob({
      id,
      requestKey,
      latitude: request.latitude,
      longitude: request.longitude,
      durationMinutes: request.durationMinutes,
      now,
    });
    if (!created) {
      const reusable = await findReachabilityJob(requestKey, now);
      if (reusable) {
        const usage = await getProviderUsage(
          ARCGIS_SERVICE_AREA_PROVIDER,
          ARCGIS_SERVICE_AREA_MONTHLY_LIMIT,
        );
        return pendingResponse(reusable.id, usage);
      }
      throw new Error("The job could not be reserved.");
    }
  } catch {
    return Response.json(
      { error: "Long-range job storage is unavailable, so the request was blocked." },
      { status: 503, headers: providerHeaders("arcgis") },
    );
  }

  let usage;
  try {
    usage = await reserveProviderRequest(
      ARCGIS_SERVICE_AREA_PROVIDER,
      ARCGIS_SERVICE_AREA_MONTHLY_LIMIT,
    );
  } catch {
    await deleteReachabilityJob(id).catch(() => undefined);
    return Response.json(
      { error: "Long-range usage could not be verified, so the request was blocked." },
      { status: 503, headers: providerHeaders("arcgis") },
    );
  }
  if (!usage) {
    await deleteReachabilityJob(id).catch(() => undefined);
    return Response.json(
      { error: "The monthly long-range reachability safety limit has been reached." },
      {
        status: 429,
        headers: providerHeaders("arcgis", {
          limit: ARCGIS_SERVICE_AREA_MONTHLY_LIMIT,
          period: "",
          remaining: 0,
          used: ARCGIS_SERVICE_AREA_MONTHLY_LIMIT,
        }, { "Retry-After": String(secondsUntilNextUtcMonth()) }),
      },
    );
  }

  try {
    const upstream = await fetch(`${ARCGIS_SERVICE_AREA_ENDPOINT}/submitJob`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: buildArcGisSubmitBody(request, apiKey),
    });
    const payload = (await upstream.json()) as { jobId?: unknown };
    if (!upstream.ok || typeof payload.jobId !== "string") {
      const message = arcGisError(payload, "ArcGIS could not start that long-range area.");
      await updateReachabilityJob(id, { status: "failed", error: message });
      return Response.json(
        { error: message },
        { status: 502, headers: providerHeaders("arcgis", usage) },
      );
    }
    await updateReachabilityJob(id, {
      status: "submitted",
      providerJobId: payload.jobId,
    });
    return pendingResponse(id, usage);
  } catch {
    const message = "ArcGIS long-range reachability could not be reached.";
    await updateReachabilityJob(id, { status: "failed", error: message }).catch(() => undefined);
    return Response.json(
      { error: message },
      { status: 502, headers: providerHeaders("arcgis", usage) },
    );
  }
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
  const parsed = parseReachabilityRequest(input);
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
  return parsed.request.provider === "google"
    ? handleGoogle(parsed.request)
    : handleArcGis(parsed.request);
}
