import type { UsageReservation } from "@/db/isochrone-usage";

export const MAX_REQUEST_BYTES = 16_384;
export const POLL_AFTER_SECONDS = 2;

export function providerHeaders(
  provider: "google" | "arcgis",
  usage?: UsageReservation,
  extra?: HeadersInit,
) {
  const headers = new Headers(extra);
  headers.set("Cache-Control", "no-store");
  headers.set("X-Reachability-Provider", provider);
  if (usage) {
    headers.set("X-RateLimit-Limit", String(usage.limit));
    headers.set("X-RateLimit-Remaining", String(Math.max(0, usage.remaining)));
  }
  return headers;
}

export function pendingResponse(requestId: string, usage?: UsageReservation) {
  return Response.json(
    {
      status: "pending",
      provider: "arcgis",
      requestId,
      pollAfterMs: POLL_AFTER_SECONDS * 1_000,
    },
    {
      status: 202,
      headers: providerHeaders("arcgis", usage, {
        "Retry-After": String(POLL_AFTER_SECONDS),
      }),
    },
  );
}
