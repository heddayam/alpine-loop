# Frozen real-data checks

`queries.json` fixes 24 requests across Snoqualmie, Central Cascades and Mount
Rainier before replacement-engine optimization. Distances/gains are meters;
repetition is extra physical-trail traversal divided by total route distance.
The input file SHA-256 is
`bc41b5ee66c8c1ee3e08cb38f57907e0e3a408e2dcb0e6151bbc55ec8d7652f4`.
Do not tune these queries to make an implementation pass. Add new cases
separately when a real gap is found.

## Current application measurements

After `npm run build`, measure the geographic dataset through a fresh HTTP server
and its actual worker for each frozen request:

```sh
node benchmarks/app/run.mjs --dataset .local-data/network --output /tmp/alpine-app-results.json --observation-ms 30000
```

Use `--query north-bend-known` for one case. The observation window belongs to the
harness, not the application. Its default 1 GB sampled RSS guard and outer process
deadline keep the measurement bounded. RSS includes the server, worker and local
HTTP measurement client; it excludes the browser and batch coordinator. Reports
record sampling gaps, OS peak RSS, Stop response/worker-exit times, reconnects,
source and compiled-code hashes. Failures are not no-match evidence.
Current reports record `groupCount` separately from `routeCount`. The latter
counts full physical-walk/original-start options, pairing only exact opposite
directions. Earlier reports used the then-current retained representative count;
their counts are not directly comparable to the expanded inventory.

Requests remain frozen. New road settings absent from an old request use the
app defaults; the full resolved query is recorded in each observation. Historical
witnesses must be checked against those additional constraints. Matching numeric
constraints or producing many results does not establish useful hiking choices.
The real result audit is in `route-quality-review.json`; geographic storage and
source evidence are in `network-review.json` and `fresh-north-bend/`.

The current `results/depth-traversal-network-30s.json` run at `f9003a5` measured
all 24 requests on corrected snapshot `f349…`: four completed, nineteen were
still searching at thirty seconds, and one exhausted available coverage with
a warning. The harness labels both searching and coverage-limited cases
`unfinished`; their terminal statuses distinguish them. There were no app or
measurement failures. Peak process RSS was 580,009,984 bytes; every Stop returned
within 3.6 ms after its worker exited. All reconnects preserved the search/query,
and all children exited with zero workers left. These measurements exclude the
browser and do not bound memory during arbitrarily long searches. The earlier
`results/trail-hikes-network-30s.json` remains pinned to its prior traversal/data.

The separate `results/discovery-review.json` records independent discovery checks.
Earlier depth-first search missed the fixed Stevens-long and Paradise-short
walks or direct 85% representatives within five minutes. The integrated `f9003a5`
traversal explores outward section counts in increasing order at every start,
retaining exhaustive search without auxiliary return-distance machinery. Four
pruning/ordering experiments failed their measured recovery checks and were removed.

With this traversal on the corrected `f349…` snapshot, all seven qualifying
original walks were recovered exactly from their original starts: six within
sixty seconds and Sunrise-long in 214.244 seconds during a separate five-minute
observation. Sunrise's original sixty-second unfinished observation is preserved.
These are engine checks before app filtering, not HTTP recovery or complete
enumeration. Separate HTTP/GPX checks on `1b044…` verified similar
Paradise and Stevens choices from different starts. Their exact original-start
walks were also recovered in isolated engine checks. Those observations preceded
the grouped presentation that now preserves alternate starts. Timing is descriptive;
concurrent work and cache state were uncontrolled.

The `groupedPresentation` record in `results/discovery-review.json` pins the
subsequent real HTTP proof: all 112 groups, 376 options and 752 emitted directions
from completed North Bend match the full independent raw audit. All 115
overview/member pages were checked; six selected direction-specific detail/GPX
exports were independently reconstructed. Both audited Cedar Falls approaches
are accessible in the same group. Separate thirty-second whole-app observations
retained 5,115 Paradise-day options at 304 MB peak RSS and loaded Pass-long at
580 MB with no option found in that window. Both remained unfinished, reconnects
passed and Stops completed within 3 ms. These two older harness captures did not
record group counts; do not infer those from their option counts. The updated
harness's completed North Bend smoke records both counts correctly.

## Current exact-witness measurements

After building, verify the original starts and complete physical walks against
the committed independent source replay in `prepared-witnesses.json`:

```sh
node benchmarks/run-engine.mjs --dataset .local-data/rewrite/network-cascades-retained-starts --output /tmp/alpine-witness-results.json --observation-ms 300000
```

