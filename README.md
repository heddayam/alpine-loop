# Alpine Search

A responsive Northern California driving-time map built with Google Maps,
Google Isochrones for short trips, and ArcGIS Service Areas for trips up to
five hours.

## Local development

```bash
npm install
npm run dev
```

Set `GOOGLE_MAPS_API_KEY` in `.env` for local development. The site supports
separate browser and server credentials through `GOOGLE_MAPS_BROWSER_API_KEY`
and `GOOGLE_MAPS_SERVER_API_KEY`. Set the server-only `ARCGIS_API_KEY` to enable
long-range service areas from 75 minutes through five hours.

## Cost safety

All map requests go through `POST /api/reachability`. The server atomically
reserves each upstream attempt in D1 before contacting either provider, fails
closed if the counter is unavailable, and stops Google at **9,000 requests per
UTC month**. This leaves a 1,000-request buffer below Google's published
10,000-request monthly free usage cap. Failed upstream attempts are
conservatively counted.

Long-range ArcGIS submissions use the same fail-closed D1 guard and stop at
**4,500 service areas per UTC month**, leaving a 500-request buffer below the
published 5,000-request free allowance. Reusable jobs prevent retries for the
same origin and duration from creating duplicate submissions.

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

## Hiking trail data spike

Render the cached audit comparing representative USGS, USFS, NPS, California
State Parks, East Bay Regional Park District, and OpenStreetMap data:

```bash
npm run trails:audit
```

This command does not contact the remote services, so it stays fast during
normal development. Refresh everything only when the underlying data needs to
be sampled again:

```bash
npm run trails:audit:refresh
```

To refresh one flaky or recently changed source without waiting for the others,
use its source ID, for example `npm run trails:audit -- --refresh=usfs` or
`npm run trails:audit -- --refresh=osm`.

The audit writes a machine-readable report to `data/trails/coverage-spike.json`
and a review document to `docs/trails/coverage-spike.md`. It does not modify the
application database or UI.

## Hiking trail regional artifacts

The Gate C pilot is a deliberately small Happy Isles–Mist Trail corridor. Its
only networked operation is the explicit preparation command below. It queries
the public NPS trail layer, the bounded OpenStreetMap map API (not Overpass),
and the USGS 3DEP ImageServer, then writes all raw and prepared inputs beneath
the ignored `.cache/trails/` tree:

```bash
npm run trails:pilot:refresh
```

After preparation, build the pilot offline. Keep its outputs in the cache; the
small corridor is validation evidence, not the final Yosemite–Stanislaus
regional artifact:

```bash
node scripts/trails/build-region.mjs \
  --region=yosemite-stanislaus \
  --input=.cache/trails/yosemite-stanislaus/gate-c-pilot/build-input.json \
  --output=.cache/trails/yosemite-stanislaus/gate-c-pilot/artifacts
```

Regional ingestion applies one conservative rule: a segment, source node, or
access candidate is omitted unless all of its coordinates are inside the
configured region bounds. Every omission is recorded in `qa.json`; crossing
features are not clipped or accepted silently. Agency lines that are fully
covered by compatible nearby OSM edges are split and snapped to those OSM
edges. Partial or ambiguous matches stay unsplit and are reported for review.

Build the Yosemite–Stanislaus static trail corpus from cached input only:

```bash
npm run trails:build
```

The default input is
`.cache/trails/yosemite-stanislaus/build-input.json`; raw agency snapshots, the
OSM extract, and the local 3DEP window stay outside version control. The input
object accepts `agencySnapshots` keyed by provider, `osmSnapshotPath`,
`accessPointCandidates`, `publicRoadNodeIds`, and an optional
`elevationGridPath`. It also accepts already normalized `segmentCandidates` and
`sourceNodes`. Snapshot and grid paths are relative to the input file. Use
explicit paths for another cached build or output directory:

```bash
node scripts/trails/build-region.mjs \
  --region=yosemite-stanislaus \
  --input=.cache/trails/yosemite-stanislaus/build-input.json \
  --output=data/trails/generated/yosemite-stanislaus
```

The build writes `manifest.json`, `named-trails.json`,
`access-points.geojson`, `segments.ndjson`, `nodes.ndjson`,
`segment-provenance.json`, and `qa.json`. The provenance sidecar records the
selected and losing observations for each normalized field, including 3DEP
calculation metadata.
Artifact ordering, timestamps, and SHA-256 hashes are derived from cached source
data, so repeated builds from the same input are byte-for-byte identical. Review
`qa.json` before using a newly generated corpus in the application.
