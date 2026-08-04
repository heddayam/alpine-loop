import { arcGisFeatureSetToGeoJson, type ArcGisFeatureSet } from "@/app/arcgis";
import {
  ARCGIS_SERVICE_AREA_MONTHLY_LIMIT,
  ARCGIS_SERVICE_AREA_PROVIDER,
  getProviderUsage,
} from "@/db/isochrone-usage";
import {
  deleteReachabilityJob,
  getReachabilityJob,
  updateReachabilityJob,
} from "@/db/reachability-jobs";
import {
  ARCGIS_SERVICE_AREA_ENDPOINT,
  arcGisError,
  arcGisJobState,
} from "../arcgis";
import { pendingResponse, providerHeaders } from "../shared";

const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function usage() {
  return getProviderUsage(
    ARCGIS_SERVICE_AREA_PROVIDER,
    ARCGIS_SERVICE_AREA_MONTHLY_LIMIT,
  );
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ requestId: string }> },
) {
  const { requestId } = await context.params;
  if (!REQUEST_ID_PATTERN.test(requestId)) {
    return Response.json({ error: "That reachability request is invalid." }, { status: 400 });
  }

  let job;
  try {
    job = await getReachabilityJob(requestId);
  } catch {
    return Response.json(
      { error: "Long-range job storage is unavailable." },
      { status: 503, headers: providerHeaders("arcgis") },
    );
  }
  if (!job) {
    return Response.json(
      { error: "That reachability request was not found." },
      { status: 404, headers: providerHeaders("arcgis") },
    );
  }
  const now = Math.floor(Date.now() / 1_000);
  if (job.expiresAt <= now) {
    await deleteReachabilityJob(job.id).catch(() => undefined);
    return Response.json(
      { error: "That long-range request has expired. Calculate it again." },
      { status: 410, headers: providerHeaders("arcgis") },
    );
  }
  if (job.status === "failed") {
    return Response.json(
      { error: job.error ?? "The long-range calculation failed." },
      { status: 502, headers: providerHeaders("arcgis", await usage()) },
    );
  }
  if (!job.providerJobId) {
    if (now - job.createdAt > 60) {
      await updateReachabilityJob(job.id, {
        status: "failed",
        error: "The long-range request could not be submitted.",
      });
      return Response.json(
        { error: "The long-range request could not be submitted." },
        { status: 502, headers: providerHeaders("arcgis", await usage()) },
      );
    }
    return pendingResponse(job.id, await usage());
  }

  const apiKey = process.env.ARCGIS_API_KEY;
  if (!apiKey) {
    return Response.json(
      { error: "Long-range reachability is not configured." },
      { status: 503, headers: providerHeaders("arcgis") },
    );
  }

  try {
    const statusUrl = `${ARCGIS_SERVICE_AREA_ENDPOINT}/jobs/${encodeURIComponent(job.providerJobId)}`;
    const statusResponse = await fetch(
      `${statusUrl}?f=json&token=${encodeURIComponent(apiKey)}`,
      { headers: { Accept: "application/json" } },
    );
    const statusPayload = (await statusResponse.json()) as { jobStatus?: unknown };
    if (!statusResponse.ok) throw new Error(arcGisError(statusPayload, "ArcGIS job polling failed."));
    const state = arcGisJobState(statusPayload.jobStatus);
    if (state === "pending") {
      await updateReachabilityJob(job.id, { status: String(statusPayload.jobStatus ?? "pending") });
      return pendingResponse(job.id, await usage());
    }
    if (state === "failed") {
      const message = arcGisError(statusPayload, "ArcGIS could not calculate that long-range area.");
      await updateReachabilityJob(job.id, { status: "failed", error: message });
      return Response.json(
        { error: message },
        { status: 502, headers: providerHeaders("arcgis", await usage()) },
      );
    }

    const resultResponse = await fetch(
      `${statusUrl}/results/service_areas?f=json&token=${encodeURIComponent(apiKey)}`,
      { headers: { Accept: "application/json" } },
    );
    const resultPayload = (await resultResponse.json()) as {
      value?: ArcGisFeatureSet | { service_areas?: ArcGisFeatureSet };
      service_areas?: ArcGisFeatureSet;
    };
    if (!resultResponse.ok) {
      throw new Error(arcGisError(resultPayload, "ArcGIS result retrieval failed."));
    }
    const value = resultPayload.value;
    const nestedFeatureSet =
      value &&
      "service_areas" in value &&
      value.service_areas &&
      Array.isArray(value.service_areas.features)
        ? value.service_areas
        : null;
    const directFeatureSet =
      value && "features" in value && Array.isArray(value.features) ? value : null;
    const featureSet = resultPayload.service_areas ?? nestedFeatureSet ?? directFeatureSet;
    const geoJson = featureSet ? arcGisFeatureSetToGeoJson(featureSet) : null;
    if (!geoJson) throw new Error("ArcGIS returned an empty long-range area.");
    await updateReachabilityJob(job.id, { status: "succeeded" });
    return Response.json(
      {
        status: "complete",
        provider: "arcgis",
        durationMinutes: job.durationMinutes,
        geoJson,
      },
      { headers: providerHeaders("arcgis", await usage()) },
    );
  } catch (caught) {
    return Response.json(
      { error: caught instanceof Error ? caught.message : "ArcGIS could not be reached." },
      { status: 502, headers: providerHeaders("arcgis", await usage().catch(() => undefined)) },
    );
  }
}
