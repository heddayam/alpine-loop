# Solver acceleration investigation

Date: 2026-09-22. Scope: measure the existing Full search and identify the next
acceleration work. This investigation did not change production code, worker settings, installed
packs, or the user's saved job. The coverage-cache prototype ran only in an
isolated worktree/container.

## Decision

Prioritize exact coverage memoization, then completion-driven worker scheduling.
Keep independent trailheads as the parallel unit. Tune worker count after these
changes; increasing it alone has diminishing returns on this machine.

Start the production optimization with two workers. It is the least expensive
configuration among the fast cached results. Treat six as an optional bulk-work
setting after longer-job and deadline-quality validation; this sample does not
establish that it is consistently faster once caching is added.

The existing two-worker limit was a conservative default, not a measured optimum.
The new measurements show why adding workers is not the strongest first change:
with exact coverage memoization, two workers completed the measured workload
faster than eight workers without it, while retaining identical route outputs.

## Actual Full search

The completed search attempted 156 starts in **594.997 seconds**, returning 98
exact routes and 70 close matches after the existing persistence/deduplication
rules. Criteria were 12–20 miles, 3,000–6,000 feet of gain, at most 20% repeated
trail, at most two miles of shared approach, multi-cycle allowed, and uncertain
access included.

The immutable completed diagnostics contain **1,019.678 worker-seconds**: 191.537
in Quick passes and 828.141 in Thorough passes. There were 125 Quick graph loads
and 248 Thorough graph loads; 31 starts required no graph work. Quick hit its
clock deadline at 24 starts and Thorough at 23. These are recorded phase times;
started/completed database timestamps also contain checkpoint waiting and are
not suitable measures of individual solve time.

The app's Linux environment reports eight available CPUs and about 7.82 GiB of
RAM. The completed job was observed without changing its process count, stopping
it, or issuing provider calls.

## CPU profile

Two real starts from that search, ordinals 3 and 50, were replayed with production
budgets on Node 24.11.0. Native and deployed `lib/solver` + `lib/graph` source
fingerprints matched:

`949a2107e245e3116a055b8d411ebe559a34ded75159ed0d017bb595fb6e3161`

The solves took 13.63 and 16.71 seconds. Graph loading accounted for 10.30 and
11.73 seconds: **75.6% and 70.2%**. Sampled self CPU time was concentrated in:

| Function | Sample share |
| --- | ---: |
| `coordinateIsInsideArea` | 45.2% |
| `segmentBoundaryParameters` | 18.1% |
| `pointRingRelation` | 2.8% |
| `getReachableGraph` itself | 22.7% |
| Garbage collection | 2.3% |
| Main penalized-search function | 1.1% |

This profile was native, while throughput measurements below used the deployed
Linux image. Shares describe these two starts; they are not a universal cost
model for every regional pack or request.

The [graph reader](../../lib/graph/sqlite-repository.ts) parses and checks exact
pack coverage for outgoing edges on each load. Full runs Quick plus Thorough,
and Thorough can load the same reachable graph twice. The
[route validator](../../lib/solver/closed-route-validation.ts) checks coverage
again for every candidate's edges. These repeated exact checks dominate the
sample, rather than the inner shortest-path algorithm.

## Controlled throughput experiment

Eight nontrivial Central Cascades starts from the completed job were used:
ordinals **3, 7, 14, 21, 33, 43, 50, 65**, pinned to
`cc-f1cb28a4ceb6e896`. Each task runs the real Quick + Thorough passes. Clock
limits are disabled, while production edge, state, and candidate limits remain.
This makes the amount of search work and the route results comparable across
worker counts instead of rewarding early deadline truncation.

Both variants used Node 24.11.0 and the deployed app image, with networking
disabled, read-only installed packs, eight available CPUs, a 6 GiB container
memory cap, and no swap allowance above that cap. Benchmarks ran serially after
the user's job completed. Each trial started fresh worker processes; each worker
retained its prepared pack session across its assigned tasks. Times include child
startup and task execution. The harness assigns the next task to whichever
worker finishes first; the production scheduler's separate limitation is
measured by trace replay below.

