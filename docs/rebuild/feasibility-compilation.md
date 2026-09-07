# Original-graph feasibility compilation

Implemented the first recommendation in [simplification-assessment.md](simplification-assessment.md)
on `codex/system-design`, through `3efccf4`. The compiler now computes the
feasibility facts used by route search directly on original graph edges. It no
longer constructs compressed decision graphs, metrics, blocks and reports only
to discard those structures before persistence.

## Result and behavior

`buildClosedRouteTopology(nodes, edges, accessPoints, options)` remains the one
compilation interface. It owns physical identities, profile eligibility, legal
return reachability, minimum approaches, diagnostic identities and content
hashing. Its compact result type now describes the only supported output:
primitive arrays are empty and corresponding counts are zero. The SQLite tables
and the search reader's interface remain unchanged.

For each public-only or public-plus-unknown profile, the implementation:

1. Finds directed strongly connected components (SCCs).
2. Keeps physical edges whose eligible endpoints share an SCC.
3. Finds undirected bridges in that physical multigraph. Nonbridge endpoints
   are cycle nodes; parallel physical edges and self-loops remain meaningful.
4. Runs reverse shortest-path search inside each SCC to find minimum approaches
   to cycle nodes. Iterative traversals avoid recursion limits; settled
   predecessors prevent reconstruction loops across zero-length ties.

This fixes a reproduced error: a start connected to a usable triangle by a
100 m stem previously acquired a false 0 m approach when a separate one-way
triangle was added at the start. That triangle cannot be used to return. The new
compiler retains the 100 m stem in both profiles. The coordinating solver's
regression uses a 200 m stem and verifies that zero-repeat and restrictive stem
requests prune before graph queries, while a permissive request still returns
an exact route. This improves early pruning; no claim is made that the old
compiler allowed invalid routes through final validation.

Original node, directed-edge and physical-edge key assignment is preserved.
Format-2 attachment and portal identifiers use original dense node keys. A
cycle network uses the smallest original node key in its SCC. Connector keys
hash the algorithm version and ordered original directed-edge IDs. These
identities affect diagnostic group counts. They do not schedule starts, divide
budgets or determine fairness; a regression verifies all 12 starts are probed
when their group identities are shared or arbitrarily remapped.

Invalid edge lengths (negative or nonfinite) and access points referencing
missing nodes now fail explicitly. Existing duplicate-ID, endpoint and physical
geometry checks remain. The compiler still provides feasibility lower bounds;
search and final route validation enforce complete route constraints.

## Compatibility and activation

- SQL schema stays at version 6. New feasibility profile format is 2 and its
  algorithm version is `original-graph-feasibility-v2`.
- The independent reader accepts formats 1 and 2 and still reconstructs and
  validates profile/content hashes. A committed JSON fixture freezes genuine
  old rows and hashes; tests read them and reject altered old contents.
- Persisted auditing accepts both formats and rejects unknown formats. Its
  independent counts, attribution, coverage and other artifact checks remain.
- All five regional fingerprints now include the topology algorithm version.
  Changing it selects a new build directory instead of reusing an old cached
  pack. Frozen regional preparation comparisons still verify all other seed
  values, restrictions, overlays and source inputs, with a second version
  perturbation checking cache invalidation for each region.
- Installed packs, current pointers and saved jobs were not rebuilt, activated,
  migrated or deleted. Existing packs therefore retain their old feasibility
  values; the correction takes effect when a new pack is explicitly built and
  installed. Old saved results remain readable.
- Before future regional activation, retain artifacts pinned by saved jobs or
  defer activation: the existing publication cleanup is not a general pinned
  artifact retention system. This change does not introduce that subsystem.

## Size

Physical tracked source lines against assessment commit `90100fd`:

| Category | Before | After | Change |
| --- | ---: | ---: | ---: |
| Application | 19,464 | 19,035 | −429 |
| Tests and helpers | 9,338 | 9,573 | +235 |
| Combined | 28,802 | 28,608 | −194 |

The compiler itself loses 378 lines and its types lose 62. Versioning and
compatibility checks add a small amount of application code. Tests grew more
than the assessment estimate because independent tiny-graph checks, frozen
legacy compatibility, cache invalidation and solver fairness were retained.
The new legacy JSON fixture adds 155 data lines, excluded from these counts.
No dependency, replacement wrapper layer or generated pack was added.

