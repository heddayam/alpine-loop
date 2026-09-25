# Rebuild status

This is the durable resume point for humans and agents. Check a gate only after
its acceptance criteria pass and record the verifying commands or artifact in
the evidence line.

## Active system design revision

### Developer builds and downloadable coverage — active

This revision supersedes app-driven progressive compilation below. Users select
map sections and install immutable prepared data; developer tooling builds one
coherent release. The existing branch and draft PR remain the integration path.

- [ ] Graph-reading proof and release/installation/download contracts.
- [ ] Developer-only coherent builds, compact feasibility hints, release export.
- [ ] Download lifecycle and clickable coverage sections on the shared map.
- [ ] Real-data build/install/search measurements, including the 4 GiB gate.
- [ ] Verified one-time reinstall, saved-result preservation, and legacy deletion.

Preserve existing generated data until replacement is verified. Earlier partial
scale measurements remain diagnostic evidence, not acceptance of this revision.

### Progressive coverage — implementation in progress

- [x] **A — Contracts and baseline.** Version-1 coverage plans, jobs, snapshots,
  and catalog contracts; schema-6 routing compatibility retained. Baseline
  regional disk footprint and unchanged bounded solver behavior documented in
  [progressive coverage](progressive-coverage.md).
- [x] **B — Resumable builder.** Disk-backed inventory, indexed context frontier,
  streaming publisher, global topology, receipts, source reconciliation, input
  invalidation, and deterministic DEM sampling pass offline regressions.
- [x] **C — Progressive installation.** Cross-unit cycles, opposite installation
  orders, overlap, interruption, changed-input replay, atomic activation, and
  live/saved generation retention pass integrated tests.
- [x] **D — App and CLI.** Shared job service, controls, aliases, recovery, and
  main-map coverage panel implemented. Coverage sits beside Settings; installation
  drawing preserves the separate search draft and results.
- [ ] **E — Scale and migration.** Real-source 4 GiB/swap-disabled container
  measurement is in progress. Cascades-sized and second-geography acceptance,
  expansion/resume timings, and final search measurements remain unproven.

Evidence (2026-09-24): two final `npm run verify` passes each passed 704 tests
in 105 files, lint, types, and production build. Two `npm run test:browser`
passes each passed nine desktop/mobile flows (35.2 s and 28.6 s). Live Docker
preview checks passed collection focus, exact status overlays, zoom/pan,
installation drawing, restoration of untouched search bounds, panel scrolling,
and mobile map/panel switching; no browser console errors. App and CLI both
launched persistent workers; the isolated cached-only request recorded the
expected missing-source failure. Docker runtime includes osmium and Rasterio
1.4.3/GDAL 3.6.2; Compose configuration validates.

The real-source trial imported 54.3 million Washington records, recovered after
an unsupported building-relation failure, and exposed repeated full-table
context scans. Those scans now use an indexed disk frontier; the durable source
inventory is being reused in the 4 GiB/swap-disabled trial. This remains Gate E
work, not a successful Cascades-sized build. The two-unit real-source build
completed in 17 min 46 s, with 1.06 GiB peak measured process-tree RSS and a
670 ms Quick search returning an exact loop. A later real integrity-check pause
completed in 0.60 s; the kernel limits were verified as 4 GiB memory and zero
swap. See the measurement notes in progressive-coverage.md. Current work is on
`codex/progressive-coverage`; it is not ready to merge. No production installation
has been replaced by the benchmark.

The latest runtime image builds successfully. Source lookups now use a verified
temporary spatial index and per-component envelopes; context ingestion and
publication yield at bounded checkpoints. Disk measurement includes unlinked
SQLite temporary files. Real Rasterio tests verify deterministic north-west DEM
tile ownership, and metric/topology versions participate in snapshot identity.
The full build is running with these fixes; previous partial timings are not
final large-region acceptance. A read-only migration audit preserved 35 region
selectors and 17 saved jobs containing 894 results. Central Cascades contains
supplemental official routing whose replacement is unverified, so its legacy
installation is explicitly retained even when coverage geometry is contained.

The final review fixed collection-plus-drawing selection, classified intended
and intentionally excluded source trails, batched temporary-index writes, and
replaced a quadratic physical-member export query with indexed joins. The v5
ten-unit snapshot published successfully before resuming with those query
improvements. A real search against that snapshot while the builder ran took
783 ms and returned one exact loop and one close match with budget truncation
explicitly reported. The current full-region trial retains verified work;
large-region completion is still required. Download and disk preview totals
remain unknown beyond the configured OSM download/cache sizes.

Preview now reads receipt metadata and file sizes without hashing whole OSM
downloads. It reports cached source/preparation bytes and explicitly defers
content/checkpoint verification to the worker. Exclusion classification uses
conservative bounds before exact predicates. The larger 18-unit graph export
took 6.30 s after the indexed-join fix; this is a publication substage, not the
full build. The Cascades trial remains active and Gate E remains open.

The next measured bottleneck was per-record context commits in dense units.
Shared context ingestion now commits batches of up to 1,000 node records or
building centroids, with a single larger source way kept intact. Transactions
close before metric work and pause checkpoints. All 22 runtime regressions pass;
two subsequent full verification passes again passed 693 tests, and both browser
passes passed nine flows (35.2 s and 26.0 s). The runtime image builds. The real
trial paused cleanly with 24 prepared units and resumed in the same constrained
container, preserving the active 18-unit snapshot and verified caches. Isolated
3,000-row writes improved from 608 to 159 ms for ways and 469 to 30 ms for
buildings; end-to-end improvement remains under measurement.

Real source checks found all five West Cady/Pilchuck/approach regression ways
inside supported Cascades coverage, but also exposed incorrect OPL escape
decoding of numeric names (Forest Road 63 became Forest Road c). The smaller
decoder now consumes delimited Unicode escapes correctly. Versioned source
paths and build identities invalidate affected preparation and graph caches;
the corrected import is running under the same hard limits with the old
snapshot retained until replacement passes audit. The 704-test verification,
both browser passes, and runtime image above include this fix. Earlier partial
build measurements predate the decoder correction and do not establish final
acceptance. Original downloads and elevation data remain reusable.

The corrected run has now published 26 units with 289,041 nodes and 578,733
directed edges. A real search against its first corrected 18-unit snapshot
returned one exact route and one close match in 580 ms while construction ran,
with budget and partial-coverage limits explicit. Dense-unit preparation fell
from 470/376 s in earlier runs to 105/107 s. These are partial-build results;
the full Cascades and Olympic acceptance runs remain unfinished and Gate E stays
open. The updated preview at localhost:3105 is healthy and retains its local
settings and saved job. Production data remains unchanged.

The corrected trial published 42 units with no audit failure, then paused and
resumed to apply bounded topology transactions. The prior cycle pass took 441 s;
an isolated 15,000-node ring improved from 11.44 to 5.06 s with identical hashes.
Checkpoints run outside transactions and interrupted batches roll back. Two
full verification passes each passed 704 tests, lint, types, and production
build; two browser passes each passed nine flows (24.0 s and 25.1 s), and the
runtime image built. Independent review found no transaction/publication blocker.
The fixed eight-unit publication policy remains unchanged. Full Cascades and
Olympic measurements are still required; Gate E remains open.

The subsequent bounded scalar-statement cache reduced the same batched fixture
from 4.86 to 1.44 s without changing its hash. Streaming statements remain
independent, and caches clear after success/failure. Both final verification
passes again passed 704 tests and builds; browser passes passed nine flows each
(29.1 s and 24.4 s), and the runtime image built. The real trial has prepared
50 units and is publishing them; its running worker currently uses transaction
batching and will pick up the statement cache at the next publication restart.

- [x] 2026-09-22 — completed a solver acceleration investigation without changing
  production code or settings. The observed Full job completed 156 starts in
  594.997 seconds. Profiles of two real starts put 70–76% of elapsed time in graph
  loading, dominated by repeated exact coverage predicates. Across 17 isolated
  eight-start fixed-work trials, exact/close payload fingerprints, ordering,
  counts, and expanded states matched. A bounded exact-coverage-cache prototype
  reduced two-worker median runtime from 47.82 to 25.10 seconds (1.91× throughput).
  Cached two- and six-worker timings overlapped; larger pools used more memory
  and uncached six-worker repeats varied substantially. Replaying all 156 start
  durations predicts 11.1% more throughput from completion-driven scheduling at
  two workers; this is a model, not an end-to-end measured gain. Prioritize exact
  coverage caching, same-start reuse, first-free worker scheduling with ordered
  checkpoints, then shared resource admission and broader worker-count tuning.
  The prototype passed 57 existing offline tests and 48 direct geometry checks.
  Its worktree/branch and benchmark container were removed; raw job/profile data
  remains ignored. See [measurements and implementation requirements](solver-acceleration-audit.md).

- [x] 2026-09-22 — added **Export GPX** in route details for Quick and saved
  Full-search results, including close matches. GPX 1.1 contains the complete
  ordered track (including retraced sections), a named starting waypoint,
  source provenance, and warnings. Downloads use safe filenames and release
  browser object URLs. Elevations are omitted because profile samples are not
  paired with geometry vertices. CalTopo's documented GPX import is linked in
  the README; no live CalTopo upload was performed.
  Evidence: two `npm run verify` passes each passed 552 offline tests in 88
  files, lint, types, and production build. Two `npm run test:browser` passes
  each passed seven flows, including parsing a real Quick-result download and
  comparing every coordinate, plus a saved-result download at 390 px. Focused
  tests cover XML escaping, Unicode, legacy geometry, repeated paths, close
  match export, and download cleanup. Live in-app checks with a saved Sunol
  route passed desktop/mobile layout, map zoom/pan, mobile segment scrolling,
  and zero console errors. No dependency, API, or pack-schema changes. The
  temporary GPX worktree/branch and preview server were removed; unrelated
  regional-pack and solver work remains in progress in the shared workspace.

