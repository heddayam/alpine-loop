# Entrance preparation performance follow-up

The user's completed Central Cascades build exposed two expensive access stages:
6m50s finding sparse starts and 8m47s ranking retained starts. Building rejection
was gone, but production still extracted, normalized, stored and counted buildings
for metadata that no map, search or route ranking used. Final ranking also rebuilt
source-wide entrance context after the admitted starts had already been frozen.
Both unnecessary paths are removed. Entrance policy remains `pedestrian-entry-v1`.

## Completed regional baseline

The user ran the build; the agent inspected its completed status and closed
published artifact. No new regional build, publication or installation was started.

| Recorded stage | Duration |
| --- | ---: |
| Finding sparse access points | 410,195 ms |
| Ranking retained access points | 527,068 ms |
| Combined | 937,263 ms (50.3% of total) |
| Entire build | 1,862,895 ms (31m03s) |

The 60,362 sparse candidates precede mountain qualification. That qualification
excluded 58,659, leaving **1,703 published starts**, including 216 outside-core
approaches. They are not 60,362 selectable app markers. The build retained
363,735 physical segments before compaction, reused metrics for 356,514 and measured
7,221, using five elevation tiles. Compact output has 11,897 nodes, 12,560 physical
edges and 25,120 directed edges. Measured peak memory was 2,767,142,912 bytes and
the cgroup peak reached the 4 GiB limit; this is no claim of ample memory headroom.

Closed normalized source inventory contained 2,117,197 ways, including
**1,337,866 building-only ways**. The expansion snapshot added 29,109 building-only
ways. Those objects no longer enter production normalization. Objects independently
tagged as roads, parking or passage context remain even if they also carry a
building tag; removing building geometry cannot erase their useful access facts.

## One evaluator, less work

1. Remove production building filters, relation completion, centroids, staging
   tables, spatial indexes and candidate counts. Keep historical comparison code
   isolated in the manually invoked research audit. It cannot affect admission.
2. Initial connected-entry discovery freezes candidates; mountain qualification
   retains the admitted starts. Final refresh reads only their selected outgoing measured links and
   original arrival assertions. Ordinary-road assertions use the source way's
   identity; typed parking/turnaround assertions use actual contacts and the
   node-leading membership index. Shared assertions load once per group.
3. Reuse prepared row statements with independent nested cursor lifetimes.
   Union-find stores its short path once instead of reading parents again during
   compression. Union roots, ranks and parent writes stay unchanged.

Frozen refresh still rejects removed/detached/restricted source roots, restricted
node passage, missing measured departures and loss of known access. It cannot
nominate another start, substitute a different root or upgrade uncertainty.
Unmeasured sidewalk context cannot become a hiking departure. Discovery without
frozen candidates continues through the full evaluator.

