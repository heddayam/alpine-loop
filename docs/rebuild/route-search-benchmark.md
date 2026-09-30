# Current route-search benchmark

The harness is `scripts/research/current-route-search-benchmark.ts`. It exercises
schema-7 `PreparedGraphRepository`, prepared start selection, per-start search,
authoritative route validation, and final retention. It does not use the retired
schema-6 reader or measure the job coordinator/browser.

## Reproduction

Run serially against a stable checkout with the same dependencies. The harness
binds transitive TypeScript imports to `--solver-root`, records its commit and
source fingerprint, and rejects changed graph/solver files. An explicit
`--allow-dirty=true` permits a development probe but marks its report provisional;
those samples must be repeated before acceptance.

```sh
node --import tsx scripts/research/current-route-search-benchmark.ts \
  --solver-root=/path/to/checkout \
  --suite=published \
  --release=/path/to/prepared/release.json \
  --regions=santa-cruz-mountains,snoqualmie-region \
  --mode=fixed-work --repeats=3 \
  --output=.cache/route-search-benchmark/fixed-work.json
```

Use `--mode=deadline` for the production 15-second / 500,000-state budget. The
fixed-work default uses 50,000 expanded states with the solver clock disabled;
both retain the production 8,000 raw-candidate and 40,000 loaded-edge caps. The
reader's real 15-second safety timeout remains active in fixed-work mode. A
sample hitting that timeout is not an equal-work comparison. Cap counters can
also represent different work after an algorithm change, so compare recorded
expansions, routes, and phases together rather than treating a fixed cap as
identical CPU work.

Only sealed, published `.sqlite.gz` objects are read. Each is decompressed into a
private temporary directory, checked against the catalog's uncompressed SHA-256
and byte count, and opened read-only. The temporary directory is removed on exit.
The harness never opens a live build database, installs coverage, publishes a
release, or requests network data. JSON output belongs in ignored storage.

The fixture suite needs no regional data:

```sh
node --import tsx scripts/research/current-route-search-benchmark.ts \
  --solver-root=/path/to/checkout --suite=fixtures \
  '--case=fixture/(grid-8|tiny-side-loop-connector|gain-near|no-repetition|grade-near|stem-cap)$' \
  --mode=fixed-work --repeats=3 \
  --output=.cache/route-search-benchmark/fixtures.json
```

These deterministic graphs are promoted to schema 7 and queried through the
production prepared reader. They carry complete elevation profiles, including
non-flat heights. The grid has three neighboring starts to exercise repeated
reads; other cases cover a bridge between cycles and gain, grade, repetition,
and shared-approach constraints. Fixtures test algorithm behavior, not realistic
terrain geometry or a regional completeness claim.

## Regional sample

The 2026-09-30 comparison uses release
`release-de350c0a36690ca14577c4710cf75b5d`, with these immutable artifacts:

| Region | Uncompressed artifact SHA-256 | Bytes |
| --- | --- | ---: |
| Santa Cruz Mountains | `880dab3b314d1be687684a5e2111b5cca9ad26a9802038efb8ed9c36e212e655` | 28,200,960 |
| Snoqualmie region | `18395b01529da2f5479379f7d010d9153725f0622635dd0fe94bcf93df9d5995` | 67,096,576 |

Each request asks for 3–8 miles, includes unknown access, and permits either 0%
or 35% repeated trail. Starts are selected from persisted topology hints before
comparing the revised solver: exclude components with less than 5 km of trail;
take the most connected on-cycle start, the median on-cycle start, and the
shortest nonzero approach up to one mile. Stable IDs break ties. Additional
requested starts fill from the same sorted candidate set.

| Region | Start node ID (access ID has `portal:osm-node-` prefix) |
| --- | --- |
| Santa Cruz Mountains | `2277745095`, `65425280`, `3297929571` |
| Snoqualmie region | `12053857534`, `3924732444`, `9669556494` |

The initial component threshold removed a 181-metre isolated component during
baseline inspection; it was fixed before any revised-solver measurement.
This is a deliberately small topology-stratified sample, not a random sample or
a complete regional search.

## What is measured

Each criteria case creates one repository and one prepared search session, then
runs its selected starts serially for three passes. The first pass begins with
a fresh reader cache; later starts and passes can reuse decoded records. The OS
file cache is not flushed. Repository construction and candidate preparation are
reported separately from per-start search time.

Graph-load timing wraps the real repository call. Generation and validation
wall times use the existing phase callback boundaries and include the small
amount of setup between callbacks. Hashing and route summaries happen after the
search timing/deadline ends. Input fingerprints cover artifact content, criteria,
starts, geometry, and budget; loaded-graph fingerprints show whether both versions
actually searched the same graph.

Results apply the product retention rule: up to ten exact routes per start, or
one labeled close match. The report records exact counts and distinct physical
loop counts separately, since multiple baseline routes may describe one physical
loop. It also records repeated-approach length, deviation from the requested
distance midpoint, violations, truncation reasons, and the retained loop IDs.
Distance-midpoint deviation is descriptive: a shorter approach can be preferable
even when its distance is farther from the midpoint, and both routes can satisfy
the complete requested range.