- [x] 2026-09-22 — added minimum/maximum drive-time areas and bounded parallel
  solving. The form defaults to 0–30 minutes, validates minimum < maximum for
  Quick and Full, and retains the range in saved requests and Jobs labels.
  Existing requests without a minimum still mean zero. ArcGIS returns a ring
  between the requested breaks; positive-minimum responses must identify that
  exact band, and the cache distinguishes both bounds. The band filters starts
  without clipping hiking geometry. Quick searches independent packs in parallel;
  Full searches independent trailheads, including within one pack. Lazy worker
  slots default to at most two available CPUs per search, configurable through
  `ALPINE_SOLVER_WORKERS` (1–8, CPU-capped). Ordered, bounded checkpoints preserve
  deterministic deduplication, cancellation/deletion precedence, and restart
  recovery without retaining a process for every installed pack.
  Evidence: two `npm run verify` passes each passed 546 offline tests in 87
  files, lint, types, and production build; two `npm run test:browser` passes
  each passed seven flows, including Quick/Full 15–60 minute requests. New tests
  cover invalid/legacy ranges, inner-contour exclusion, unclipped trails,
  minimum-aware caching, reversed completion, interrupted parallel starts, and
  late results after cancel/delete. Distinct child PIDs overlap synchronous
  300 ms CPU fixtures by over 100 ms; serial/parallel Quick results are identical
  on committed pack fixtures. Live in-app desktop and 390 px checks passed range
  controls, map zoom/pan, panel scrolling, and mobile map switching without
  browser errors. Compose configuration validates. An initial full run overlapped
  another task's Olympic selector update; both final runs passed after its
  matching test update. No live ArcGIS band call or regional throughput benchmark
  was performed. No dependency or pack-schema change is required; this feature's
  temporary worktrees and visual-check server were removed.

