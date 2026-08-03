# Alpine Search

A responsive Bay Area driving-time map built with Google Maps and Google's
Isochrones API.

## Local development

```bash
npm install
npm run dev
```

Set `GOOGLE_MAPS_API_KEY` in `.env` for local development. The site supports
separate browser and server credentials through `GOOGLE_MAPS_BROWSER_API_KEY`
and `GOOGLE_MAPS_SERVER_API_KEY`.

## Cost safety

All isochrone requests go through `POST /api/isochrones`. The server atomically
reserves each upstream attempt in D1 before contacting Google, fails closed if
the counter is unavailable, and stops at **9,000 requests per UTC month**. This
leaves a 1,000-request buffer below Google's published 10,000-request monthly
free usage cap. Failed upstream attempts are conservatively counted.

For a deployment where the counter cannot be bypassed:

1. Restrict `GOOGLE_MAPS_BROWSER_API_KEY` to the deployed website, Maps
   JavaScript API, and Places API (New).
2. Use a different private `GOOGLE_MAPS_SERVER_API_KEY`, restricted to the
   Isochrones API. Never expose it in browser code or use it in another app.
3. In Google Maps Platform → Quotas, lower the Isochrones requests-per-minute
   quota to 10. This rate cap complements the monthly D1 ceiling.
4. Do not deploy using the single-key fallback; it exists only to make local
   development convenient.

Google currently lists Isochrones as free during pre-GA Preview and publishes a
10,000-request monthly free cap for GA pricing. Re-check the pricing page before
changing this guard.

## Validation

```bash
npm test
```
