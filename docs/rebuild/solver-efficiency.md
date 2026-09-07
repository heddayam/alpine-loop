# Solver efficiency and route quality

Baseline: `7329c88`. The selected approach keeps penalized shortest-path search,
runs it on direction-safe contracted trail corridors, and corrects cycle
assembly. Minor side excursions are removed before evaluating a candidate.

## Algorithm

The old engine ran Dijkstra repeatedly over every mapped point along a trail.
The new engine preserves the start, junctions, direction changes, and parallel
physical trails, but combines the intervening degree-two corridors. Each
directed corridor retains its ordered original edges. Search sums directional
distance and gain; reconstruction expands those exact edges before the existing
coverage, access, topology, grade, and metric validation.

This is graph contraction, not geometry simplification or a pack-format change.
For a graph with `V` nodes and `E` directed edges, preparation is linear apart
from the existing stable ordering. Repeated shortest-path searches now operate
on the smaller junction graph. The loaded-edge cap still counts original edges;
expanded-state budgets count settled junctions. The heuristic can explore more
actual choices within its budget, so route identities and ordering can change.

The five sampled reachable graphs shrink from 4,628 / 10,000 / 8,440 / 9,106 /
10,000 directed edges to 118 / 436 / 576 / 356 / 80 directed corridors. Those
are runtime graphs at the selected starts, not complete regional pack sizes.

## Useful chains and unwanted padding

A 3 km loop connected by a 500 m trail to a 2.1 km loop makes a useful 6.1 km
chain. The second loop plus its approach is too repetitive on its own:
500 / 3,100 = 16.1%. The whole chain repeats just 500 / 6,100 = 8.2%.
The old assembly filter discarded the component for a request allowing 10%.
It now retains components whose repetition can become acceptable at the maximum
requested distance and validates the assembled walk. Limits are never relaxed.

Following the user's preference, tiny extra loops are removed rather than merely
ranked lower. A closed side excursion returning to the same junction is removed
when its length is at most **both half a mile and 20% of the candidate walk**.
The relative bound avoids applying a half-mile minimum to a deliberately short
hike. Adjacent opposite traversals cancel as well; this removes a connector left
behind when its only loop was removed, and rejects a forward-then-backward lap.
Substantial chained loops and necessary shared approaches remain supported.

Normalization happens before identity, metrics, constraint checks, archives and
selection. A route shortened below the requested minimum is a labeled close
match. It is not passed off as an exact match. The rule targets closed side
excursions; it does not impose a minimum on every mathematical cycle in a complex
overlapping network, or claim that every surviving hike is attractive.

## Alternatives evaluated

A bounded depth-first search with return-distance pruning was substantially
simpler, but it lost alternatives on branching networks. On a 12×12 grid it
returned six exact routes versus ten for the original, with about four times as
many counted states (the operations differ). Corridor contraction does not remove
grid junctions. The precise assembly fix recovered its demonstrated chained-loop
advantage without replacing the search strategy. See
[the experiment notes](solver-alternatives-notes.md) for fixtures and rejected
approaches, including cycle enumeration, disjoint paths, and a fixed cycle basis.

