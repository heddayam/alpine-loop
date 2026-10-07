export async function request<T>(
  url: string,
  signal: AbortSignal,
  body?: unknown,
  method?: string,
): Promise<T> {
  const response = await fetch(url, {
    signal,
    cache: "no-store",
    ...(method ? { method } : {}),
    ...(body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok)
    throw Object.assign(
      new Error(
        response.status === 404
          ? "This saved job or route is no longer available."
          : typeof data?.error === "string"
            ? data.error
            : (data?.message ??
              data?.error?.message ??
              "The server could not complete this request."),
      ),
      {
        status: response.status,
        sections: data?.missing ?? data?.sections,
        bytes: data?.bytes,
      },
    );
  return data as T;
}

