# T8 regional expansion evidence

Run date: 2026-08-03 (source timestamps and artifacts use 2026-08-04 UTC)

Status: **regional preparation and first builds complete; production publication blocked**

T8 expanded the shared trail-data workflow to Bay Area — Midpen, Bay Area —
East Bay, Sierra National Forest, and Tahoe–Eldorado. Region configuration now
selects the audited official-agency snapshots; OSM extraction, access-point
construction, elevation enrichment, normalization, merge, QA, and artifact
serialization remain common code.

Raw snapshots and generated review builds remain beneath the ignored
`.cache/trails/` tree. They are not committed.

## Source preparation

| Region | USGS | USFS | NPS | State Parks | EBRPD | OSM hiking ways | OSM access candidates | 3DEP tiles |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Bay Area — Midpen | 298 | — | — | 314 | — | 40,112 | 37 | 9 |
| Bay Area — East Bay | 72 | — | 1 | 57 | 584 | 25,753 | 4 | 9 |
| Sierra National Forest | 747 | 373 | — | — | — | 509 | 25 | 16 |
| Tahoe–Eldorado | 2,397 | 532 | — | 218 | — | 2,202 | 27 | 16 |

The California State Parks hosted feature service rejected 200-record geometry
pages even though its metadata advertised a larger record limit. A
source-specific 50-record refresh page made all three configured State Parks
snapshots reproducible without changing normalization.

One checksum-verified California Geofabrik PBF was reused by path for every
region. Its 2026-08-03 dated snapshot was 1,322,536,987 bytes and matched the
published MD5 `40ea2dbe67093664db64b62fbb1b14c9`.

## First-build results

| Region | Segments | Nodes | Access points | Named components | Elevation | Edge/window flags | Raw | Gzip |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Bay Area — Midpen | 286,557 | 276,564 | 13,492 | 406 | 100% | 3 / 0 | 446,578,019 B | 85,672,358 B |
| Bay Area — East Bay | 198,925 | 195,840 | 9,834 | 379 | 100% | 2 / 0 | 318,389,472 B | 62,540,840 B |
| Sierra National Forest | 28,124 | 29,018 | 102 | 41 | 100% | 3 / 0 | 79,380,199 B | 21,052,710 B |
| Tahoe–Eldorado | 76,434 | 77,999 | 601 | 310 | 100% | 35 / 1 | 148,784,565 B | 31,625,365 B |
| **Total** | **590,040** | **579,421** | **24,029** | **1,136** | **100%** | **43 / 1** | **993,132,255 B** | **200,891,273 B** |

All searchable named components have connected access by construction. Access
is predominantly low-confidence derived public-road evidence in the Bay
regions: Midpen has 35 mapped and 13,457 derived points; East Bay has 4 mapped
and 9,830 derived points. Sierra has 22 mapped and 80 derived points; Tahoe has
22 mapped and 579 derived points. None is promoted to official.

The first builds preserve reviewable issues rather than hiding them. Counts
include conservative out-of-region omissions, disconnected or ambiguous access
candidates, ambiguous topology reconciliation, field-level merge conflicts,
and the elevation flags shown above. Tahoe's 35 edge flags and one aggregate
flag require manual review before its corpus is accepted for product use.

## Scale findings and publication decision

Two regional-scale orchestration defects were fixed:

1. Large OSM topology arrays are concatenated without variadic `push`, which
   overflowed the JavaScript call stack on Midpen.
2. QA no longer retains every connected component's segment list or every
   aggregate elevation window after it has been evaluated.

A repeat Midpen build still exceeded V8's default approximately 4 GB heap in a
later large-array sort. The first build completed, but repeat builds are not yet
reliable enough to claim byte-for-byte determinism at the heaviest T8 scale.
Increasing `--max-old-space-size` was deliberately not accepted as the normal
workflow. The remaining serializer/build-stage peak must be profiled and made
streaming or otherwise bounded.

The four payloads total about 993 MB raw and 201 MB gzip, before the accepted
Yosemite–Stanislaus corpus is included. They should not be added to Git or made
eager static assets. Choose versioned external artifact storage or another
reviewed delivery mechanism, then repeat deterministic builds and manual QA
before publishing the T8 corpora.

## Commands

The only networked step was explicit source preparation:

```bash
npm run trails:region:refresh -- --region=bay-midpen
npm run trails:region:refresh -- --region=bay-east \
  --osm-pbf=.cache/trails/bay-midpen/osm/california-latest.osm.pbf
npm run trails:region:refresh -- --region=sierra-national-forest \
  --osm-pbf=.cache/trails/bay-midpen/osm/california-latest.osm.pbf
npm run trails:region:refresh -- --region=tahoe-eldorado \
  --osm-pbf=.cache/trails/bay-midpen/osm/california-latest.osm.pbf
```

Each first build used the same offline command shape:

```bash
node scripts/trails/build-region.mjs \
  --region=<region-id> \
  --input=.cache/trails/<region-id>/build-input.json \
  --output=.cache/trails/<region-id>/artifacts-a
```