RSS is sampled at phase boundaries; process peak RSS also includes catalog
parsing, decompression, source loading, fingerprints, and earlier cases. It is
not an isolated worker-memory measurement. Time-to-first-exact diagnostics refer
to engine validation, not publication to a user interface.

Finite budgets, greedy diversity selection, and the ten-route cap make regional
results a discovery comparison, not a proof that every feasible physical loop
was found. Exhaustive completeness claims belong to the independent tiny-graph
oracle tests. The same caveat applies when a real-data run reports no truncation:
that does not certify every possible retained ranking or all regional hikes.

## Accepted comparison

Baseline: `8185478`. Revised search: `5d9ae29`. Both used Node v24.11.0,
the same sealed input artifacts, the same selected starts, and three serial
passes. Every corresponding input fingerprint and loaded-graph fingerprint
matched. Retained outputs were deterministic across passes. Neither regional
mode hit a wall-clock deadline.

At the production budget, distinct retained physical loops across the sampled
starts increased from **21 to 32**. Summing the twelve per-request/start median
search times gives **2,409 → 889 ms** (2.71×), excluding preparation. This is a
sample aggregate, not a measured end-to-end Full job or a general speed guarantee.
Candidate preparation across the four criteria sessions took 441 → 231 ms.

The 35% repetition cases show the useful positive and negative outcomes:

| Start | Median search ms, baseline → revised | Distinct exact physical loops, baseline → revised |
| --- | ---: | ---: |
| Skyline / Toll Road interconnector, `2277745095` | 325 → 26 | 2 → 2 |
| Alpine Road, `65425280` | 651 → 218 | 4 → 7 |
| Tafoni Trail, `3297929571` | 367 → 213 | 10 → 10 |
| Eightmile Trailhead, `12053857534` | 5 → 1.5 | 0 → 0 |
| Snoqualmie on-cycle start, `3924732444` | 21 → 8 | 5 → 5 |
| Snoqualmie approach start, `9669556494` | 126 → 153 | 0 → 8 |

The last start spends about 27 ms more to return eight suitable loops where the
baseline returned none. At the on-cycle Snoqualmie start, raw route count changes
from seven to five because two baseline routes duplicate physical loops; unique
loop count remains five. The zero-repetition cases remain without exact matches
in both implementations.

For Tafoni's retained routes, mean one-way shared approach decreases from 384 m
to 6 m. Mean distance-midpoint deviation increases from 159 m to 670 m; all ten
routes still meet the requested 3–8-mile range. Alpine Road's larger result set
has mean approach 2,878 → 3,111 m and midpoint deviation 878 → 1,372 m. More
retained loops do not imply that every aggregate quality metric improves. The
retained loop sets also change; this is not a claim that the revised top ten
contains every loop returned by the baseline.

Summed per-start median phase times at the production budget are approximately:

| Phase | Baseline ms | Revised ms |
| --- | ---: | ---: |
| Graph reads | 1,565 | 72 |
| Candidate generation | 301 | 398 |
| Authoritative validation | 537 | 413 |

The revised engine spends more generation work finding useful loops while
removing much of the repeated graph-read work. Whole-process peak RSS for these
runs was approximately 414 → 480 MiB; that includes the benchmark overhead
listed above and is not a worker-only comparison.

At the smaller 50,000-state fixed-work budget, the sampled regional loop count
is 21 → 22 and the sum of per-start medians is 2,560 → 593 ms (4.32×). The
Snoqualmie approach's eight new loops require more search work than this smaller
budget allows. This difference supports retaining an explicit completeness / work
budget distinction rather than presenting a fast bounded pass as exhaustive.

In the deterministic 8×8 grid, the baseline returns no exact route at any of its
three neighboring starts. The revised search returns 10, 8, and 3 under 50,000
states, with per-start medians in the same tens-of-milliseconds range; at the
production budget it returns ten at every start. Gain, grade, repetition,
shared-stem, and bridge-separated-cycle negative cases remain without exact
matches. These measurements complement the independent exact oracle; they do
not replace it.

An exploratory run before competitive validation spent 8.9 seconds on Tafoni,
mostly revalidating routes that could not enter the result set. The accepted
`5d9ae29` output matches that exploratory run's retained exact and close route
objects on every regional case, while reducing Tafoni to roughly 0.21 seconds.
This is evidence for the tested sample, alongside the focused selection tests;
it is not a universal proof inferred from timing.

Raw reports are deliberately untracked. During this investigation they were
saved as `/private/tmp/alpine-search-baseline-{fixed,deadline}.json`,
`/private/tmp/alpine-search-5d9ae29-{fixed,deadline}.json`, and corresponding
`alpine-search-fixtures-*` files. Reproduce them with the commands above and
compare input fingerprints before comparing results. The revised graph/solver
source fingerprint is
`897843e357b803654206463b0867a323cfdf1efc90fd4f1621a9281d02f3e4bb`.
