# Unified route-search investigation — 2026-09-06

Decision: keep the current production solver and remove the experimental
replacement. The experiment establishes that substantially less search code is
possible. Its runtime and route-quality tradeoffs do not justify adoption now.
The active application and benchmark harness return to their pre-investigation
state. The complete experimental snapshot remains in Git at `73ffdce`.

The prototype used one operation: replace a span of a closed walk with a legal
connection through a chosen edge. Equal endpoints allow inserting an excursion;
deletion and starting from the empty walk use the same operation. Weighted
shortest-path trees propose connections, a common evaluator scores complete
walks, and a bounded pool retains several parents. This replaces six
shape-specific search passes with one search loop. It remains a heuristic with
proposal weights, archive limits and finite exploration, not an exact optimizer.

Related primary research supports investigating this family: the 2022 circuit
search paper uses path replacement and identifies the articulation-point
insertion problem; its 2024 directed successor uses a Pareto archive and a
duplicate junction to permit nonempty cycle insertion. Their constraints and
data collection differ from this application's; their reported timings are not
our benchmark. [Lewis and Corcoran, 2022](https://link.springer.com/article/10.1007/s10732-022-09493-5),
[Lewis and Corcoran, 2024](https://link.springer.com/article/10.1007/s42979-024-03223-3).

## What improved

- The prototype has 323 lines, or approximately 360 when accounting for the
  public interfaces borrowed from the current 990-line search module. Applying
  the same TypeScript printer gives 431 versus 1,058 lines including those
  interfaces: about 59% less. The unchanged corridor helper is additional to
  both (56 original lines, 67 formatted). This is a search-module comparison,
  not a claim to replace graph loading, authoritative validation or the UI.
- The first result's distance error improves at eight of nine sampled starts,
  although the final Cascades improvement is only 38 m.
- At the first East Bay start, first-result target error falls from 1,846 m to
  199 m and repetition from 24.95% to 2.41%.
- Substantial chains, intentional short hikes, legal one-way loops and diverse
  grid loops work through the generic move. An independent test caught repeated
  laps used as distance padding; normalization was corrected before final runs.

## Why it was rejected

All rows use Quick's existing graph/state/candidate budgets with clock deadlines
disabled, one warmup and three measured repetitions. Times are medians in ms.
The first five starts are the existing benchmark; the last four use the second
committed regional scenario and were not used to tune the prototype. Inputs
match by fingerprint. Pipeline timing includes graph reads and validation.

| Start | Core current → prototype | Pipeline current → prototype | Exact alternatives current → prototype |
| --- | ---: | ---: | ---: |
| Santa Cruz / Fall Creek | 15.3 → 492.7 | 155.5 → 608.5 | 4 → 5 |
| Henry Coe / headquarters | 16.0 → 284.1 | 1,805.7 → 1,947.8 | 10 → 9 |
| East Bay / Pleasanton Ridge | 32.7 → 350.1 | 205.3 → 509.1 | 10 → 6 |
| Monterey / Fort Ord | 39.2 → 380.6 | 186.5 → 527.7 | 5 → 10 |
| Cascades / White River | 16.4 → 422.4 | 1,583.1 → 3,059.1 | 1 → 2 |
| Henry Coe / Hunting Hollow | 19.0 → 417.4 | 2,269.4 → 1,970.3 | 10 → 9 |
| East Bay / Mission Peak | 34.6 → 299.5 | 198.8 → 418.7 | 10 → 10 |
| Monterey / Palo Corona | 23.2 → 375.8 | 143.2 → 467.9 | 2 → 4 |
| Cascades / Spider Meadow | 28.1 → 421.9 | 2,626.8 → 3,829.9 | 3 → 2 |

The core is slower at every start; the pipeline is slower at eight of nine.
Fewer candidates can occasionally reduce downstream validation enough to make
the whole request faster, as at Hunting Hollow. The total exact count increases
only from 55 to 57, while four individual starts lose alternatives. First-result
repetition is mixed; better distance fit is not evidence of universally better
hikes. For example, headquarters repetition rises from 5.73% to 7.90%, and Palo
Corona rises from 21.30% to 25.71%.

Reducing the prototype's move cap from 512 to 64 cuts initial-start core smoke
times to approximately 55–102 ms, but also reduces some result counts. Increasing
the budget is not monotonic: East Bay returns nine exact alternatives at 64 moves
and six at 512. Bounded archive pruning and greedy overlap selection can discard
useful diversity. Those sweeps used one measured run and are directional evidence,
not equally rigorous final timing comparisons.

With actual three-second deadlines, the first four starts return stable results
in approximately 0.55–2.16 seconds. White River takes 3.10–3.15 seconds, reports
deadline truncation, and processes different candidate counts between runs,
although its two exact route geometries remain identical. Additional validation
work can run beyond the deadline; the experimental replacement is not ready for
the production latency requirement.

Most importantly, the user's detour preference remains unresolved by the generic
objective. A 3 km simple loop and a 2.4 km loop plus a 600 m side lobe can have
identical distance, first-use distance, ascent and repetition. A 180 m bypass
replacing 40 m of main trail can also improve target fit while introducing an
unwanted departure and rejoin. It is still a simple loop, so same-junction
excursion trimming cannot detect it. This requires context in the quality model;
changing the search algorithm alone does not supply that judgment.

The next useful direction is to define reviewed good/bad route comparisons and
improve the current solver's quality evaluation against them. Trail continuity,
the size of a detour relative to its alternative, and the usefulness of an
approach are candidate measures to investigate, not newly accepted hard rules.
There is no second solver left in the active tree.

## Evidence and reproducibility

The experimental snapshot at `73ffdce` includes the prototype, its independent
quality suite and the harness options needed to reproduce these comparisons:

```sh
node --import tsx scripts/research/solver-benchmark.ts --suite=all --warmup=1 --repeats=3
node --import tsx scripts/research/solver-benchmark.ts --suite=all --warmup=1 --repeats=3 --search-module=scripts/research/unified-route-search.ts
# Add --scenario-index=1 --suite=packs --case=/exact for the four holdout starts.
# Add --mode=deadline --layer=pipeline --suite=packs --case=/exact for deadline runs.
```

All 31 original cases and four additional starts were compared across raw and
pipeline layers. Fixed-work results are deterministic in all three repetitions;
directed-validation rejections are zero. Local ignored reports are in
`.cache/unified-search/`: `current-fixed.json`, `prototype-fixed.json`,
`current-holdout.json`, `prototype-holdout.json`, and `prototype-deadline.json`.
The harness substitution was checked with an empty search implementation that
changed both raw and pipeline results from one exact loop to zero.

Both implementations pass the 11 independent quality checks. Prototype control
checks cover cancellation, expansion/candidate caps, deadline interruption,
incumbent retention and deterministic fixed-work output. Before removal, two
`npm run verify` passes each passed 438 tests across 79 files, lint, types and
build; two `npm run test:browser` passes each passed six flows. Removing the
research files restores application, test and benchmark source to `f7b5209`;
only this record and the status entry remain as net changes. No data, dependency,
pack schema, installed artifact or saved job changed. Temporary worktrees and
branches were removed.
