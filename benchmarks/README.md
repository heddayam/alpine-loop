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