Without `--observation-ms`, the observation window is sixty seconds; the command
above allows five minutes. Use `--query sunrise-long` for one case. The runner
selects the seven qualifying witnesses, checks the pinned snapshot and frozen
queries, and runs each in a separate process. Original and reversed walks are
reported separately, always requiring the original start. Discovery time includes
data loading; setup time is recorded separately. Route outputs are discarded
immediately after comparison, so memory excludes app retention and the browser.
Each case continues until exploration finishes or a measurement guard intervenes.
A recovered witness does not imply completed exploration. The default sampled
RSS guard is 1 GB. Data/code changes and measurement errors fail visibly.

The recorded seven-witness evidence used a frozen scratch verifier that stopped
after each first exact recovery. Its source/compiled/input hashes and observation
scope are preserved in `results/discovery-review.json`. The maintained runner
checks the same committed physical walks, while measuring the whole observation
window. The previous pilot adapter was replaced rather than kept as a second
active engine measurement path.

## Historical pilot evidence

Everything below describes the earlier inherited pilot and earlier engine
captures. It is retained as source evidence, not as a current runtime or quality
claim. Its graph lacks the newer road classifications and is not a current
whole-app input. Use the current harness above for present behavior.

`pilot-provenance.json` pins the exact sealed inputs, original OSM/DEM source
identities, output hashes and inherited limitations. The raw OSM snapshot is
Washington `washington-260801`, SHA-256
`3bea264079e184675aac7d8ab104bff5339b9e3656a36c084f96f616271a0e4e`.
This is a pilot drawn from existing data, not a completed replacement compiler.

The temporary exporter writes two runtime files: `graph.json.gz` contains the
replacement model; `geometry.json.gz` contains each physical corridor once.
`source-index.json.gz` and `provenance.json` are audit evidence, not runtime
dependencies. The graph retains the entire sealed artifact and all eligible
source starts; selecting a map area never clips its paths. Geometry preserves
the original two-dimensional drawing coordinates. Graph node elevations and
direction-specific measured distances/gains remain available; no elevation
samples are invented.

| Dataset | Graph gzip bytes | Geometry gzip bytes | Nodes | Directed edges | Starts |
| --- | ---: | ---: | ---: | ---: | ---: |
| Snoqualmie | 716,363 | 2,985,117 | 11,181 | 24,290 | 1,227 |
| Central Cascades | 747,643 | 3,476,821 | 11,897 | 25,120 | 1,703 |
| Rainier | 655,556 | 2,550,983 | 10,918 | 21,246 | 2,009 |

These small files do not prove statewide size or runtime performance. Existing
starts were admitted by the retired mountain-core policy. Existing source
geometry was pruned using fixed-distance bounds and exclusions. Both omissions
remain visible in each dataset's `info.limitations`. Long query results are
useful witnesses inside these data, not a claim of long-route completeness.

## Independent expectations

`witnesses.json` separates existence evidence from the frozen request file:

- `proven`: an explicit sequence of original directed source-edge IDs has been
  checked for continuity, access, node-simple cycle and stem shape, identical
  return stem, distance/gain sums and repetition. The witness miner constructs
  spanning-tree fundamental cycles and approaches directly from sealed source
  graph records. It imports neither the old nor replacement solver.
- `none`: an independent certificate sums gain over every directed edge that
  could fit between the start's shortest outward and return distances. A simple
  loop/lollipop can use each directed edge at most once. If that deliberately
  generous sum is below the minimum requested gain for every eligible start,
  no qualifying route exists in this source graph.
- `unknown`: no independent witness or impossibility certificate was obtained.
  Failure to find a basis-cycle witness is never treated as no-match evidence.

The witnesses are existence checks, not a complete expected route list. They
do not certify current trail conditions, parking legality or recreational
quality. Real-data performance runs are separate from the offline unit suite.

## Reproduction

Run from the repository using Node 24. The following commands use only already
sealed `.sqlite.gz` objects and their receipts; no network is needed. They verify
compressed and raw hashes, require DELETE journal headers, and open a disposable
decompressed file read-only. Never point a tool at a live build/cache database.

```sh
node tools/pilot/export.mjs .local-data/releases/prepared snoqualmie-region .local-data/rewrite/pilot
node tools/pilot/export.mjs .local-data/releases/prepared central-cascades .local-data/rewrite/pilot/central-cascades
node tools/pilot/export.mjs .local-data/releases/prepared mount-rainier-area .local-data/rewrite/pilot/mount-rainier-area
node benchmarks/source-witnesses.mjs verify .local-data/releases/prepared
node --test tests/data/pilot.test.mjs
```

