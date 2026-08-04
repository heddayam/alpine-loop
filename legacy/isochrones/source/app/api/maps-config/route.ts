export async function GET() {
  const apiKey =
    process.env.GOOGLE_MAPS_BROWSER_API_KEY ??
    (process.env.NODE_ENV === "development"
      ? process.env.GOOGLE_MAPS_API_KEY
      : undefined);

  if (!apiKey) {
    return Response.json(
      {
        error: {
          message: "A Google Maps browser key has not been configured.",
        },
      },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  return Response.json(
    { apiKey },
    { headers: { "Cache-Control": "no-store" } },
  );
}
