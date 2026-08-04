# P1 build-stage profile

Status: profiling complete; Gate E is **not** passed

Baseline builder: `e3600b9`
Profiled region: Bay Area — Midpen (`bay-midpen`)
Profile date: 2026-08-03 America/Los_Angeles

## Instrumentation

`scripts/trails/build-region.mjs` now accepts an opt-in `--telemetry=<path>`
argument and an injectable `createBuildStageTelemetry()` API. The CLI writes
newline-delimited JSON after every completed checkpoint. Each event has a
stable schema and sequence, the stage and phase, elapsed milliseconds, sorted
record counts, `heapUsed`, `heapTotal`, `external`, RSS, optional array-buffer
bytes, and labels for the structures retained at that checkpoint.

Telemetry is not added to the build input, result, payload map, QA, manifest,
or output directory. A deterministic injected-clock/memory test covers the
event contract. A profiled fixture build has the same payload bytes as an
unprofiled fixture build. In addition, the current builder and the unmodified
`e3600b9` builder produced byte-identical 39-file Gate C fixture output trees
(`diff -rq` had no output).

The instrumented stages are:

- snapshot loading and normalization;
- OSM topology construction;
- agency/OSM reconciliation and merge;
- elevation enrichment;
- provenance preparation and per-partition dictionary compaction;
- node, access-point, and named-trail construction;
- partitioning and JSON serialization;
- hashing and synchronous gzip measurement, sampled per artifact;
- QA.

The Midpen run did not reach partitioning, serialization, hashing, compression,
or QA. Fixture coverage proves those checkpoints, but their large-region peaks
remain unmeasured.

## Single Midpen diagnostic

The one authorized regional command was:

```text
env -u NODE_OPTIONS /usr/bin/time -l node scripts/trails/build-region.mjs \
  --region=bay-midpen \
  --input=/Users/mouradheddaya/Documents/alpine-search/.cache/trails/bay-midpen/build-input.json \
  --output=/private/tmp/alpine-search-midpen-p1-20260803 \
  --telemetry=/private/tmp/alpine-search-midpen-p1-20260803.ndjson
```

It used cached inputs, did not refresh sources, did not set a Node heap option,
and did not write into the cache. After the last checkpoint, the process spent
several minutes without completing named-trail construction. It was interrupted
once the total command time reached 601.40 seconds (496.31 user, 115.74 system).
No Midpen artifact output directory was created. This was the only Midpen run.

Durable measurements from the 15 telemetry events follow. MiB values use
1,048,576 bytes.

| Checkpoint | Elapsed | Counts | heapUsed | heapTotal | external | RSS |
| --- | ---: | --- | ---: | ---: | ---: | ---: |
| OSM topology begin | 0 s | 315,951 normalized OSM records | 315.5 MiB | 437.6 MiB | 2.0 MiB | 379.4 MiB |
| OSM topology end | 8.16 s | 286,192 segments; 275,816 nodes; 13,457 road nodes | 781.0 MiB | 855.8 MiB | 2.0 MiB | 504.5 MiB |
| Snapshot/normalization end | 9.84 s | 286,804 candidates; 275,816 nodes | 726.8 MiB | 855.4 MiB | 2.0 MiB | 507.0 MiB |
| Reconciliation sample | 15.94 s | 290,841 candidates; 43 issues | 484.3 MiB | 675.1 MiB | 2.0 MiB | 257.0 MiB |
| Merge sample | 227.74 s | 286,557 segments; 1,702 conflicts | 1,320.0 MiB | 1,422.4 MiB | 2.0 MiB | 328.5 MiB |
| Reconciliation/merge end | 228.38 s | 286,557 segments; 290,841 reconciled candidates | 1,410.9 MiB | 1,487.8 MiB | 2.0 MiB | 366.3 MiB |
| Elevation end | 24.11 s | 286,557 segments; 276,564 node elevations | 1,322.4 MiB | 1,410.4 MiB | 6.5 MiB | 176.2 MiB |
| Provenance preparation end | 22.08 s | 286,557 provenance records | 2,205.0 MiB | 2,347.1 MiB | 6.5 MiB | 1,109.0 MiB |
| Canonical nodes sample | 5.19 s | 276,564 nodes; 286,557 segments | 2,411.0 MiB | 2,532.1 MiB | 6.5 MiB | 503.4 MiB |
| Access-point sample / observed peak | 46.91 s | 13,492 access points; 276,564 nodes; 286,557 segments | **2,680.4 MiB** | **2,804.7 MiB** | 6.5 MiB | 363.9 MiB |

RSS is reported exactly as returned by `process.memoryUsage()` on this macOS
host and is not used to infer heap headroom. The last complete stage sample is
the reliable localization signal.

## Peak and retained structures

The observed peak is the node/access/named-trail construction stage, after
access-point construction and immediately before `buildNamedTrails()` could
complete. At that point the process retained the canonical segment array,
276,564 canonical nodes, 13,492 access points, and the full shipped field-
provenance object. The provenance copy is the largest measured step increase:
`shippedProvenance()` uses `structuredClone(mergeProvenance)` and then adds
elevation observations, increasing sampled `heapUsed` by about 878 MiB. Nodes
then added about 206 MiB and access construction another 269 MiB.

The stall is localized more narrowly by the last two samples. Canonical-node
and access-point work both completed. The next call is `buildNamedTrails()`,
which constructs a full adjacency map and precomputes `reachableNodes()` for
all 13,492 access points. `reachableNodes()` repeatedly sorts its pending array
after every insertion/removal. `componentGroups()` also obtains each component
seed with a copied and sorted `[...pending]` array. These repeated/copying sorts
run while segments, nodes, access points, and shipped provenance are retained.

The Midpen diagnostic never reached the existing all-artifact `payloads`
object. Consequently it provides no measured large-region string or gzip-
buffer peak. Static ownership is still explicit in telemetry: serialization
retains all serialized artifact strings, and each `gzipSync()` measurement
creates a synchronous gzip buffer while those strings and canonical records
remain live. Those are P2 targets, but they are downstream of the demonstrated
named-trail bottleneck.

## Implications for the next tasks

- P2 can remove the known all-payload string and synchronous gzip-buffer live
  sets, but it cannot by itself make this diagnostic reach serialization.
- If the same pre-serialization behavior remains after the accepted P2 writer,
  P3 should address the demonstrated named-trail reachability queue/sort and
  the full provenance clone rather than broadly rewriting topology.
- A later accepted task must rerun Midpen twice from the same cache to evaluate
  determinism and heap headroom. This P1 run is neither of those Gate E builds.
- No conclusion about 25% heap headroom, failure-safe publication, or Gate E is
  supported by this profile.

## Verification

```text
node --test tests/trails-build-region.test.mjs
# 9 passed, 0 failed

node --test tests/trails-*.test.mjs
# 71 passed, 0 failed

npm run lint
# passed

diff -rq /private/tmp/alpine-search-p1-baseline-output \
  /private/tmp/alpine-search-p1-current-output
# no output; 39 files byte-identical to e3600b9
```