Counts use `.ts`, `.tsx`, `.mjs`, `.css`, `.py` under `app`, `components`, `lib`,
`scripts`, `tests`, `tools`. Test/spec files, `test-helpers.ts`, `tests/` and
`__fixtures__/` count as tests/helpers. JSON, documentation and generated data
are excluded, consistently with the assessment.

## Quality and performance evidence

The topology interface tests include 20,000-node tree and cycle graphs,
parallel edges, self-loops, articulation/barbell cases, one-way return legality,
profile isolation, deterministic permutations and zero-length ties. Eighty
seeded tiny graphs are compared with an independent all-pairs reachability and
edge-removal oracle rather than another copy of the new traversal.

A frozen 42-case solver comparison covers loop, lollipop and figure-eight
fixtures; Quick and Thorough search; public/unknown profiles; repeat/stem
constraints; edge budgets; and close matches. Ordered outputs match after
normalizing only the explicit data version and three diagnostic group counts:
22 exact routes, 8 close matches, 6,168 expanded states and 102 graph queries.
Physical route IDs, geometry, metrics, order, warnings and other diagnostics
remain part of the comparison.

A full scratch fixture pack passes persisted auditing with zero errors or
warnings. Across 32 SQLite tables and 126 rows, 29 tables / 117 rows are
unchanged. The other nine rows change only expected access identities,
metadata versions/hashes and profile formats/hashes. Feasibility and stem
values are unchanged in this fixture.

The installed Henry Coe graph was read without writes: 28,801 nodes, 57,830
directed edges and 44 access points. All 88 profile/access feasibility and stem
facts match between old and new compilers and the installed rows. Node,
directed-edge, physical-edge and physical geometry-hash identities match.
Five alternating samples per version ran in separate Node 24.11.0 processes:

| Measure | Old compiler | New compiler |
| --- | ---: | ---: |
| Median compiler stage | 2,702.79 ms | 371.85 ms |
| Compiler stage range | 2,237.11–2,739.26 ms | 314.49–399.05 ms |
| Median process peak RSS | 621.6 MiB | 463.9 MiB |

This is approximately 7.3× faster for this stage and graph. RSS includes input
loading; verification was running concurrently, so these are local
measurements, not an end-to-end build or route-search performance guarantee.
No regional pack was regenerated from external sources.

Temporary reproducibility artifacts from this run are under `/private/tmp`:
`alpine-feasibility-quality.ts` (`--compare`),
`alpine-feasibility-pack-compare.ts`,
`alpine-feasibility-performance.mts` (`old 1` or `new 1`), and
`alpine-feasibility-performance-summary.json`. Run the harnesses from the
repository with `node --import tsx`; the frozen compiler is in
`alpine-feasibility-baseline/topology-compiler.ts`. These experiments are not
part of the automated test suite and do not modify installed packs.

## Integration verification

Two complete `npm run verify` passes each passed 412 offline tests across 77
files, lint, type checking and production builds. Two `npm run test:browser`
passes each passed all six Chromium flows. The first sandboxed browser attempt
could not bind its local port; both recorded passing runs used the approved
local-server permission.

Live in-app browser inspection at `http://localhost:3000` restored 50 saved
Santa Cruz routes, verified map zoom/pan anchoring and route numbers, and checked
390 × 844 mobile results. The results panel scrolled internally to 844 px while
the page stayed at 0; content width stayed 390 px. No console errors were
reported. The temporary viewport override was reset.

All five installed packs also pass read-only persisted audits and the independent
feasibility reader with zero errors: Santa Cruz Mountains
`scm-e6f8b8c410c74f30`, Southern East Bay `seb-29a37bc9d90b7ed4`,
Monterey–Carmel `mc-de372db242288cff`, Henry Coe `hc-fb46538de42e5919`,
and Central Cascades `cc-f1cb28a4ceb6e896`. Existing disconnected-component and
rejected-source-edge warnings remain; they are not new failures. Audit evidence
is in `/private/tmp/alpine-feasibility-installed-audits.json`.

Only the existing integration checkout remains. Both implementation-agent
worktrees and branches were removed after their focused commits were
integrated. Unrelated user changes to `legacy/isochrones/README.md`, `.agents/`
and `skills-lock.json` were preserved. No generated data, local database,
secret or cache was committed.