The experimental change only memoizes the existing exact `lineIsInsideArea`
result. Its keys are the immutable coverage object and the complete coordinate
sequence. It retains at most 64,000 entries per coverage object using FIFO
eviction. No geometry approximation, altered constraints, budget reduction, or
candidate removal is involved.

| Workers | Existing code | Exact-cache prototype | Existing peak worker RSS | Prototype peak worker RSS |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 89.84 s | 43.87 s | 515 MiB | 713 MiB |
| 2 | 47.03 s | 20.68 s | 1,021 MiB | 1,244 MiB |
| 4 | 42.02 s | 24.88 s | 1,949 MiB | 1,688 MiB |
| 6 | 36.93 s | 21.00 s | 2,222 MiB | 2,283 MiB |
| 8 | 39.11 s | 27.11 s | 2,851 MiB | 2,856 MiB |

RSS is the sampled sum of child-process resident memory, excluding the parent
and unmapped filesystem cache. It includes file-backed resident mappings and can
double-count shared resident pages; it is not total container memory. Initial table rows
are one trial each. Exact and close route payload fingerprints, order, counts,
and expanded-state counts match across all 17 trials and every worker count. A timing
change under production deadlines can change the candidate set, so fixed-work
parity does not promise identical production-deadline results.

At two workers the cache reduced elapsed time by **56.0%** (2.27× throughput)
and worker CPU time from **95.33 to 41.15 seconds**. This is a larger gain than
increasing the uncached pool from two to six workers (21.5% less elapsed time).
Larger pools duplicate cache warming and consume more CPU; the eight-worker
prototype took 27.11 seconds versus 20.68 with two. This sample does not justify
a universal eight-worker default.

Repeated runs add the following evidence:

| Workers | All existing-code observations | Peak worker RSS across observations |
| ---: | --- | ---: |
| 2 | 47.03, 48.61 s | 1,021–1,147 MiB |
| 6 | 36.93, 70.68 s | 2,222–2,324 MiB |

| Workers | All cached observations | Peak worker RSS across observations |
| ---: | --- | ---: |
| 2 | 20.68, 26.68, 25.10 s | 1,188–1,244 MiB |
| 3 | 28.35, 28.02 s | 1,288–1,369 MiB |
| 6 | 21.00, 25.06 s | 2,283–2,360 MiB |

At two workers, the observed median falls from **47.82 to 25.10 seconds**,
approximately **1.91× throughput**. This is based on two baseline and three
cached observations, not a statistical confidence interval. The slower repeated
six-worker baseline is included above; its cause was not isolated and it
reinforces the uncertainty in selecting a larger pool from short trials.

Two and six workers have overlapping observed timings, while six retains nearly
twice the memory. Three did not improve this sample. These observations support
keeping a small default after eliminating repeated work, rather than declaring a
single globally optimal worker count. Host scheduling, cache locality, thermal
state, and workload shape can affect these short trials. Container resource caps
do not isolate host CPUs from other activity. Longer whole-job tests
across multiple regions remain necessary before selecting a new universal limit.

## Scheduling replay

The current [job runner](../../lib/route-jobs/service.ts) admits one window of W
starts and awaits the oldest ordinal before refilling. A later completed worker
can sit idle. The [session](../../lib/server/search.ts) also assigns calls to
round-robin slot queues, so merely increasing the admission window would not
fully solve the problem.

Replaying all 156 recorded service durations gives the following model. It holds
each task's duration fixed, excluding startup, persistence, contention, and
changes in deadline-limited work. These are **estimates, not elapsed benchmark
results**.

| Workers | Current window | Refill on completion, window 4W |
| ---: | ---: | ---: |
| 1 | 1,019.68 s | 1,019.68 s |
| 2 | 566.31 s | 509.86 s |
| 4 | 319.72 s | 254.98 s |
| 6 | 228.66 s | 170.03 s |
| 8 | 179.58 s | 127.55 s |

