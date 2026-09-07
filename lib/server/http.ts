import { ReachabilityError } from "@/lib/reachability/errors";
import { apiErrorResponse, isCancellationError, ServerApiError } from "./api-error";

export function apiFailure(error: unknown, message: string): Response {
  if (error instanceof ServerApiError) return apiErrorResponse(error);
  if (isCancellationError(error)) return apiErrorResponse(new ServerApiError("REQUEST_CANCELLED", "The request was cancelled.", 499));
  if (error instanceof ReachabilityError) return apiErrorResponse(new ServerApiError(error.code, error.message, error.status));
  return apiErrorResponse(new ServerApiError("INTERNAL_ERROR", message, 500));
}

export async function readJsonBody(request: Request, maxBytes = 32_768): Promise<unknown> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null && /^\d+$/.test(contentLength) && Number(contentLength) > maxBytes) {
    throw new ServerApiError("REQUEST_TOO_LARGE", "Request body is too large.", 413);
  }

  const reader = request.body?.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let bytes = 0;
  if (reader) {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > maxBytes) {
          void reader.cancel().catch(() => undefined);
          throw new ServerApiError("REQUEST_TOO_LARGE", "Request body is too large.", 413);
        }
        chunks.push(decoder.decode(value, { stream: true }));
      }
      chunks.push(decoder.decode());
    } finally {
      reader.releaseLock();
    }
  }
  const text = chunks.join("");
  try { return JSON.parse(text); } catch { throw new ServerApiError("MALFORMED_JSON", "Request body must be valid JSON.", 400); }
}