The distinction between meaningful circuits and distance-padding laps also
appears in [Lewis and Corcoran's generalized fixed-length circuit research](https://link.springer.com/article/10.1007/s10732-022-09493-5).
Its undirected assumptions are not a direct replacement for our directed graph
and request constraints.

## Reproduction and measurement limits

`scripts/research/solver-benchmark.ts` runs deterministic committed graphs and,
optionally, read-only installed packs. It imports all implementation dependencies
from `--solver-root`, records source and input hashes, warms up, measures repeated
samples, and records route identities, exact/close counts, target deviation,
repetition, topology, and validation rejections.

```sh
node --import tsx scripts/research/solver-benchmark.ts \
  --solver-root=. --suite=all --layer=both --mode=fixed-work \
  --warmup=1 --repeats=3 --output=.cache/solver-efficiency/fixed.json
node --import tsx scripts/research/solver-benchmark.ts \
  --solver-root=. --suite=packs --case=/exact --layer=pipeline --mode=deadline \
  --warmup=1 --repeats=3 --output=.cache/solver-efficiency/deadline.json
```

Fixed-work runs disable the internal clock deadline but retain state and
candidate caps. Raw timing excludes SQLite loading and authoritative validation;
pipeline timing includes both. Default deadline runs use the production Quick
policy. Timed runs are serial on Node 24.11.0. Local reports remain ignored in
`.cache/solver-efficiency/`.

These are five specific starts, one per installed region, plus deterministic
fixtures. They establish a measured improvement for this matrix, not a guarantee
for all trailheads. Returning more alternatives can increase validation time.
More exact routes also does not imply better target centering or lower repetition
for every ranked result; the reports preserve those tradeoffs.

## Final evidence

The final fixed-work medians below use one warmup and three measured repetitions.
The pipeline column includes loading and validation. Exact counts are validated,
diverse alternatives returned at one representative start in each region.

| Region | Core search, old → new | Whole pipeline, old → new | Exact routes, old → new |
| --- | ---: | ---: | ---: |
| Santa Cruz Mountains | 262.5 → 16.2 ms | 357 → 130 ms | 2 → 4 |
| Henry Coe | 120.9 → 15.9 ms | 1,534 → 1,846 ms | 4 → 10 |
| Southern East Bay | 168.8 → 33.7 ms | 300 → 220 ms | 2 → 10 |
| Monterey–Carmel | 146.1 → 40.1 ms | 290 → 187 ms | 2 → 5 |
| Central Cascades | 189.2 → 16.5 ms | 2,771 → 1,663 ms | 1 → 1 |

Core search is 3.6–16.2 times faster in this sample. Summing the five pipeline
medians gives 5.25 → 4.05 seconds (about 23% less), with 11 → 30 exact routes.
Henry Coe is individually slower while returning more alternatives. These are
separate requests, not the runtime of one multi-region request.

Production three-second deadline runs reproduce 4 / 10 / 10 / 5 / 1 exact routes
in every repetition; final median pipeline times are 137 / 1,919 / 219 / 206 /
1,817 ms. All 31 fixed-work cases across both layers are deterministic, as are
the five production-deadline cases. All input hashes match their baseline.
Measured pipeline samples have zero directed-validation rejections and zero
deadline truncations. Other visible work limits can still apply.

The quality tradeoff is real. At East Bay's sampled start, the first result
changes from a six-cycle chain to one lollipop, with midpoint distance deviation
16 → 1,846 m and repetition 3.7% → 24.9%. Simpler topology does not guarantee
less retracing. Coe's best available distance fit improves 451 → 162 m and
Monterey's improves 1,473 → 353 m, although their first-ranked routes prioritize
other existing score terms. Cascades keeps its original unrepeated simple loop;
the highly repetitive composites found by the intermediate compression-only
prototype are removed. These results motivate an explicit route-quality
objective rather than claiming that every new result is better.

The direct tiny-loop regression changes an exact padded 3,600 m walk into a
labeled 3,000 m close match. The connector variant also removes the now-useless
approach. A separate test preserves the useful 6,100 m chain. Unit coverage
includes one-way boundaries, parallel trails, isolated rings, original directed
identities, cumulative gain, interior grade samples, cancellation, and budgets.

Application solver source grows by 71 lines; tests add 273 lines. The reusable
benchmark adds 344 research-tool lines. This is a speed and behavior improvement,
not a code-size reduction. No application dependency, API, pack schema, installed
artifact, or saved job changes. Full application verification and the follow-up
mathematical model are recorded in [status](status.md).

The main search plus its corridor helper is 1,046 physical lines versus 975
before (+7.3%); all application files in `lib/solver` total 2,332 versus 2,261.
Counts include comments and blank lines. The separate 153-line
[mathematical oracle](../../scripts/research/route-model-oracle.py) verifies only
tiny restricted graphs; it is not a smaller full solver replacement. Its
[formulation and limitations](principled-route-model.md) define the proposed
shared objective for future search and ranking work.

Two `npm run verify` passes each pass 427 tests across 78 files, lint, types and
the production build. Two `npm run test:browser` passes each pass all six flows.
Live localhost inspection opens saved Henry Coe routes, preserves map alignment
through zoom/pan, and scrolls the internal segment list at a 390 px viewport,
with zero browser console errors. The exact oracle's 57,672 bounded selections
pass independently. Temporary agent worktrees and branches are removed.