A 4W reorder window matched unlimited dynamic scheduling on this trace while
keeping a bounded number of buffered results. At two workers that predicts
11.1% more throughput; at four, 25.4%. It must not be multiplied directly by the
coverage-cache speedup: caching changes task durations and their imbalance.

## Implementation order and acceptance

1. **Exact coverage cache.** Scope it to pinned pack/version and immutable exact
   coverage. Retain the authoritative predicate on a miss; preserve holes,
   concavity, boundary behavior, direction/access checks, and the distinction
   between route coverage and start filters. The prototype's JSON keys establish
   the opportunity; a production design should bound retained bytes and consider
   verified edge identities to reduce key allocation. Do not install the generic
   prototype unchanged without making its immutability contract explicit.
2. **Reuse same-start work.** Avoid reloading the identical Thorough graph, and
   reuse Quick's graph only when it is complete for the larger request. Preserve
   both Quick and Thorough searches and their candidate union. Cache validation
   by ordered directed traversal sequence within immutable pack/version, start,
   and validation-option context, not only the public route ID: reversal changes
   directional elevation/grade metrics, and different starts can share a node.
   Complete cached outputs also embed start identity, route/segment IDs and source
   metadata; alternatively cache identity-free metrics and rebuild metadata. Measure these
   changes individually after the coverage cache; their savings overlap.
3. **Keep workers busy.** Lease the first free slot, preferring matching pack
   affinity only among free slots. Admit at most 4W unfinished/uncommitted starts,
   refill on any completion, and commit strictly in ordinal order. Trim buffered
   results immediately to ten exact routes or one close match. Preserve existing
   recovery of all uncommitted running starts and cancellation/deletion precedence.
   Add tests for admission backpressure, reversed completion, deterministic
   geometry ownership, restart gaps, and discarded late results.
4. **Control resources across the app.** The current limit applies independently
   to Full and every Quick request. Add a shared CPU/memory admission budget
   before raising defaults substantially, and reserve capacity for API/map/Quick
   responsiveness. Tune on several packs, request sizes, and longer Full jobs;
   retain the environment override. The deployed Node/libuv already accounts for
   Linux affinity and CPU quotas in `availableParallelism()`; no separate quota
   parser is needed ([versioned implementation](https://github.com/libuv/libuv/blob/v1.51.0/src/unix/core.c#L1863-L1946)).

Do not remove exact coverage validation, omit Quick from Full, reduce search
budgets, or parallelize dependent penalty-update rounds to claim a speedup.
The experiment's 57 existing geometry/repository/solver tests and 48 additional
mixed geometry checks passed. Production work still needs the runbook's complete
verification and representative deadline-mode quality checks.

## Local reproduction artifacts

Ignored `.cache/solver-acceleration/` contains the read-only job snapshots, CPU
profile, per-start profile runner, scheduling replay, benchmark harness and JSON
reports, source fingerprints, and the experimental patch. Raw snapshots contain
the user's search area and must stay out of Git. The patch is retained as an
experiment, not an applied application change.
The prototype worktree/branch and benchmark container were removed after the
measurements; the user's app container remained running.

```sh
python3 .cache/solver-acceleration/schedule-replay.py \
  .cache/solver-acceleration/job-complete.json
```

The `bench/` directory contains `run.mjs`, `worker.ts`, `input.json`, and each
report. Mount it at `/bench` in the recorded app image, mount installed packs
read-only at `/app/.local-data/packs`, and run `node /bench/run.mjs 1,2,4,6,8`.
Set `TSX_TSCONFIG_PATH=/app/tsconfig.json` and
`ALPINE_PACK_ROOT=/app/.local-data/packs`. The prototype variant additionally
mounts `.cache/solver-acceleration/geometry.cached.ts` over `/app/lib/graph/geometry.ts` and selects a separate
`REPORT_NAME`. Image identity:

`sha256:30772fb8d74a396d5fdcfa12802fdacd7f54449ec40294d8d3b4c27c5ebd996d`
