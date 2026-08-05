export class ServerApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ServerApiError";
  }
}

export function apiErrorResponse(error: ServerApiError): Response {
  return Response.json({
    error: {
      code: error.code,
      message: error.message,
      ...(error.details ? { details: error.details } : {}),
    },
  }, { status: error.status });
}

export function isCancellationError(error: unknown): boolean {
  return (error instanceof DOMException && error.name === "AbortError")
    || (error instanceof Error && ["AbortError", "RouteSearchCancelledError"].includes(error.name));
}