`node benchmarks/source-witnesses.mjs mine .local-data/releases/prepared`
reconstructs the checked-in source witnesses without production solver output.
The exporter selects the current named artifact; compare its receipt to the
frozen provenance before interpreting benchmark results. The witness checker
always selects its original content-addressed artifact, regardless of a newer
catalog publication. Generated runtime files and decompressed data stay out of
Git. Do not publish these pilot data as general prepared coverage.

## Descriptive engine measurements

These captures used the retired pilot-specific runner at `f9003a5`. Reproduce
that historical protocol in a separate checkout of that commit, with the three
exported pilot datasets. The active runner above accepts only the corrected
prepared-network snapshot. Historical ten-second budgets were measurement
windows, never application timeouts or present acceptance targets.
Graph read, decompression, JSON parse, audit setup and engine import are measured
separately from search. Search records first exact output, first observation of
all starts attempted, completed exploration, expansions and terminal status.
Cancellation records both timer scheduling delay and abort acknowledgement.
Peak RSS includes the fresh Node process, loader, graph and audit mapping; it
excludes the backend, browser and retained output. This is not full-app memory.
Witness comparison time is separately recorded and included in search wall/CPU
time. Route arrays are discarded immediately after comparison.

For each proven query, `witness.directedRecoveredMs` requires its original start
and exact ordered directed source-edge IDs. `reversedRecoveredMs` separately
identifies the same walk traversed backward, using physical trail identities to
look up reverse directed edges. Both null means this particular source witness
was not observed. `firstExactMs` can still be present: finding another exact
candidate is a different observation. Unknown expectations remain unknown;
output cannot contradict a frozen no-match certificate. Witnesses prove
existence, not that the engine has enumerated every eligible route.

`results/initial-engine-10s.json` preserves the original pre-optimization
measurements byte for byte; its adjacent metadata describes the original
measurement and missing fields. It attempted every eligible start, exhausted
12 of 24 requests, and stopped the other 12 at the observation window. It found
an exact candidate in 13 of the 14 independently proven requests. The original
harness did not check which witness was found, and did not record the exact
time all starts were attempted. Those facts must not be inferred from output
counts or approximate progress snapshots.

The separate instrumented captures use the same frozen inputs and ten-second
window. They ran sequentially on an Apple M3, 8 logical CPUs, 16 GiB RAM,
macOS/Darwin 27.0.0, Node 24.11.0 with the tsx loader. The integrator performed
short interactive app inspections during part of this session, so concurrent
light UI/server activity was possible. These are descriptive observations,
not a controlled speed comparison or a production memory limit assessment.

| Instrumented capture | Completed requests | Proven requests with any exact candidate | Specific witnesses recovered | Peak child RSS |
| --- | ---: | ---: | ---: | ---: |
| `initial-engine-witness-10s.json` | 12 / 24 | 13 / 14 | 6 / 14 | 146.9 MiB |
| `optimized-engine-witness-10s.json` | 17 / 24 | 14 / 14 | 10 / 14 | 340.1 MiB |

The initial source is available at commit `4b756ec`; its `src/engine/search.ts`
hash is `3a9ebacf445e2dd66e51708ff5140204b72b9ad072d6e23171076ddb9e5b53da`.
The final measured source is integrated at `9f2f14b`, with search hash
`d7bf6dc67336257fc545397c67004dc68a82a84f29351ac031c7cbb46e65f977`
and `return-distances.ts` hash
`2f4fe92149679f415d2e7718d2ff1436d8f13c936ca4318a0b431a148340a320`.
The final measurement used the solver's frozen copy of those identical files.

Every completed proven request recovered its witness in both instrumented
captures. The final capture did not observe the specific witnesses for
`pass-long`, `stevens-long`, `sunrise-day` or `sunrise-long`; each emitted other
exact candidates and remained unfinished. This is not evidence of invalidity
or a claim that further search cannot find them. All eligible starts were
observed as attempted within 184 ms initially and 33 ms finally. Maximum
observed abort acknowledgement was 3.3 ms initially and 1.5 ms finally;
timer scheduling delay is separately recorded in each result.

Candidate counts are directed emissions, not unique hikes retained by the app.
For example, final `middle-fork-day` exhausted after emitting 763,902 candidates.
Discarding these outputs keeps this benchmark from accidentally measuring
an unbounded results array. The application must measure its own shortlist,
geometry, transport, browser and backend resource use separately.
