# Frozen real-data checks

`queries.json` fixes 24 requests across Snoqualmie, Central Cascades and Mount
Rainier before replacement-engine optimization. Distances/gains are meters;
repetition is extra physical-trail traversal divided by total route distance.
The input file SHA-256 is
`bc41b5ee66c8c1ee3e08cb38f57907e0e3a408e2dcb0e6151bbc55ec8d7652f4`.
Do not tune these queries to make an implementation pass. Add new cases
separately when a real gap is found.

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

Run after installing the app's dependencies, with the three exported datasets
under the same pilot directory. This runner uses no network or SQLite database:

```sh
node --test benchmarks/runner.test.mjs
node --import tsx benchmarks/run-engine.mjs --data-root .local-data/rewrite/pilot --output /tmp/alpine-engine-results.json
```

Optional `--engine /absolute/path/to/search.ts` selects another implementation;
`--budget-ms 10000` sets the observation window and `--query sunrise-long`
selects one frozen request. The default ten seconds is a measurement choice,
not an application timeout or acceptance target. Longer searches are legitimate.
Use a quiet reference machine and run engine variants sequentially. Each query
runs in a fresh child process, with no warmup and an uncontrolled filesystem
cache. The report pins the machine, runner, engine directory sources, original
source artifact, frozen queries/witnesses, graph and source-index hashes. Source
files beside the engine must remain unchanged during a run.

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