- [x] 2026-09-22 — implemented the pack-build efficiency audit: prepare OSM
  once with boundary-aware child caches, stream hashes and OPL, share unchanged
  topology, bound temporary metric/sampling batches, and reduce persisted-audit
  allocations and duplicate coverage work. Sources survive native/container
  cache relocation; DEM identity depends on tile content and order; ordinary
  builds reuse verified pins, with explicit offline/refresh modes. Unchanged
  artifacts are audited before activation without graph preparation. Production
  TypeScript shrinks 11 lines; regression tests grow 360; no dependency/schema
  changes. Compiler fixture database bytes and the existing real pack's full
  audit report remain identical. Standalone audit peak RSS falls from 2.081 to
  0.980 GiB and wall time from 34.303 to 20.480 seconds. The current August 1
  Cascades pin built and audited successfully in an isolated 4 GiB container
  with swap disabled: 3.842 GiB cgroup peak, 553 seconds including acquisition,
  approximately 170 seconds after acquisition. Offline warm reuse passed in
  34 seconds with networking disabled; native reuse of the same cache also
  passed, preserving all artifact checksums. Two `npm run verify` passes each
  passed 506 tests in 82 files, lint, types, and build; two browser passes each
  passed seven offline flows. See [full evidence](pack-build-audit.md#implementation-results).
  Existing installed packs and source caches were preserved; validation data
  remains ignored, and completed task worktrees/containers were removed.

- [x] 2026-09-22 — completed a read-only pack-build efficiency and architecture
  [audit](pack-build-audit.md). Reproduced stale boundary-derived caches,
  nonportable source pointers, and retrieval-time-dependent DEM fingerprints
  using offline temporary fixtures. Isolated cached Cascades measurements found
  whole-file hashing at 435–438 MiB peak RSS versus 120–121 MiB with streaming,
  reference-complete extraction at 1.93 GiB, and the persisted audit at 2.05 GiB
  and 35.56 seconds (30.29 seconds in exact coverage). The existing Cascades
  artifact audited with zero errors; 168 focused offline tests passed across
  34 files. These measurements use the older August 6 source, not the current
  August 1 pin. No application code, installed pack, or source cache changed;
  a full regional build and constrained-memory acceptance remain unverified.

- [x] 2026-09-07 — extended step 9 progress with audit substeps, checked/total
  edge counts during exact-coverage validation, and report writing. Coverage
  updates are limited to once per five seconds plus start/completion. Tests,
  builds, and live audits were explicitly skipped at the user's request so
  they can test the commit themselves. Existing audit rules are unchanged.

- [x] 2026-09-07 — replaced the bootstrap command's final JSON dump with one
  `Pack ready: <directory>` line for regional and fixture builds. Detailed audit
  files remain on disk. An isolated fixture CLI run confirmed one stdout line
  and a readable audit file. Two verify passes each passed 480 tests across 81
  files, lint, types, and build; two browser passes each passed seven offline
  flows. The implementation is four lines shorter; no build behavior changed.

- [x] 2026-09-07 — added lightweight detail to pack-build progress. Step 2
  reports per-file MB, known-size percentages, verified cache reuse, and
  successful completion; streaming updates are limited to once per five seconds
  per file. Step 8 reports elevation/segment counts and named-area, access,
  topology, database, and integrity substeps. Existing `--progress` controls all
  output; no dependency or terminal control sequence was added. Offline tests
  cover known/unknown sizes, cache reuse, failed validation without completion,
  phase order, and byte-identical database output with reporting. Two verify
  passes each passed 480 tests across 81 files, lint, types, and build; two
  browser passes each passed seven offline flows. The tools image built and a
  network-disabled container reported 0/5/6 MB for a streamed 6 MB fixture,
  followed by all seven compiler substeps. No regional pack was rebuilt or
  altered. Temporary agent worktree and smoke container were removed.

- [x] 2026-09-07 — repaired the Central Cascades fresh-install 404 by replacing
  the removed Washington August 6 snapshot with the available August 1 pin.
  Verified HTTP 200, 359,826,867-byte length, and the PBF header timestamp;
  updated the source contract test and the compatibility fixture's input hash.
  The container image rebuilt successfully. An isolated empty-cache build
  downloaded and validated all four DEMs and the official trail snapshot, but
  was stopped during the OSM download at the user's request to test personally;
  an end-to-end build of this pin is not yet verified. Two `npm run verify`
  passes each passed 479 tests across 81 files, lint, types, and build; two
  browser passes each passed all seven offline flows. Existing packs and caches
  were untouched. Source policy now records upstream retention and the need to
  check fresh downloads instead of relying on cached builds.

- [x] 2026-09-07 — the pack selector now shows estimated download and finished
  sizes before installation, and measures all files in the current installed
  artifact afterward. Finished estimates are rounded from the five existing
  local builds (Cascades: 404,491,894 bytes including metadata and audits).
  The selector and README explain that source caches are additional. Existing
  offline helper and keyboard tests cover the updated labels; empty-catalog
  and real installed-catalog checks confirm all five regions. Two `npm run
  verify` passes each passed 479 tests across 81 files, lint, types, and build;
  two browser passes each passed all seven offline flows. No dependency, pack
  schema, or generated data changed.

- [x] 2026-09-07 — replaced numbered selector input with up/down navigation,
  Enter toggling, a visible cursor, and an Apply changes row. Checked rows now
  turn green immediately; unchecked rows are gray, with pending installs and
  removals labeled. The README describes the new controls. No dependency was
  added; the Bash script grew by seven lines. Updated offline selector tests
  cover keyboard selection, wrapping to Apply, cancellation, removal guards,
  and build failure. A real pseudo-terminal check confirmed arrow focus,
  immediate ANSI color changes in both directions, and clean quit behavior.
  Two `npm run verify` passes each passed 479 tests across 81 files, lint,
  types, and production build; two browser passes each passed all seven
  offline flows. Pack data, runtime storage, and application behavior are
  unchanged; the completed integration branch was removed.

- [x] 2026-09-07 — added the small `./alpine.sh` regional-pack selector:
  numbered toggles, green checked installations, gray available packs, measured
  approximate download sizes, and explicit removal confirmation. The Compose
  tools profile packages Node, osmium, uv, Python 3.12, and the locked Rasterio
  environment; host users need only Git and Docker. Builds reuse the existing
  compiler and caches. Read-only checks protect unfinished Docker and native
  searches before removal, preserving completed records and source caches.
  The README now leads with selector/startup commands and includes a compact
  architecture diagram and local development instructions. Two verification
  passes each passed 479 tests across 81 files, lint, types, and production
  build; two offline browser passes each passed all seven flows. Actual ARM64
  image builds exposed and resolved Rasterio's GDAL/compiler requirement and
  uv cache permissions for host-mapped users. An isolated, network-disabled
  tools container validated osmium and Rasterio/GDAL and compiled a committed
  fixture; the production app discovered it, returned healthy/job endpoints,
  and retained writable runtime data across restart. Container removal checks
  blocked a native queued search, then removed only the fixture pack after
  completion while retaining its record and cache. The real selector listed all
  five installed packs and quit without changing them. No regional schema or
  real pack changed; a fresh Cascades source download/build was not repeated.
  Temporary verification containers, volumes, agent worktrees, and branches
  were removed after integration.

- [x] 2026-09-07 — flattened the worker asset directory to `public/maplibre/`
  and removed the redundant vendor directory. Updated the runtime worker URL,
  sync/check destination, asset tests, lint exclusion, and README. Both worker
  files remain byte-identical to the installed package. Two `npm run verify`
  passes each passed 446 tests across 79 files, lint, types, and production
  build; two browser passes each passed all seven offline flows. Live localhost
  desktop zoom/pan and 390 px mobile panel scrolling/map switching passed with
  trails and access points rendered and no console errors. Viewport reset.

- [x] 2026-09-07 — guarded the local MapLibre worker pair against dependency
  drift. `npm run maplibre:sync` copies both installed distribution files
  unchanged, preserving license headers; `npm run maplibre:check` rejects
  missing or byte-mismatched assets before dev, build (including Docker), and
  verification. Both current assets already match installed MapLibre 6.1.0;
  no dependency or asset-content change was needed. Tests compare each sibling
  against the installed package. An isolated offline smoke check confirmed
  missing/stale detection, read-only checking, pair repair, and operation from
  another working directory. Two final `npm run verify` passes each passed
  446 tests across 79 files, lint, types, and production build; two browser
  passes each passed all seven offline Chromium flows. Live localhost checks
  confirmed trail/access-point rendering, desktop zoom/pan anchoring, and
  390 px mobile panel scrolling and map switching with zero console errors.
  Viewport override reset; completed test worktree and branch removed.

- [x] 2026-09-07 — reviewed every root file and removed generated
  `next-env.d.ts` from Git and the Docker build context. Type checking now
  generates Next.js declarations first. The browser runner preserves only
  `tsconfig.json` and can start without the generated declaration file.
  Removed local `.DS_Store` metadata and corrected the stale legacy-folder
  note in `AGENTS.md`. The remaining root files have active uses:
  `package.json` and `package-lock.json` define commands and dependencies,
  `next.config.ts` and `tsconfig.json` configure the app and types,
  `eslint.config.mjs` and `vitest.config.ts` configure checks,
  `Dockerfile`, `compose.yaml`, and `.dockerignore` support Docker,
  `.env.example` and `.gitignore` support local setup and data exclusions,
  `README.md` and `AGENTS.md` document usage and development rules, and
  `skills-lock.json` records the installed project skills. Local `.env` and
  the ignored TypeScript build cache remain useful and are retained.
  Two `npm run verify` passes each passed 444 tests across 79 files, lint,
  types, and the production build. Two browser passes each passed all seven
  offline flows. A separate fresh source copy passed type checking with no
  preexisting `next-env.d.ts` or `.next` directory. Final diff checks pass.

- [x] 2026-09-07 — consolidated recent work onto `main` without rewriting
  history. Every local and remote feature branch was already included in the
  current work. Committed the README cleanup, legacy-note removal, and project
  skills with their source lockfile. Two `npm run verify` passes each passed
  444 tests across 79 files, lint, types, and the production build. Two
  `npm run test:browser` passes each passed all seven offline Chromium flows.
  Removed two trailing blank lines found by the final diff check. Archive and
  prototype tags are preserved. Generated packs, caches, secrets, and runtime
  databases remain local and ignored by Git.

- [x] 2026-09-07 — distinguished trailhead quantities from result identifiers.
  Trailheads now use a small location dot with a plain rectangular native label
  reading "1 route" or "6 routes"; result numbers retain their circular badges.
  Labels and dots both open the trailhead group, with marker priority over
  underlying route lines. The local stretchable label image adds no dependency
  or external asset request. Native collision handling and exact dot anchoring
  remain intact. Existing map tests cover label configuration and label clicks;
  two final verify passes each pass 444 tests across 79 files, lint, types and
  build, and two browser passes each pass all seven offline Chromium flows.
  Live Sunol desktop/mobile checks confirm distinct shapes, legible labels,
  and clicking "6 routes" opens the six-route group, with no console errors.
  Responsive override reset. Original saved data and unrelated edits preserved.

- [x] 2026-09-07 — adopted the accepted native trailhead-map prototype and
  completed the route hover/selection audit changes. Overview begins without a
  selected route; marker clicks scope the current page and route-line clicks
  open the same route they preview, including overlapping scoped geometry.
  Green previews draw above context with crisp light casing. Orange is reserved
  for route detail, with an independent trailhead-filter ring. Muted context
  color plus lower opacity prevents stacked alternatives from becoming too dark.
  Segment targets exist only in detail; hovered and selected segments have
  distinct list treatments. Back restores row focus, hover never scrolls the
  panel or reframes the map, and pan/drawing/hiding clears transient emphasis.
  Pointer preview falls back to the focused row when leaving the list target.
  Against `74d7949`, application/styles shrink 145 lines and tests grow 236
  (91 more combined); no dependencies or public data contracts changed.
  Two final `npm run verify` passes each pass 444 offline tests across 79 files,
  lint, types and production build; two final `npm run test:browser` passes
  each pass all seven Chromium flows. Browser coverage includes native marker
  clicks, scoped original numbering, route-line preview/click agreement,
  segment preview versus selection, Back focus, and mobile panel switching.
  Live localhost:3000 Sunol checks confirm neutral overview, foreground keyboard
  preview, native six-route trailhead filtering, detail and segment emphasis,
  and 390×844 map/panel switching with document width 390 and scroll position
  zero. Zooming clears temporary previews; no console errors observed. The
  viewport override was reset. Original packs and saved routes are retained;
  completed subagent worktrees/branches removed. The earlier port-3002 snapshot
  remains available only as the original prototype comparison.

- [x] 2026-09-07 — completed an isolated native trailhead-map prototype; adoption
  remains pending comparison. Preserved as `prototype/native-map-2026-09-07`
  (`ea065a0`), with [measurements and tradeoffs](native-map-prototype.md).
  Replaces custom generated-route marker grids/clustering with native counts
  and a trailhead-scoped results list. Against `bbbd77f`, application/styles
  shrink 167 lines and tests grow 24 (143 fewer combined). Two verify passes
  each pass 436 tests across 79 files, lint, types and build; two browser passes
  each pass seven offline Chromium flows. Live copied Sunol results confirm
  rendered counts, details/Back and mobile map/panel switching with no console
  errors. Separate preview runs from `/private/tmp/alpine-native-preview` on
  port 3002; active application source, original data and dependencies unchanged.
  Prototype worktree/branch removed after preserving the tag.

- [x] 2026-09-06 — simplified the UI into one Plan/Results/detail panel beside
  a persistent map, with a full-map switch on mobile and the original compact,
  neutral visual language. Added direct 1–20 route-count selection; retained
  editable criteria separately from viewed result snapshots, cancellation and
  stale-response rejection, saved jobs, exact/close classification, and all
  route details. List keyboard navigation previews without replacing the list;
  explicit activation opens details and Back restores focus. Corrected the
  results close button to fit its compact header without border clipping.
  Removed the block-layout override that collapsed the loading spinner; Quick
  search uses rotation normally and a non-spatial opacity pulse for reduced
  motion. Live Quick search confirms the pulsing indicator and completion.
  Six generated map geometry sources become two; recorded lifecycle tests show
  zero additional geometry uploads on route/segment hover and only a segment
  upload when the selected owner changes. Full ordered route identity now
  controls framing, drawing suppresses ordinary feature gestures, and container
  resizing and late-load cleanup are covered. Relative to `b974f98`, application
  and style source is 138 lines smaller; test/helper source grows 303 lines
  (165 more combined). No measured wall-clock rendering speedup is claimed.
  Two final `npm run verify` passes each pass 435 offline tests across 79 files,
  lint, types, and production build; two final `npm run test:browser` passes
  each pass all seven Chromium flows. Live in-app localhost checks cover real
  saved Sunol results, details and Back, desktop zoom/pan anchoring, mobile
  internal scrolling (document stays at zero), full-map switching, and the
  close-button border with no console errors. The 390×844 responsive override
  was reset after inspection. Installed packs, saved databases, contracts, and
  dependencies remain unchanged; completed agent worktrees/branches removed.

- [x] 2026-09-06 — investigated unified closed-walk replacement search; rejected
  adoption and removed the experimental code. The prototype uses about 59% less
  search-module code under common formatting, but the pipeline is slower at
  eight of nine sampled starts, alternatives are mixed, and small departure/rejoin
  quality remains unresolved. See [unified-search-investigation.md](unified-search-investigation.md)
  for all measurements and the historical experimental snapshot (`73ffdce`).
  All 35 fixed-work cases across raw/pipeline layers are deterministic over
  three measurements with matching inputs and zero directed-validation rejects;
  the separate live-deadline Cascades case reports truncation. Eleven independent
  quality checks pass both implementations. Before cleanup, two verify passes
  each pass 438 tests, lint, types and build; two browser passes each pass six
  flows. Final application/test/benchmark source matches `f7b5209`; current solver,
  installed data and saved jobs are unchanged. Agent worktrees are removed.

- [x] 2026-09-06 — solver efficiency and route-quality exploration, documented in
  [solver-efficiency.md](solver-efficiency.md) and
  [principled-route-model.md](principled-route-model.md). Direction-safe corridor
  contraction accelerates core search 3.6–16.2 times at five measured installed
  starts; validated exact alternatives increase from 11 to 30. Summed pipeline
  medians fall from 5.25 to 4.05 seconds, although Henry Coe is slower while
  returning more alternatives. Corrected non-monotone repetition filtering
  recovers a valid 6.1 km chained loop. Per user preference, short side loops and
  retraced spurs are removed before metrics and exact/close classification.
  All 31 fixed-work cases across raw/pipeline layers and five real-deadline
  cases are deterministic across three measured repetitions, with matching
  inputs, zero directed-validation rejections and zero deadline truncations.
  Per-route quality tradeoffs remain explicit in the report; this is not a
  universal quality improvement. Application solver code grows 71 lines
  (2,261 → 2,332); tests add 273, benchmark tooling 344. The separate 153-line
  mathematical oracle passes 57,672 bounded selections and establishes an
  objective/constraint reference, not a production solver replacement.
  Two `npm run verify` passes each pass 427 tests across 78 files, lint, types
  and build; two `npm run test:browser` passes each pass six flows. Live localhost
  saved-route, desktop zoom/pan alignment and 390 px internal-scroll checks pass
  with no console errors. No API, pack schema or dependency changes; installed
  artifacts and saved jobs remain intact. Agent worktrees and branches are removed.

- [x] 2026-09-06 — original-graph feasibility compilation, implemented through
  `3efccf4` and documented in [feasibility-compilation.md](feasibility-compilation.md).
  Removes 429 application lines; adds 235 test/helper lines, for 194 fewer
  combined against `90100fd` (new legacy JSON fixture: 155 separate data lines).
  Fixes the one-way dead-end minimum-stem defect. Format-2 profiles use versioned
  regional build identities; format-1 packs retain independent hash validation.
  The frozen 42-case solver matrix preserves 22 exact routes, 8 close matches,
  6,168 expanded states and 102 graph queries, allowing only version/group
  metadata changes. The full fixture retains 117 of 126 SQLite rows; remaining
  changes are the intended identities, versions and hashes. All 88 Henry Coe
  feasibility/stem facts and original graph identities match. Five samples per
  compiler give median stage times of 2,703 ms versus 372 ms on that graph;
  process peak RSS falls from 621.6 to 463.9 MiB, with measurement limits in the
  report. Two `npm run verify` passes each pass 412 tests across 77 files, lint,
  types and production builds; two `npm run test:browser` passes each pass six
  flows. All five installed packs pass read-only audits and feasibility readers
  with zero errors; existing disconnected-component/rejected-edge warnings
  remain. Live localhost saved results, desktop map zoom/pan anchoring and
  mobile internal scrolling pass without console errors. Installed artifacts,
  current pointers and saved jobs remain unchanged; the correction applies to
  newly built packs. Completed agent worktrees and branches are removed.

- [x] 2026-09-06 — further simplification assessment, documented in
  [simplification-assessment.md](simplification-assessment.md). Recounted 19,464
  application and 9,338 test/helper lines; reviewed four clusters and compared
  three interfaces in parallel. Following the user's allowance for justified
  behavior changes, recommend original-graph feasibility with SCC-local cycle
  approaches. An isolated production-function experiment reproduced a 100 m
  minimum stem incorrectly becoming 0 m after adding a one-way dead-end
  triangle. Attachment groups are diagnostic, not search scheduling inputs.
  Estimated compiler reduction is 280–380 application lines, with 70–140 test
  lines likely added; implementation and quality/performance comparison were
  pending at assessment time (now completed above). Focused offline suites passed 148 tests across 19 files. No
  application, test, installed-pack, or saved-job changes; no implementation
  verification gate is claimed. The report specifies old/new profile readers,
  new build identities, independent audits and pinned-artifact retention.

- [x] 2026-09-06 — regional pack consolidation: all five builders share one
  preparation and publication process, preserving regional restrictions and
  acceptance checks. Relative to `dff1b43`, application and test code has 1,112
  fewer lines. Ten frozen pre-change comparisons pass; two final
  `npm run verify` runs each pass 403 offline tests across 77 files, lint,
  types, and build; two `npm run test:browser` runs each pass all six flows.
  All five installed packs pass read-only audits with zero errors. Live
  desktop/mobile saved results, map zoom/pan anchoring, and internal scrolling
  pass. Implementation is integrated through `44aff4e`; temporary worktrees
  and branches are removed. See [regional-pack-consolidation.md](regional-pack-consolidation.md)
  for compatibility limits, report changes, measured optimization, and evidence.

- [x] 2026-09-06 — whole-repository architecture review and improvements,
  documented in [architecture-review.md](architecture-review.md). Six focused
  changes simplify topology preparation, share artifact/route identity rules,
  remove unused elevation and solver code, bound request reading, and repair
  dialog focus through one shared owner. Relative to `aaae59f`, application
  source is 240 lines smaller; tests/helpers add 130 lines, for 110 fewer lines
  combined. Two final `npm run verify` runs each pass 394 offline tests across
  76 files, lint, types, and production build; two `npm run test:browser` runs
  each pass all six flows. The fixture manifest and 126 rows across 32 tables
  are unchanged; six deterministic solver responses are byte-identical and all
  five installed packs validate. Live desktop/mobile map, saved results,
  internal scrolling, and dialog keyboard checks pass. Implementation is
  integrated through `6a14e84`; temporary worktrees/branches are removed.

The full revision is tracked in [system-design.md](system-design.md). All original
rebuild gates below are historical completions, not acceptance of the new goal.
The revision starts from `810e44c` and is complete through `b097b6d` on
`codex/system-design`. All nine system-design acceptance items are complete.

The full change covers geographic application operations, workspace and saved
result ownership, ordered preferences, map updates, reusable engine sessions,
transport-independent domain results, audited publication, one graph format,
and production-storage fixtures. Final source is 20,485 lines, 3,114 fewer
than baseline. Tests/helpers are 9,019 lines, 2,023 fewer. No dependency was
added. Two final verify passes each pass 383 offline tests, lint, types, and build;
two final browser passes each pass all six flows. Live desktop/mobile checks and
current-data comparisons pass with the limitations recorded in system-design.md.
All delegated worktrees are removed. The application is available locally on
port 3000. Original saved jobs and installed artifacts remain intact.

- [x] Gate 0 — active app scaffold, shared contracts, fixture graph
  - Evidence: `npm ci` and `npm run verify` pass on Node 24.11.0; 14 boundary/fixture tests cover request, response, manifest, and all four fixture route shapes; Next.js 16.3.0 production build succeeds with `legacy/**` and generated data excluded.
- [x] Gate 1 — map shell, pack pipeline skeleton, solver foundation
  - Evidence: `npm run verify` passes with 57 offline tests across 11 files and a successful Next.js production build; focused compiler/solver/UI suites pass; live local browser check loaded USGS MapLibre, drew/edited/cleared a hard rectangle, and loaded the in-bound fixture access point. Fixture bootstrap smoke build publishes 7 nodes, 17 directed edges, 2 access points, manifest, audit, and SQLite pack atomically.
- [x] Gate 2 — end-to-end route generation on committed fixtures
  - Evidence: `npm run verify` passes with 95 deterministic offline tests across 15 files and a successful production build; `npm run test:browser` passes 2 Chromium flows (draw/configure/generate/inspect and impossible constraints with labeled close matches) using an in-memory tile fixture; direct local API smoke returned 3 exact routes in 31 ms with validated geometry, metrics, warnings, provenance, and diagnostics.
- [x] Gate 3 — Santa Cruz Mountains pack and full local UX
  - Evidence: the reproducible schema-1 pack `scm-561dc87c0f4a6bed`
    contained 430,766 nodes, 875,166 directed edges, 3,215 access points,
    four pinned sources, complete elevation, and no unattributed records.
    Historical scenario commands and fixtures are preserved in Git rather than
    kept as dormant active tooling.
- [x] Gate 4 — trailhead-filter redesign, hardening, accessibility, deterministic tests, documentation
  - Evidence: the active API strictly validates `GenerateRoutesRequestV2`; Draw area, installed Named region, and ArcGIS typical Drive time filters resolve eligible trailheads without clipping hiking geometry, while exact pack coverage remains a runtime-validated route boundary. The rebuilt schema-2 Santa Cruz pack (`scm-a339bce45af76f29`) contains 425,302 nodes, 863,917 directed edges, 3,207 access points, and 476 locally searchable named areas; its persisted audit reports zero outside-coverage persisted edges, zero missing elevation values, zero unattributed records, and 11,249 rejected source edges crossing concave coverage. The offline V2 installed-pack matrix passes 25/25 runs with a 2,641.350 ms slowest typical search; its targeted regression returns an exact 8.00-mile, 1,842-foot lollipop for the previously empty 6–10 mile / 1,500–2,500 foot request. Metric-preserving graph compression, target-directed alternative-return search, adaptive edge allocation, and topology classification cover simple loops, figure-eights, chained cycles, repeated connectors, lollipops, and out-and-backs. `npm run verify` passes 269 offline tests across 51 files plus the production build; two consecutive `npm run test:browser` runs each pass all seven Chromium flows. A temporary clean clone passed `npm ci` with zero vulnerabilities and the complete `npm run verify`; all subagent worktrees and branches were removed.

- [x] Gate 5 — closed-route engine
  - Evidence: the V3-only reachable-graph engine, schema-3 feasibility profiles,
    topology labels, repetition controls, directed reconstruction, exact/near
    separation, cancellation, and deterministic fixtures pass the complete
    suite. The real schema-3 checkpoint returned only validated routes with zero
    directed-validation rejections and deterministic repeat counts. Quick found
    7 representative exact routes versus 3 for Thorough; the non-monotonic
    heuristic behavior is documented in `closed-route-topology-plan.md` and the
    batch runner now preserves the Quick baseline before adding Thorough results.

- [x] Gate 6 — unified route builder and persistent batch jobs
  - Evidence: one shared origin/drive-time/reviewed-region form exposes explicit
    Quick and Batch actions, with an optional collapsed drawn-boundary override.
    Persistent SQLite FIFO jobs recover checkpoints, pin pack versions, retain
    partial cancellations, delete transactionally, and page exact-first results.
    A dedicated per-job solver process isolates CPU-heavy Quick/Thorough work
    from the app/API event loop, while the FIFO coordinator bounds drive-time
    resolution, yields at setup/checkpoint boundaries, terminates active solving
    on cancellation, and recovers interrupted cancellation requests without
    stranding a queued job.
    The UI serializes polling, rejects stale responses and duplicate launches,
    and advances elapsed time locally between server snapshots. `npm run verify`
    passes 317 tests across 60 files plus the production build;
    two consecutive `npm run test:browser` runs each pass all four Quick,
    Batch/Jobs, drawn-boundary, and mobile/dialog flows. The real schema-4 Santa
    Cruz pack `scm-c0d3a8aca0653798` contains 425,302 nodes, 863,917 directed
    edges, 3,207 access points, 476 named areas, and all 8 reviewed search
    regions, with zero audit errors, missing elevation/population values,
    conflicts, integrity errors, or foreign-key errors. Its representative
    Thorough checkpoint returned only validated routes with zero directed
    validation rejections.

- [x] Gate 7 — multi-pack foundation and catalog-driven region selector
  - Evidence: the validated version-1 catalog exposes all six roadmap regions
    through `GET /api/packs`; only explicitly linked, valid installed packs enter
    the generic builder/route registries, while planned and malformed/missing
    links remain disabled and the fixture is used only when no valid linked pack
    exists. Generic build dispatch and official-source cache namespaces remove
    the Santa Cruz bootstrap assumptions. Header pills preserve catalog order,
    use URL-driven pack remount/reset, and restore cross-pack Jobs through a
    one-time job URL. Two consecutive `npm run verify` runs each pass 357 tests
    across 68 files plus the production build, and two consecutive `npm run
    test:browser` runs each pass all five Chromium flows. Live desktop/mobile
    inspection with the real Santa Cruz pack confirmed the green selected state,
    disabled undotted roadmap pills, horizontal overflow at 390 px without
    displacing Jobs/Settings, and zero browser console errors.
- [x] Gate 8 — Southern East Bay regional pack
  - Evidence: the reviewed concave boundary covers Pleasanton Ridge, Mission
    Peak, Vargas Plateau, Sunol, the Ohlone corridor, and Del Valle while its
    retained OSM inventory excludes Mount Diablo, the Berkeley/Oakland hills,
    Henry Coe, and Stanislaus. Schema-5 pack `seb-7f40689cb63a6971` pins six
    licensed/provenanced inputs: Geofabrik OSM, EBRPD Roads and Trails by
    Access, EBRPD Park Entrances, a human-reviewed current-closure overlay,
    USGS 3DEP, and GHSL population. Its clean regional audit records 248,750
    nodes, 506,597 directed edges, 2,131 access points, 364 named areas, four
    reviewed search regions, zero conflicts, zero missing elevation/population,
    zero unattributed records, and zero outside-coverage persisted edges. The
    closure overlay suppresses older public evidence and closes all three
    pinned Shady Glen Trail ways. Two independent offline builds were byte-for-
    byte identical: manifest SHA-256 `43077fd1de6a6603cd1243e6f0a3dc312b64e60abeca68d49e3a53c27be992b7`
    and SQLite SHA-256 `f302202e60f9996af7c51929b8e4e4890681907a1a37c9e05f0da5d6f234483c`,
    with matching core and regional audits and access-join report. The Thorough
    real-pack checkpoint passed exact and explicitly labeled impossible/near-
    miss searches for all six representative clusters (30 exact routes total,
    zero directed-validation rejections). Registry/API discovery exposes the
    installed pack as available; live inspection confirmed selection, all four
    reviewed region choices, correct East Bay map coverage, and zero browser
    console errors. Two consecutive `npm run verify` runs each pass 376 tests
    across 74 files plus the production build, and two consecutive `npm run
    test:browser` runs each pass all five Chromium flows.
- [x] Gate 9 — Monterey Peninsula and Carmel Valley regional pack
  - Acceptance: the approved multi-agency boundary covers the planned
    Monterey–Carmel systems and only necessary northern Los Padres connections,
    while excluding deep Big Sur, Ventana, and broader Los Padres; pinned
    sources and licenses, two identical offline builds, a clean audit,
    representative exact/near-miss searches, and activation checks satisfy the
    [regional onboarding protocol](regional-expansion-plan.md).
  - Evidence: the reviewed boundary bbox `[-121.985, 36.32, -121.66,
    36.715]` contains Fort Ord, Palo Corona, Garland/Kahn, Point Lobos, and
    Garrapata while excluding deep Big Sur, Ventana, and broader Los Padres.
    Schema-5 pack `mc-8cd6885ec6e0215a` pins five attributed sources and
    contains 134,167 nodes, 272,717 directed edges, 1,650 access points, 168
    named areas, and five reviewed search regions. Its core and regional audits
    report zero errors, conflicts, missing elevation/profile/population values,
    unattributed records, unknown source references, or persisted edges outside
    coverage. The reviewed official overlay preserves BLM signed-trail rules,
    MPRPD entrance permit/parking conditions, State Parks designated-trail and
    hours conditions, and closes only Rocky Ridge ways `55856070` and
    `55856129`; the USFS line cross-check remains unknown-only, and the unusable
    State Parks ArcGIS layer is explicitly excluded. Two fresh offline builds
    were byte-identical: manifest SHA-256
    `9b1731fcd42e532ca5ad3e69572a42b9beca682f7c80454ccec01c2d58086945`
    and SQLite SHA-256
    `d814b48b3d841ceb124bca70e9fab47799381801cc7752dd0e258e3a3bc843f8`,
    with matching core, regional, and access-join audits. The Thorough checkpoint
    passed all six clusters with 28 exact routes, a labeled close match for every
    deliberately impossible request, and zero directed-validation rejections.
    Catalog/API inspection exposes Monterey as available and selected and
    returns all five reviewed regions. Two consecutive `npm run verify` runs
    each pass 386 tests across 77 files plus the production build, and two
    consecutive `npm run test:browser` runs each pass all five Chromium flows.
- [x] Gate 10 — Henry Coe regional pack and schema-6 onboarding optimization
  - Evidence: the exact `MultiPolygon` union of Henry W. Coe State Park and
    adjoining Coyote Lake–Harvey Bear Ranch has bbox `[-121.596281,
    37.0324441, -121.3058921, 37.3111329]`; Grant, Pacheco, Coyote Ridge,
    Cñada de los Osos, Palassou, private ranches, and other disconnected South
    Diablo systems remain excluded. Schema-6 pack `hc-fb46538de42e5919` pins
    the ODbL Geofabrik `norcal-260801` extract and public-domain USGS 3DEP
    product `68afba8fd4be02645f9b293f`. Current authority review produced no
    confirmed durable exact-way removal and generic OSM portal labels were
    sufficient, so no empty restriction file or official-name overlay was
    invented and `officialAccess` remains false.
  - Two independent offline builds both executed rather than reusing an output
    and were byte-identical: manifest SHA-256
    `075c9a5cdd786a83f7c673c09f73352cf21749edaa0f7d5fdeef41408756185a`
    and SQLite SHA-256
    `924ec8f8ab47690c1c0717431e3f3c0f9aa0bd3aaea24dbc3010f78c4877cbed`,
    with matching core, regional, and portal audits. The pack contains 28,801
    nodes, 57,830 directed trail edges, 44 persisted portals, seven named
    areas, and three reviewed search regions. It has zero audit errors,
    conflicts, built-up portals, missing elevation/profile values,
    unattributed/unknown-source/outside-coverage records, non-trail published
    edges, integrity errors, or foreign-key errors. Inclusive cycle checks keep
    39 portals and reject five; build context stripped 99 road/sidewalk/service
    ways.
  - The shared schema-6 Thorough checkpoint enforces a 500 m reference-to-
    portal limit and passed Coe Ranch, Hunting Hollow, Dowdy, Mendoza, and
    Harvey Bear with 25 exact routes, honestly labeled close matches for every
    deliberately impossible request, and zero directed-validation rejections.
    Coyote Lake main is explicitly deferred rather than snapped to a portal 830
    m away. The new generic builder/checkpoint, immutable DEM reuse, and
    [region checklist](region-onboarding-checklist.md) capture the reusable
    workflow and friction ledger. Catalog/API discovery exposes Henry Coe as
    available. Two consecutive `npm run verify` runs each passed 372 tests
    across 74 files plus the production build, and two consecutive `npm run
    test:browser` runs each passed all five Chromium flows. Live desktop and
    390 px inspection confirmed the selected Henry Coe pill, exact map coverage,
    all three region choices, horizontally scrolling region controls, and zero
    browser console errors.

- [x] Gate 11 — Central Cascades regional pack
  - Acceptance: the approved concave, cross-crest boundary keeps the complete
    Glacier Peak–Alpine Lakes corridor, Napeequa/Chiwawa, Lake Wenatchee,
    Stevens/Leavenworth/Icicle, Snoqualmie/Cle Elum, and Teanaway whole while
    excluding North Cascades/Pasayten, Rainier/Goat Rocks, disconnected Puget
    lowland systems, and the Columbia Basin. A pinned Washington OSM snapshot,
    exact USGS 3DEP products, source/license review, two byte-identical offline
    schema-6 builds, clean audits, representative exact and honest close-match
    searches, activation checks, and two consecutive verify/browser runs must
    pass the regional onboarding protocol before the catalog link is added.
  - Evidence: the reviewed concave cross-crest boundary has bbox
    `[-121.73319523634241, 47.19654585917808, -120.5276988, 48.4758823]`
    and keeps the complete Glacier Peak–Alpine Lakes corridor, public
    approaches, and Teanaway inside the hard coverage boundary. Schema-6 pack
    `cc-08431d5c52dd80f2` pins the dated Geofabrik Washington
    `washington-260806` OSM extract plus the four exact USGS 3DEP products
    `689d4591d4be027ac1589940`, `689d4591d4be027ac158993e`,
    `689d4591d4be027ac158993a`, and `689d4590d4be027ac1589938`.
  - Two independent offline builds both executed and were byte-identical:
    manifest SHA-256
    `35f1456b33b26749c2c0f9d67f1804aeda8745efa5a137b040fc7648f1a9f919`
    and SQLite SHA-256
    `d97e75b94ef9ba1055f9e5cebceed6863ea742ae361cff0a0e2c788840d9776b`,
    with matching core, regional, and portal audits. The pack contains 265,331
    nodes, 527,755 directed trail edges, 566 persisted portals, 29 named areas,
    and four reviewed search regions. It has zero audit errors, conflicts,
    missing elevation/profile values, unattributed/unknown-source records,
    outside-coverage persisted edges, published road-context edges, integrity
    errors, or foreign-key errors. Inclusive topology keeps 258 cycle-bearing
    portals and rejects 308 no-cycle starts; the build strips 4,967 road,
    sidewalk, and service-road context ways.
  - Glacier Peak and Alpine Lakes use the shared 500 m named-region portal
    approach band rather than pack-specific geometry. Measured default-eligible
    portals sit 49–219 m and 91–489 m outside their legal wilderness boundaries,
    respectively. Drawn and drive-time filters remain exact. The remaining
    distance-only limitation and a topology-aware replacement are tracked in
    GitHub issue #24; Little Giant remains an eligible selector portal but is
    not misrepresented as an exact-route checkpoint after the Thorough solver
    exhausted its large-component search budget there.
  - The final Thorough checkpoint passed all eight representative clusters with
    an exact route and honestly labeled close match for every scenario and zero
    directed-validation rejections. Catalog/API discovery exposes Central
    Cascades as available. Two consecutive `npm run verify` runs each passed
    431 tests across 81 files plus the production build, and two consecutive
    corrected `npm run test:browser` runs each passed all six Chromium flows.
    Live desktop and 390 px checks confirmed selection, all four region choices,
    horizontal mobile overflow (`846 px` content in a `374 px` strip), and zero
    browser console errors.

- [x] Gate 12 — remaining Washington Cascades and Olympic Peninsula setup
  - Evidence: reserved `north-cascades`, `rainier-goat-rocks`,
    `southwest-cascades`, and `olympic-peninsula` in the version-1 catalog
    without activation links or builders. The [Cascades brief](washington-cascades-packs.md)
    and [Olympic brief](olympic-peninsula-pack.md), reviewed 2026-09-22 against
    linked primary agency and source pages, define proposed systems, seam and
    authority questions, candidate selectors, checkpoint clusters, source
    policy, and per-pack preflight. Olympic beach trails, including Ozette's
    beach leg, are in scope; tide timing remains a recorded later limitation.
    The roadmap and onboarding checklist reflect the current geographic
    workspace and local installer. The Central Cascades charter now matches
    its configured August 1 Washington OSM source. The registry example
    matches the committed JSON, local document links resolve, and focused
    catalog/selector tests pass 27/27. Two `npm run verify` passes each pass
    506 offline tests in 82 files, lint, types, and production build; two
    `npm run test:browser` passes each pass seven offline flows. No exact new
    boundary, source pin, pack build, or activation is claimed.
- [x] Gate 13 — North Cascades regional pack
  - Evidence: the [North charter](../../data/regions/north-cascades/charter.md)
    records the v3 hard boundary around Baker, Highway 20, Stehekin, Methow,
    and Pasayten; the deliberate Central PCT–South Fork Agnes overlap; and two
    narrow 49°N insets where USGS 3DEP has no elevation data. The pinned August
    1 Washington OSM snapshot is ODbL; four pinned USGS tiles are public
    domain, with product IDs, bytes, and SHA-256 receipts in the charter.
    Refresh plus two fresh offline builds produced identical schema-6
    `nc-989d91f71a1d0be6` manifests, SQLite, and three audit files (all five
    SHA-256 values in the charter). Audit: 224,334 nodes, 447,092 directed
    trail edges, 631 portals, 38 built-up, 303 inclusive/42 known
    cycle-feasible, 282 default-eligible, 625 components, zero errors,
    outside edges, missing elevation, non-trail published edges, or SQLite
    integrity/foreign-key issues. All eight Thorough and eight Quick scenario
    pairs returned exact and labeled impossible-request close routes with zero
    directed validation rejections; the final checkpoint was rerun from the
    integration checkout after fixing long-route DFS stack overflow. Live
    Artist Point Quick returned an exact 18.4 km route. Crescent Mine's sole
    eligible selector portal reaches the Sawtooth polygon by 606 m of mapped
    trail. Cascade Pass remains covered but cycle-poor, and a South Fork Agnes
    ford and South Creek restriction lead remain explicit later reviews.
- [x] Gate 14 — Rainier–Goat Rocks regional pack
  - Evidence: the [Rainier charter](../../data/regions/rainier-goat-rocks/charter.md)
    records the exact v1 park/wilderness and PCT approach envelope, all 76
    mapped Wonderland ways, north overlap with Central, and the upper Cispus
    overlap with Southwest. August 1 OSM ODbL and five public-domain USGS 3DEP
    products are pinned with receipts. After one source refresh, two independent
    offline builds produced byte-identical schema-6 `rgr-9037762d7a78ff57` outputs;
    the charter has all five published-file SHA-256 values. Audit: 182,673
    nodes, 364,899 edges, 853 portals, 28 built-up, 317 inclusive/69 known
    cycle-feasible, 303 default-eligible, 749 components, zero errors,
    outside edges, missing elevation, non-trail edges, or SQL integrity/foreign
    key issues. Ten Thorough scenario pairs passed with zero directed
    rejections; three Quick spots passed. William O. Douglas and Goat Rocks
    selectors have reviewed trail entry; Rainier National Park and Norse Peak
    selectors remain deferred for disconnected fringe starts. Live Pear Butte
    Quick returned an exact 18.6 km route.
- [x] Gate 15 — Southwest Cascades regional pack
  - Evidence: the [Southwest charter](../../data/regions/southwest-cascades/charter.md)
    records the v1 Mount St. Helens, Adams, Gifford Pinchot, upper Cispus, and
    Silver Star–Tarbell coverage, excluding the Yakama Reservation and Oregon.
    August 1 OSM ODbL and four public-domain USGS 3DEP products are pinned with
    receipts. Refresh plus two fresh offline builds produced byte-identical
    schema-6 `swc-f877817cbcde78fe` outputs; all five SHA-256 values are in
    the charter. Audit: 176,693 nodes, 352,490 edges, 839 portals, five
    built-up, 325 inclusive/26 known cycle-feasible, 324 default-eligible,
    729 components, zero errors, outside edges, missing elevation, non-trail
    edges, or SQL integrity/foreign-key issues. All nine Thorough and Quick
    scenario pairs passed with zero directed rejections. Cody's nearest portal
    is no-cycle; the source-backed Blue Lake start passed instead. Live Blue
    Lake Quick returned an exact 22.88 km route. Rainier/Southwest share 3,062
    forward edge IDs (86.257 km) with identical geometry and access state.
- [x] Gate 16 — Olympic Peninsula regional pack
  - Evidence: the [Olympic charter](../../data/regions/olympic-peninsula/charter.md)
    records the four-part v1 park/forest hard boundary and reviewed mountain,
    rainforest, and coastal systems. The mapped Ozette beach travelway and
    inland arms form a compiled route; unreviewed tribal approaches and some
    boundary-crossing coastal ways remain excluded. August 1 OSM ODbL and six
    public-domain USGS 3DEP products are pinned with receipts. After one source
    refresh, two fresh offline builds produced byte-identical schema-6
    `op-34b052c73d4a5711` outputs; all five SHA-256 values are in the
    charter. Audit: 128,029 nodes, 255,244 edges, 407 portals, one built-up,
    128 inclusive/39 known cycle-feasible, 127 default-eligible, 446
    components, zero errors, outside edges, missing elevation, non-trail
    edges, or SQL integrity/foreign-key issues. All nine Thorough scenario
    pairs passed with zero directed rejections. Live Ozette Quick returned a
    14.25 km Cape Alava–beach–Sand Point route. A real Full search completed
    with one exact route, restored after restart, and showed the older-map-data
    label against a separate empty pack root. Tide and surf passability remain
    unmodeled and require trip-time checking.
  - Shared activation: catalog links and measured installer size metadata were
    added for all four packs. Two `npm run verify` runs each passed 553 offline
    tests in 88 files, lint, types, and production build; two corrected offline
    `npm run test:browser` runs each passed seven Chromium flows. The first
    browser invocation could not bind localhost inside the filesystem sandbox;
    both full passes succeeded with local-server permission. The live catalog
    listed every retained selector; four representative map windows returned
    trails and starts, and all four real Quick API calls returned exact routes.
    Desktop and 390 px mobile checks showed all four choices, keyboard Escape,
    mobile map switching, no horizontal overflow, and zero browser/page errors.
    Basemap tile availability was not established in this local run. Generated
    packs, downloads, caches, receipts, and runtime databases remain ignored.

- [x] Gate 17 — Central Cascades West Cady Ridge correction
  - The prior hard boundary omitted every mapped West Cady Ridge Trail vertex,
    and the generic portal rule omitted the mapped North Fork Skykomish
    trailhead because its path meets a walkable OSM track rather than a
    street/service-road context way. Central boundary v2 adds the pinned Wild
    Sky and Henry M. Jackson wilderness outlines plus the measured trailhead
    approach, preserving the original bbox and all original coverage. Generic
    portal derivation v4 requires an exact OSM trailhead node at a usable
    track/non-track trail junction; nearby markers and track-only contacts do
    not create starts. The [Central charter](../../data/regions/central-cascades/charter.md#v2-west-cady-acceptance-2026-09-23)
    records the review, source decisions, and all six artifact hashes.
  - Two fresh, independent offline builds from the pinned August 1 Washington
    OSM, existing 3DEP collection, and July USGS Trails source produced
    byte-identical schema-6 `cc-d9160473291fdf6b` artifacts. Audit: 279,344
    nodes, 555,865 directed edges, 573 persisted portals, 270 inclusive and
    64 known cycle-feasible portals, 30 named areas, four reviewed search
    regions, zero errors/conflicts, missing elevation, outside-coverage edges,
    non-trail published edges, or SQLite integrity/foreign-key failures.
    The North Fork Skykomish portal is 23.0 m from the mapped trailhead and is
    high-confidence with unknown access (default included). All nine Thorough
    scenario pairs passed exact and labeled-impossible close expectations with
    zero directed-validation rejections. Direct result inspection confirmed a
    23.92-mile simple loop with 8.05 miles of West Cady Ridge Trail, 7,697 ft
    gain, and no repeated trail. Two mapped fords remain trip-time conditions.
  - The locally activated pack's six files match the validated build hashes.
    The live catalog lists Central Cascades; the live map API returns the
    North Fork Skykomish trailhead and 12.96 km of named West Cady Ridge Trail
    in its viewport. Two `npm run verify` runs each passed 556 offline tests in
    88 files, lint, types, and production build; two `npm run test:browser`
    runs each passed seven Chromium flows. The temporary boundary and portal
    worktrees/branches were removed; generated packs and caches remain ignored.

## Post-gate fixes

- 2026-08-10 — added the Central Cascades official-trail conflation pipeline,
  initially validated in an isolated pack root on
  `codex/central-cascades-official-trail-conflation`. A pinned
  July 2026 USGS National Digital Trails extract supplements OSM only through a
  generic, audited matcher: explicit hiking/terrestrial eligibility, 100 m
  represented-geometry removal, 500 m minimum gaps, component attachment,
  duplicate rejection, exact provenance, unknown access, and alignment-aware
  junctions. Experimental schema-6 pack `cc-f1cb28a4ceb6e896` publishes 107.809
  km across 6,075 physical USGS-derived edges with zero audit, provenance,
  coverage, integrity, conflict, or elevation errors. Spider Gap adds a 3.31 km
  segment attached to OSM at both ends, including the reviewed southern
  junction at `[-120.8826971, 48.1701963]`. The quick eight-cluster checkpoint
  passed every exact and impossible expectation with zero directed-validation
  rejections. On 2026-08-23, the validated build was promoted into the normal
  local five-region pack root, with the prior Central Cascades build retained
  locally for rollback. The copied manifest and SQLite hashes match the
  isolated artifact exactly; Node SQLite reports `quick_check: ok` and zero
  foreign-key violations; catalog discovery returns all five installed packs
  with Central Cascades on `cc-f1cb28a4ceb6e896`. Two consecutive `npm run
  verify` runs each passed 438 tests across 83 files plus the production build,
  and two consecutive `npm run test:browser` runs each passed all six Chromium
  flows.

- 2026-08-06 — corrected steepest sustained grade to use exact rolling 100 m
  windows across reconstructed edge boundaries, with a conditional linear-time
  search prefilter and authoritative post-reconstruction classification. The
  rebuilt schema-4 pack `scm-dc5ca38b5b94a230` has 0 graded edges shorter than
  100 m, 11,057 edges with valid sustained-grade measurements, and zero audit
  errors. `npm run verify` passes 323 tests across 60 files plus the production
  build; two consecutive `npm run test:browser` runs pass all four Chromium
  flows; the real-pack checkpoint reports zero directed-validation rejections.

- 2026-08-06 — added practical grade-experience presets and persistent local
  settings. Gentle, Moderate, and Steep constrain uphill/downhill 100 m p90
  grade, the share of uphill distance at 10% or steeper, and the longest
  uninterrupted 10%+ run. Schema-5 pack `scm-93c6efbcff4fde42` contains compact
  direction-aware elevation profiles for all 863,917 directed edges and passes
  audit with zero missing elevation profiles or audit errors. Settings persist
  in ignored `.local-data/runtime/settings.json`; all previous Settings controls
  remain available. Successful pack publication now removes older validated
  builds for the same pack. The Batch resolver accepts schema 5. `npm run verify`
  passes 334 tests across 62 files plus the production build, and two consecutive
  `npm run test:browser` runs pass all five Chromium flows.

- 2026-08-06 — made Loop options use the compact constraint-table UI and persist
  as builder defaults in the shared settings JSON. Full-search results now
  deduplicate identical route geometry across access points, preferring an exact
  match over a close match, and the pack compiler removes generic OSM access records
  when a named access point uses the same snapped node. Rebuilt schema-5 pack
  `scm-da6546354d045858` contains 3,203 access points, passes audit with zero
  errors, and passes the five-start real-pack checkpoint with zero directed
  validation rejections. Existing saved jobs were migrated; the latest duplicate
  exact pair was reduced to one route. Grade cards use whole-number percentages
  and plain-language labels. `npm run verify` passes 337 tests across 62 files
  plus the production build; two consecutive browser runs pass all five Chromium
  flows.

- 2026-08-06 — fixed the Jobs modal result-opening state under React Strict
  Mode. The mount lifecycle flag is restored when effects are replayed, so a
  successful result load always clears `Opening…` before the modal is reopened.
  A Strict Mode regression test covers the successful load path. `npm run
  verify` passes 338 tests across 62 files plus the production build; two
  consecutive browser runs pass all five Chromium flows.

- 2026-08-07 — widened the GHS-POP access-point context radius from 1 km to
  2 km so urban-edge access points are not labeled remote solely because their
  immediate raster cells are sparse. With the existing classification
  thresholds, the rebuilt Southern East Bay pack `seb-fbb73433186eb5f5`
  changes the inventory from 112 remote / 218 rural / 1,801 populated to 39
  remote / 60 rural / 2,032 populated. Its audit retains 2,131 access points
  with zero missing population samples or errors. The rebuilt Santa Cruz pack
  `scm-cf499195b533cbbd` retains 3,203 access points with zero missing
  population samples or audit errors. `npm run verify` passes 377 tests across
  74 files plus the production build.

- 2026-08-07 — replaced the remote/rural/populated/unknown taxonomy with two
  rules and deleted the GHS-POP subsystem. An access point is now excluded when
  it cannot reach a cycle (it can never yield a loop, and the solver already
  discarded it) or when 50 or more OSM buildings sit within 500 m. Buildings
  come from the pinned OSM extract already used for topology, so
  `lib/data/population/`, `tools/dem/sample_population.py`, the uv/rasterio
  population dependency, the pinned GHSL download, and the per-region
  `population-source.json` files are gone, along with the `accessPointRemoteness`
  contract, its settings UI, and the map colour ramp. Measured on the published
  Santa Cruz pack: the cycle rule removes 1,074 of 1,848 portals (56% and 40% in
  the other two regions), and the building rule keeps 962 of 1,848. Face
  validity on real portals — Big Basin 0 buildings, Castle Rock 2, Old Big Basin
  Road 9, Fall Creek Fire Road 9, Henry Cowell 28 all kept; Rancho San Antonio
  67 and 83 dropped. Fall Creek is the case that motivated the swap: GHS-POP
  called it `populated` at 380 people/km² because Felton is inside the 2 km
  radius. Extraction takes 6.8 s for 189,826 buildings and counting 1,848
  portals takes 44 ms; the retained centroid file is 3.9 MB against roughly
  39 MB of GHS-POP tiles removed. `npm run verify` passes 354 tests across 71
  files plus the production build. **Packs must be rebuilt**: schema 6 now
  carries `nearby_building_count` in place of `population_within_radius` and
  `local_relief_m`.

- 2026-08-08 — added deterministic route-segment condition inspection without
  inferring maintenance. Newly generated routes group consecutive reconstructed
  edges by trail identity, access, and mapped OSM observations; preserve
  surface, smoothness, trail visibility, hiking difficulty, informal, and
  lifecycle tags; and synchronize list hover/focus/selection with a heavier
  orange map segment. Result headers now use the trailhead plus longest named
  segment. Existing saved jobs remain readable but omit the inspector because
  their stored geometry lacks ordered edge identities. User-facing “near miss”
  language is now “Close matches”; violated visible metrics turn orange instead
  of consuming space in a warning block. The redundant same-trailhead row was
  removed. Segment rows were later simplified to name and distance only, with
  an adjacent Google condition-search icon that opens in a new tab. Two
  consecutive `npm run verify` runs each pass 368 tests across 73 files plus the
  production build. Two earlier `npm run test:browser` runs each passed all five
  Chromium flows, including segment inspection; the final browser rerun after
  compact-row and search-link follow-ups was omitted at the user's request for
  manual UI review. Existing packs remain compatible; rebuilding publishes the
  newly preserved OSM condition/source-feature flags. Automated maintainability
  discovery remains a later stage documented in
  `trail-segment-condition-plan.md`.

- 2026-08-08 — added viewport-loaded mapped trails at zoom 13 and above. The
  network uses a lifted green dashed treatment beneath generated routes; hover
  gives one segment a restrained solid emphasis and shows its mapped name plus
  adaptive mile/foot distance in the former map-hint visual language. The
  persistent trailhead-filter geometry notice was removed. Viewport requests
  omit redundant access-point work and allow up to 30,000 physical trail
  features for dense regional views. Existing packs remain compatible. `npm
  run verify` passes 374 tests across 74 files plus the production build, and
  two consecutive `npm run test:browser` runs pass all five Chromium flows.
  Live Henry Coe inspection at desktop and 390 px confirmed the earlier zoom
  reveal, resting/hover line hierarchy, distance/name badge, and zero browser
  console errors.

- 2026-08-09 — corrected mapped-trail hover to operate on contiguous trail
  runs rather than individual graph edges. Endpoint-connected edges with the
  same normalized name now share one combined distance and hover group;
  unnamed degree-two chains also join, while ambiguous unnamed branches remain
  separate. Group geometry is merged into maximal chains so both resting and
  emphasized strokes remain visibly dashed instead of restarting into an
  apparent solid line at every source edge. Trails now reveal at zoom 12, and
  the viewport ceiling is 75,000 physical edges. Existing packs remain
  compatible. `npm run verify` passes 377 tests across 75 files plus the
  production build, and two consecutive `npm run test:browser` runs pass all
  five Chromium flows. Live Henry Coe inspection confirmed the network after
  one zoom step from the pack overview, a 1.8-mile contiguous named hover run,
  clearly dashed emphasis, and zero browser console errors. The hover badge
  was subsequently moved to the top-center map inset; desktop and 390 px live
  inspection confirmed it clears the map controls while the drawing guidance
  remains at the bottom. Named trail runs can now be clicked to copy their
  mapped name. The distance chip briefly becomes a restrained green `Copied`
  chip while the trail name stays visible, then returns after 1.5 seconds;
  clipboard failures receive equally brief inline feedback. Unnamed runs do
  not copy the display placeholder, and route or trailhead interactions take
  priority when hit areas overlap. `npm run verify` passes 378 tests across 75
  files plus the production build, and two consecutive `npm run test:browser`
  runs pass all five Chromium flows. Live Henry Coe inspection confirmed the
  click feedback and timed distance restoration on White Tank Spring Road.
  Access-point markers now use the same hover language: individual markers
  receive a modest size and white-casing lift with a type-and-name badge, while
  wider-zoom clusters show their access-point count and grow slightly. Hover
  state clears as soon as the map moves, and access points take precedence over
  underlying trail hover. The shared badge now sits on the same top row as the
  drawing controls. Trail-name copying now starts the standards-based Clipboard
  API directly from the click and immediately attempts a synchronous document
  fallback during that same browser activation, avoiding intermittent
  permission failures after activation expires. Named access points now use
  the same click-to-copy interaction and transient badge feedback while
  retaining their existing selection behavior; unnamed markers do not copy a
  display placeholder. `npm run verify` passes 382 tests across 75 files plus the
  production build, and two consecutive `npm run test:browser` runs pass all
  five Chromium flows; the final positioning review is intentionally left for
  manual UI inspection.

- 2026-08-09 — completed the multi-region selection follow-up for GitHub issues
  #12 and #15. Installed pack pills now toggle independently, including an
  explicit empty selection, and one grouped, indented checkbox dropdown controls
  reviewed regions across the selected packs. Quick search fans out across every
  selected target, combines results fairly, namespaces pack-local IDs, and
  removes duplicate route geometry from overlapping packs; Full search creates
  one persistent job per selected reviewed region. Saved cross-pack job results
  now replace the active selection with their originating pack and reviewed
  region, then open in the current workspace, including under React Strict Mode.
  Primary-pack URL updates no longer remount the builder, so the restored region
  selection and saved routes appear together instead of the results being reset.
  Optional pack and reviewed-region boundaries are hidden by
  default and render only as a 0.8 px solid black outline with no fill, casing,
  or dash. `npm run verify` passes 399 tests across 77 files plus the production
  build, and two consecutive `npm run test:browser` runs pass all five Chromium
  flows. Existing packs remain compatible.

- 2026-08-09 — completed a full post-gate correctness, lifecycle,
  maintainability, performance, memory, and deletion audit. Solver candidates
  that miss only maximum elevation or shared approach constraints now survive
  as explicitly labeled close matches. Detailed geometry bounds and fragmented
  topology audits use allocation-free iterative extrema rather than unbounded
  argument spreads. Persistent jobs now terminate disconnected or unresponsive
  solver children, stream-limit request bodies, label unavailable pinned packs
  stale, remove polling listeners, and query queued work directly. UI result
  restoration, pagination, Quick transitions, multi-pack fanout, location
  changes, and result clearing reject stale asynchronous work; GitHub issue #13
  is complete with an accessible Clear results control. Pack discovery uses one
  page snapshot, viewport trail deduplication uses physical-edge identities,
  large graph reads inherit client cancellation, reachability tombstones are
  bounded, and Turbopack no longer traces the whole project into server output.
  More than 600 lines of superseded checkpoint runners and dead adapters,
  helpers, styles, and types were removed; the complete change is net-negative
  in source lines. Two consecutive `npm run verify` runs each pass 414 tests
  across 78 files plus a production build without whole-project tracing
  warnings, and two consecutive
  `npm run test:browser` runs each pass all five Chromium flows. No contract or
  pack schema changed, so installed schema-6 packs remain compatible and no
  rebuild was required.

- 2026-08-09 — made the driving origin optional for Full search. Requests that
  include an origin still require the paired drive-time duration and retain the
  existing reachability intersection. Requests that omit both skip reachability
  entirely and attempt every eligible access point in each selected reviewed
  region. Region-wide jobs move directly from queued to running, resume without
  synthetic geometry, use the named-region access predicate in the solver, and
  are labeled `Entire reviewed region` in Jobs. Non-empty unresolved origin text
  must be selected or cleared so it cannot silently broaden the search. Existing
  version-1 saved jobs remain compatible. `npm run verify` passes 423 tests
  across 79 files plus the production build, and two consecutive `npm run
  test:browser` runs pass all five Chromium flows, including blank-origin Full
  launch and result restoration. No pack schema changed, so installed schema-6
  packs remain compatible.

- 2026-08-09 — completed the remaining GitHub issue #11 result-marker work.
  Generic access-point dots and clusters are now borderless and disappear while
  a result marker represents the same trailhead, preventing duplicate map
  symbols. Overview result groups use quiet text-free dots anchored to a real
  member start rather than an invented midpoint. Single starts retain their
  result number, and from zoom 11 onward routes sharing one exact start expand
  into a compact numbered group whose tip marks the route coordinate. Result
  labels cannot wrap, and DOM marker anchors retain their real dimensions so
  MapLibre centers them correctly. Generated result routes now render as single
  orange or green strokes in every state, without white casing or background
  layers. Settings checkboxes and the Quick-search route count now snapshot
  their DOM values before scheduling draft-state updates, preventing cleared
  React events from causing runtime errors. `npm run verify` passes 426 tests across 79
  files plus the production build, and two consecutive `npm run test:browser`
  runs pass all six Chromium flows, including shared-start numbering and anchor
  regression coverage. No contract or pack schema changed.

- 2026-08-23 — added a production Docker workflow for fresh clones. The pinned
  Node 24 multi-stage image builds the ordinary Next.js app, runs as the
  unprivileged `node` user, retains the TypeScript solver-child runtime required
  by Full search, and exposes an uncached `/api/health` check. Compose passes
  only the documented server credentials, mounts the ignored installed-pack
  catalog read-only, and persists jobs, settings, and provider counters in a
  named volume; `.dockerignore` excludes secrets, generated packs, caches, and
  local databases. Host binding is localhost-only by default, while `.env` can
  select another host port or explicitly opt into LAN access. A fresh native
  ARM64 OrbStack 2.2.3 / Docker 29.4.0 / Compose 5.1.2 build produced a healthy
  327,019,198-byte image with zero npm advisories after the compatible transitive
  Nano ID patch. Both the `3200` override and default `3000` bindings passed;
  the main page returned 200, all five installed packs were discovered through
  the read-only mount, the job database was writable on the named volume, and
  the production TypeScript solver child loaded successfully. Live ArcGIS place
  suggestions and a five-minute service-area request also completed from the
  container using the shared-key fallback when scoped keys were blank.
  `compose.yaml` parses, two consecutive `npm run verify` runs each pass 440
  tests across 84 files plus the production build, and two consecutive
  `npm run test:browser` runs each pass all six Chromium flows.

- 2026-08-23 — extended drawn boundaries to Full search. A drawn boundary now
  overrides drive time and reviewed regions for both actions: Quick retains its
  short foreground solve, while Full launches one persistent job per selected
  installed pack and attempts every eligible access point inside the box. Drawn
  jobs reject origin/drive-time and reviewed-region combinations, retain the
  immutable bounding box, restore it when saved results are opened, and use it
  only to select access points; route geometry remains constrained by exact pack
  coverage. Existing drive-time, reviewed-region-wide, and saved version-1 jobs
  remain compatible. Two consecutive `npm run verify` runs each passed 450
  tests across 84 files plus the production build, and two consecutive `npm run
  test:browser` runs each passed all six Chromium flows, including the combined
  drawn-boundary Quick/Full flow. No pack schema changed, so installed packs do
  not require rebuilding.

- 2026-09-06 — result rendering now accepts a route collection with its real
  Quick-search diagnostics or saved-job metadata. Removed synthetic solver
  responses, aggregated diagnostics, and duplicate saved-page and region-label
  state. Route ordering, geometry deduplication, selection, and pagination remain
  unchanged. Relative to `1976e81`, application source is 84 lines smaller and
  source plus tests is 36 lines smaller. Two consecutive `npm run verify` runs
  each passed 451 tests across 85 files, lint, type checking, and the production
  build. Two consecutive `npm run test:browser` runs passed all six Chromium
  flows. Live localhost checks covered Quick-search limits, opening existing
  saved routes, map zoom/pan, and mobile internal-panel scrolling. A final status
  spacing adjustment also passed all 13 results-panel tests. No API, pack schema,
  or dependency changed. Generated packs and local databases remain ignored.

## Local data and risks

- USGS catalog sizes can differ from historical TIFFs (observed for Santa Cruz
  n37w123). Acquisition now treats catalog size as advisory and pins the actual
  bytes/hash, covered by an offline mismatched-size regression. That source was
  not downloaded again during this change.

- Generated packs, source/build caches, route-job databases, and audits are
  local ignored artifacts. Rebuild packs only through the explicit commands in
  `README.md`; use uv for Python dependencies.
- Preserve `public/maplibre/`: the local worker assets are required for
  native GeoJSON rendering. Final visual checks must use the live in-app browser
  against localhost and include zoom/pan anchoring plus mobile internal-panel
  scrolling.
- The pack has 3,266 graph components and its largest component contains 41.22%
  of nodes. OSM parking relations are not yet ingested, and many access points
  correctly remain marked unknown and are visibly disclosed when included.
- Compact filters may contain few viable starting access points. Preserve honest
  exact/near-miss behavior; do not relabel a short-stem loop or silently relax
  route constraints.
- The private, personal-use scope is compatible with keeping generated packs
  local and ignored. Publishing a pack requires a fresh review of Midpen and
  Santa Clara County redistribution terms.