The indexed lookups follow SQLite's [query planning documentation](https://www.sqlite.org/queryplanner.html)
and [optimizer overview](https://www.sqlite.org/optoverview.html): use existing
identity and node-leading indexes and avoid repeating irrelevant rows. These
references explain the database mechanism; measured statement counts establish
the benefit here. Removing parent indexes or replacing the disk graph with a new
in-memory system was not justified by the bounded measurements and is not included.

## Comparison evidence

All measurements use isolated offline fixtures and disposable stores. Elapsed
times depend on the local machine; none predicts a new Central Cascades runtime.

| Comparison | Preserved output | Reduced work |
| --- | --- | --- |
| Ten committed original-source fixtures, normalization v14 → v15 | Exact movement/evidence and sparse entrance identities/witnesses | No building context |
| Full record ranking, 50,000 physical / 100,000 directed hiking links and 500 starts | Complete canonical record SHA-256 `c868a1568d00c7ce10f4fb351e369444a826de8c4fcb6224ce8e42e351cad9c8`, excluding only intentionally removed building metadata | Parent reads 849,996 → 599,999 (29.4% fewer); writes unchanged at 100,000 |
| Frozen refresh, disk-backed 100,507 nodes / 50,505 ways / 51,008 selected directed edges / 502 starts | All six runs match complete frozen-point plus refreshed-witness SHA-256 `244124a61b4a39ffb9732fc20368cea1018208344a16c93b871987d11f1462b8` | SQL method calls 406,062 → 7,564; scratch nodes 100,507 → 507; contacts 50,504 → 502; roots 50,503 → 502; links 51,008 → 504 |

The frozen-refresh benchmark alternates three baseline and three optimized runs
over the same disk database. Median preparation fell from 1,112.614 to 14.103 ms;
preparation plus every fixed-start refresh fell from 1,119.879 to 19.047 ms.
Observed heap was 16.84–18.30 MiB versus 10.41–10.96 MiB. Shared-process retained
RSS cannot establish a memory improvement for a constrained regional build.

The portal-only 50,000-link comparison kept the old broad proof refresh in both
runs to isolate its changes: one ranking pair was 6,085.591 → 5,816.941 ms. This
is deterministic read-count evidence with one timing pair, not a statistical
speed result. It must not be combined with the separate frozen-refresh ratio
to forecast regional speed.

An integrated replay on `846554b` of that same 50,000-link fixture retains the
exact optimized full-record hash and canonical baseline hash. One ranking run
took 2,979.368 ms, including 32.664 ms for measured-entry refresh versus the
baseline's 3,338.207 ms. It ran alongside integration tests; this is combined
output parity and phase-scope evidence, not a controlled timing estimate.

Ignored reproduction evidence is under `.cache/access-entry-performance/`:
`ranking/diagnose.ts`, `ranking/portal-optimization-report.md`, baseline/optimized
JSONs, and the closed-artifact audit below. Frozen refresh has its independent
benchmark script/results in `frozen-refresh/`. Committed tests cover cancellation,
retry, direction, node passage, shared typed roots and building-tag noise from
zero to 1,000 surrounding objects; building SQL reads are forbidden in the
production portal regression fixture.

Replay the current bounded fixtures from the repository root with
`RANKING_BENCH_NAME=combined node --import tsx .cache/access-entry-performance/ranking/diagnose.ts 50000 100000`
and `node --expose-gc --import tsx .cache/access-entry-performance/frozen-refresh/benchmark.mts`.
These scripts prepare synthetic scratch only, not regional packs.

## Publication and compatibility

The user's Central artifact is
`fa5a035a58404f8627599571338d925884734803426fd0d457165c171d998d82`,
graph `area-3f2bdcc302bf232a5852e58733203bf5`, raw 80,617,472 bytes, gzip
26,384,256 bytes. Raw/compressed identities and the semantic audit receipt match.
Inspection ran in a network-disabled read-only container on the sealed artifact:
SQLite integrity is `ok`, foreign-key errors and duplicate entrance nodes are zero,
and all 1,703 starts have valid witnesses (259 public, 1,444 unknown). Every usable
directed edge respects its endpoint foot flags. This proves structural consistency,
not regional precision/recall or appealing hike quality.

Evidence: `artifact/central-fa5a035a-rcmbd3/{identity,integrity,source-inventory,source-cleanup-v15-parity}.json`.

Source normalization v15 invalidates the obsolete normalized building context on
the next build. Verified original downloads, elevation tiles, measured segment
caches and already published artifacts remain intact. Schema 7 retains its old
building-count column as nullable historical metadata: new points write null,
readers omit the field, and old numerical values stay readable. Production-schema
export/read tests cover both null and historical numbers. Update the app before
installing newly built packs. Existing Central Cascades remains valid for the
unchanged entrance policy.

The user will run the next regional build and monitor the result. Regional speed
and peak resource improvements remain unmeasured; independently labeled regional
accuracy is a separate outstanding acceptance gate.

## Integration verification

On integrated source `846554b`, two complete `npm run verify` runs pass all
1,388 tests in 114 files, lint, types, MapLibre asset checks and production app
builds. Two `npm run test:browser` runs pass all 11 desktop/mobile flows each.
Logs are `/private/tmp/alpine-access-perf-verify-host-{1,2}.log` and
`/private/tmp/alpine-access-perf-browser-{1,2}.log`.

The initial sandboxed verification could not call macOS process identity checks;
the focused 27-case installation rerun and both complete host runs pass. No
application change was needed for that environment restriction. All completed
task worktrees/branches are removed, and generated benchmark/audit evidence
remains ignored. Existing publications, installations and unrelated worktrees
were preserved.
