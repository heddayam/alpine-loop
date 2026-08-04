# P8 regional QA and Gate G evidence harness

Status: **offline harness ready; no P8 build, Gate G acceptance, publication, or activation performed**

The harness at `scripts/trails/verify-gate-g.mjs` prepares deterministic evidence for one P8 region
at a time. It validates both artifact-contract-v2 directories, compares the complete declared
artifact sets, extracts machine QA and access evidence, verifies the per-trail immutable geometry
contract and search-index linkage, and writes a compact review skeleton that always ends with
`Gate G accepted: NO`.

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
  --output=/Users/mouradheddaya/Documents/alpine-search/.cache/trails/p8-a/<region-id> \
  --telemetry=/Users/mouradheddaya/Documents/alpine-search/.cache/trails/<region-id>/p8-a-telemetry.ndjson

env -u NODE_OPTIONS node scripts/trails/build-region.mjs \
  --region=<region-id> \
  --input=/Users/mouradheddaya/Documents/alpine-search/.cache/trails/<region-id>/build-input.json \
  --output=/Users/mouradheddaya/Documents/alpine-search/.cache/trails/p8-b/<region-id> \
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

Generate the runtime search index from build A with the production builder. The search index is
separate from the artifact directory and must link its manifest, named-trail, canonical segment
index, and per-trail geometry index hashes:

```bash
node --input-type=module --eval='import { writeTrailSearchIndex } from "./scripts/trails/build-search-index.mjs"; await writeTrailSearchIndex("<region-id>", { artifactRoot: "/Users/mouradheddaya/Documents/alpine-search/.cache/trails/p8-a", outputRoot: "/Users/mouradheddaya/Documents/alpine-search/.cache/trails/p8-search-indexes" });'
```

After both builds, that search index, and the regional access evidence exist, run:

```bash
node scripts/trails/verify-gate-g.mjs \
  --region=<region-id> \
  --build-a=/Users/mouradheddaya/Documents/alpine-search/.cache/trails/p8-a/<region-id> \
  --build-b=/Users/mouradheddaya/Documents/alpine-search/.cache/trails/p8-b/<region-id> \
  --search-index=/Users/mouradheddaya/Documents/alpine-search/.cache/trails/p8-search-indexes/<region-id>.json \
  --access-evidence=/Users/mouradheddaya/Documents/alpine-search/.cache/trails/<region-id>/access-evidence.json \
  --max-total-object-reads=50 \
  --max-concurrent-reads=6 \
  --report=/Users/mouradheddaya/Documents/alpine-search/.cache/trails/<region-id>/gate-g-evidence.md
```

The values 50 total object reads and 6 concurrent reads are current deployment-plan review inputs,
not artifact-schema or permanent platform constants. Reverify and explicitly supply the applicable
limits before each Gate G review.

The frozen P6 adapter is modeled as seven sequential reads before geometry: `current.json`, the
manifest, named trails, access points, canonical segment index, per-trail geometry index, and runtime
search index. Selected geometry then performs one exact-key GET for the named trail's immutable
object. For every named trail the harness therefore reports:

- the exact `trail-geometry/<first-two-trail-id-hex>/<trail-id>.ndjson` path;
- exact raw and compressed selected-object bytes;
- estimated full-request reads (`7 + 1 selected object`);
- sequential maximum concurrency of one read;
- exact named-trail, geometry-index, and manifest coverage;
- the linked `trailGeometryIndexSha256` in the runtime search index;
- whether the supplied total-read and concurrent-read ceilings pass.

The canonical segment-prefix shards remain required runtime artifacts for later routing, but they
are not selected display geometry. The report records their per-trail fanout only to prove that the
selected endpoint remains one object. A pre-extension v2 build without
`manifest.delivery.lazyTrailGeometryIndex === "trail-geometry/index.json"` is blocked explicitly;
the harness reports its legacy segment-shard fanout and does not treat those shards as an acceptable
selected-geometry fallback.

An ordinary per-trail geometry object must remain at or below 8 MiB raw and 2 MiB compressed. An
exception must exactly match manifest path, raw bytes, compressed bytes, and a non-empty reviewed
note. Even a reviewed exception may not exceed the runtime hard cap of 16 MiB raw. The harness also
reports total raw/compressed bytes across the immutable per-trail geometry corpus and includes every
object in the two-build byte-identity evidence.

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
