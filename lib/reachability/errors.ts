export type ReachabilityErrorCode =
  | "INVALID_REQUEST"
  | "MALFORMED_JSON"
  | "PROVIDER_NOT_CONFIGURED"
  | "USAGE_UNAVAILABLE"
  | "USAGE_LIMIT_REACHED"
  | "PROVIDER_UNAUTHORIZED"
  | "PROVIDER_RATE_LIMITED"
  | "PROVIDER_UNAVAILABLE"
  | "PROVIDER_REJECTED"
  | "INVALID_PROVIDER_RESPONSE"
  | "REACHABILITY_FAILED"
  | "REQUEST_CANCELLED";

export class ReachabilityError extends Error {
  constructor(
    readonly code: ReachabilityErrorCode,
    message: string,
    readonly status: number,
    readonly retryable = false,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ReachabilityError";
  }
}

export function cancelledError(): ReachabilityError {
  return new ReachabilityError(
    "REQUEST_CANCELLED",
    "The request was cancelled.",
    499,
  );
}

export function toReachabilityError(error: unknown): ReachabilityError {
  if (error instanceof ReachabilityError) return error;
  if (error instanceof DOMException && error.name === "AbortError") return cancelledError();
  if (error instanceof Error && error.name === "AbortError") return cancelledError();
  return new ReachabilityError(
    "PROVIDER_UNAVAILABLE",
    "The ArcGIS service could not be reached.",
    502,
    true,
  );
}
