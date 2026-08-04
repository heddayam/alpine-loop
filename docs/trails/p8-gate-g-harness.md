# P8 regional QA and Gate G evidence harness

Status: **offline harness ready; no P8 build, Gate G acceptance, publication, or activation performed**

The harness at `scripts/trails/verify-gate-g.mjs` prepares deterministic evidence for one P8 region
at a time. It validates both artifact-contract-v2 directories, compares the complete declared
artifact sets, extracts machine QA and access evidence, measures selected-trail geometry fanout, and
writes a compact review skeleton that always ends with `Gate G accepted: NO`.

It does not alter either artifact directory, accept QA, publish objects, change an active pointer, or
activate a region.

## Audited local prerequisites

The ignored cache under `/Users/mouradheddaya/Documents/alpine-search/.cache/trails` was inspected
read-only on 2026-08-04. No source was refreshed and no regional build was run.

| Region | Cache size | Build-input references | 3DEP tiles | Declared snapshot files | Availability |
| --- | ---: | ---: | ---: | ---: | --- |
| Bay Area — Midpen | 1.7 GB | 5 | 9 | 6 | complete and hash/size verified |
| Bay Area — East Bay | 382 MB | 7 | 9 | 8 | complete and hash/size verified |
| Sierra National Forest | 149 MB | 5 | 16 | 6 | complete and hash/size verified |
| Tahoe–Eldorado | 215 MB | 6 | 16 | 7 | complete and hash/size verified |

For every region:

- `.refresh-complete.json` and `build-input.json` declare the expected region ID.
- The OSM snapshot, agency snapshots, 3DEP index, source manifest, and every indexed float32 tile
  exist. Declared bytes and SHA-256 values match.
- The shared California PBF exists at `bay-midpen/osm/california-latest.osm.pbf`, is
  1,322,536,987 bytes, and has SHA-256
  `7fbcd9433a0aeddf769a836fd68bda599a8ceffcd33b977e5e98909242334558`.

Each `artifacts-a` directory is the blocked T8 first build using schema v1. Those directories are
historical evidence only. They must not be reused as either P8 artifact-v2 build or published.

## Region-by-region build commands

Run regions sequentially in the Phase 2 order. For each region, substitute its ID below and run
exactly two offline builds from the same audited `build-input.json`. Keep Node's default heap and
remove any inherited heap-related `NODE_OPTIONS`:

```bash
env -u NODE_OPTIONS node scripts/trails/build-region.mjs \
  --region=<region-id> \
  --input=/Users/mouradheddaya/Documents/alpine-search/.cache/trails/<region-id>/build-input.json \
  --output=/Users/mouradheddaya/Documents/alpine-search/.cache/trails/<region-id>/artifacts-p8-a \
  --telemetry=/Users/mouradheddaya/Documents/alpine-search/.cache/trails/<region-id>/p8-a-telemetry.ndjson

env -u NODE_OPTIONS node scripts/trails/build-region.mjs \
  --region=<region-id> \
  --input=/Users/mouradheddaya/Documents/alpine-search/.cache/trails/<region-id>/build-input.json \
  --output=/Users/mouradheddaya/Documents/alpine-search/.cache/trails/<region-id>/artifacts-p8-b \
  --telemetry=/Users/mouradheddaya/Documents/alpine-search/.cache/trails/<region-id>/p8-b-telemetry.ndjson
```

Use these IDs, one focused QA branch at a time:

1. `bay-midpen`
2. `bay-east`
3. `sierra-national-forest`
4. `tahoe-eldorado`

Do not run a third build to reconfirm unchanged evidence. A failed build must be investigated before
another attempt, and no incomplete output may be presented as a completed build.

## Access-budget input

The optional access evidence is a JSON object containing the parsed maximum-result search response
and the low-zoom marker models produced from that same regional catalog:

```json
{
  "searchResponse": {
    "regionId": "bay-midpen",
    "count": 0,
    "trails": []
  },
  "lowZoomMarkers": []
}
```

The harness serializes `searchResponse` with `JSON.stringify` and measures its UTF-8 bytes against
the reviewed 448 KiB limit. It counts `lowZoomMarkers` against the reviewed 200-marker limit. An
omitted evidence file leaves this Gate G item blocked; hand-entered byte or marker totals are not
accepted as substitutes for the measured structures.

## Gate G evidence command

After both builds and the regional access evidence exist, run:

```bash
node scripts/trails/verify-gate-g.mjs \
  --region=<region-id> \
  --build-a=/Users/mouradheddaya/Documents/alpine-search/.cache/trails/<region-id>/artifacts-p8-a \
  --build-b=/Users/mouradheddaya/Documents/alpine-search/.cache/trails/<region-id>/artifacts-p8-b \
  --access-evidence=/Users/mouradheddaya/Documents/alpine-search/.cache/trails/<region-id>/access-evidence.json \
  --max-total-object-reads=50 \
  --max-concurrent-reads=6 \
  --report=/Users/mouradheddaya/Documents/alpine-search/.cache/trails/<region-id>/gate-g-evidence.md
```

The values 50 total object reads and 6 concurrent reads are current deployment-plan review inputs,
not artifact-schema or permanent platform constants. Reverify and explicitly supply the applicable
limits before each Gate G review.

The current P6 adapter is modeled as six fixed object reads before geometry (`current.json`, the
manifest, and four runtime metadata objects), with up to four metadata reads concurrent. Its current
geometry loader fans all distinct segment shards out concurrently. For every named trail the harness
therefore reports:

- distinct geometry shard/object reads;
- estimated raw and compressed geometry bytes read;
- estimated full-request reads (`6 + geometry objects`);
- estimated maximum concurrency (`max(4, geometry objects)`);
- whether the selected display geometry resolves to exactly one immutable geometry object;
- whether the supplied total-read and concurrent-read ceilings pass.

The accepted delivery contract is one immutable selected-display-geometry object per trail. An
ordinary object must remain at or below 8 MiB raw and 2 MiB compressed; only a manifest-declared,
reviewed exception may exceed those sizes. The current segment-prefix layout can spread a trail over
many objects, so this check is expected to expose a Gate F blocker until the delivery design is
corrected. The P8 harness does not change the artifact or runtime contracts itself.

## Manual review that remains mandatory

For each region, a human reviewer must still inspect source counts, conflict and snap details,
isolated components, retained access/pipeline issues, representative named trails, canonical access
points, elevation outliers, and product treatment. The human report may say `PASS` or
`PASS WITH DOCUMENTED EXCEPTIONS` only after that review. The integrator must then independently
review the report and manifest.

Tahoe–Eldorado has an additional non-optional section. The harness records observed edge and
aggregate elevation flags beside the T8 baseline of 35 edge flags and one aggregate flag, and leaves
their disposition blank. Every flag and any count change must be resolved or documented before the
region can be proposed for Gate G acceptance.
