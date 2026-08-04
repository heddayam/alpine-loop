import type { ReachabilityRequest } from "@/app/reachability";

export const ARCGIS_SERVICE_AREA_ENDPOINT =
  "https://logistics.arcgis.com/arcgis/rest/services/World/ServiceAreas/GPServer/GenerateServiceAreas";

export function buildArcGisSubmitBody(request: ReachabilityRequest, apiKey: string) {
  const body = new URLSearchParams();
  body.set("f", "json");
  body.set("token", apiKey);
  body.set(
    "facilities",
    JSON.stringify({
      geometryType: "esriGeometryPoint",
      spatialReference: { wkid: 4326 },
      features: [
        {
          geometry: { x: request.longitude, y: request.latitude },
          attributes: { Name: "Origin" },
        },
      ],
    }),
  );
  body.set("break_values", String(request.durationMinutes));
  body.set("break_units", "Minutes");
  body.set("travel_direction", "Away from Facility");
  body.set("impedance", "TravelTime");
  body.set("use_hierarchy", "false");
  body.set("detailed_Polygons", "false");
  body.set("polygon_detail", "Standard");
  body.set("output_format", "Feature Set");
  body.set("context", JSON.stringify({ outSR: { wkid: 4326 } }));
  return body;
}

export type ArcGisJobState = "pending" | "complete" | "failed";

export function arcGisJobState(status: unknown): ArcGisJobState {
  if (status === "esriJobSucceeded") return "complete";
  if (
    status === "esriJobFailed" ||
    status === "esriJobCancelled" ||
    status === "esriJobTimedOut"
  ) {
    return "failed";
  }
  return "pending";
}

export function arcGisError(payload: unknown, fallback: string): string {
  if (!payload || typeof payload !== "object") return fallback;
  const candidate = payload as {
    error?: { message?: unknown; details?: unknown };
    messages?: Array<{ description?: unknown }>;
  };
  if (typeof candidate.error?.message === "string") return candidate.error.message;
  const message = candidate.messages?.find(
    (entry) => typeof entry.description === "string",
  )?.description;
  return typeof message === "string" ? message : fallback;
}
