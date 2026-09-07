# System design revision

## Objective and baseline

Revisit the whole application for less code, fewer exposed concepts, clear
ownership, and simple subsystem interactions. Completion covers the entire
revision below. Individual commits are implementation steps, not a smaller goal.

Baseline: `810e44c`. Tracked TypeScript, TSX, Python, MJS, and CSS under `app/`,
`components/`, `lib/`, `scripts/`, and `tools/` contain 23,599 application lines
and 11,042 test/helper lines. This excludes dependencies, generated data, browser
fixtures outside those roots, and documentation. Final accounting must use the
same scope and show source, tests, and documentation separately. Moving code
between files is not a reduction. Reduced line count must not come from hiding
failures, weakening validation, compressing formatting, or dropping useful route
behavior without an explicit product decision.

## Design basis

- [Ousterhout and Martin's discussion](https://github.com/johnousterhout/aposd-vs-clean-code)
  evaluates design by the information needed to understand and change it.
  Encapsulate substantial responsibilities behind small interfaces. Splitting
  large functions into many coupled helpers does not establish modularity.
- [Valhalla's actor interface](https://github.com/valhalla/valhalla/blob/master/valhalla/tyr/actor.h)
  is a useful routing exemplar: geographic operations sit above graph readers
  and internal workers. Adopt that boundary, not its implementation size or
  deployment architecture.
- [React's state guidance](https://react.dev/learn/choosing-the-state-structure)
  favors avoiding contradictory, redundant, and duplicate state. Use explicit
  ownership of a draft, an operation, and a viewed snapshot.
- [Fowler on YAGNI](https://martinfowler.com/bliki/Yagni.html) supports removing
  speculative flexibility while retaining design that makes current work easy
  to change. Historical formats and unused runtime modes need actual consumers.

These are design constraints, not endorsements of the current implementation.
The application remains local Next.js, React, MapLibre, and SQLite.

## Product model

The user works with a search area, hiking criteria, generated routes, and work
retained on this device. Packs and provider jobs are internal details.

An area can be drawn, named, or based on driving time. Named places may refine a
drive-time area. Make the active area unambiguous. Preserve the current drawn
area override during migration, and never silently broaden a failed filter.
Areas select starts. Exact installed coverage remains the route boundary.

Route criteria have one definition independent of HTTP, a pack, saved settings,
or execution strategy. Unknown access remains included by default and may be
excluded. Exact and close matches remain separate. Route count is explicit,
1 through 20, default 10.

Quick and Full currently differ in more than execution: Quick returns a global
requested count while Full retains up to ten routes per start. Do not describe
these as equivalent. The target is shared preparation and execution primitives.
The final interaction must make requested alternatives versus an exhaustive
trailhead attempt explicit, without requiring users to manage one job per data
partition. Preserve useful exhaustive work and existing saved results while
removing duplicated lifecycle machinery. Saving every foreground search is not
a prerequisite for shared execution.

## Responsibility boundaries

| Owner | Inputs and outputs | Details kept inside |
| --- | --- | --- |
| Workspace | Draft, search intent, viewed snapshot, selection | Form editing, panel state, one active-view cancellation scope |
| Search application service | Area + criteria + execution policy to progress/results | Area resolution, installed-data selection, work scheduling, combining results |
| Route engine | Prepared starts + criteria + graph session + budget to candidates | Directed search, metric evaluation, diversity, topology, cancellation checks |
| Data access | Geographic queries and versioned graph sessions | Pack registry, SQLite, coverage, namespaced identities |
| Data preparation | Pinned sources to normalized records | Source-specific parsing, authority evidence, provenance |
| Artifact builder | Prepared records to accepted immutable artifact | Metrics, feasibility, writing, audit, activation |

Keep the hierarchy shallow. These are responsibility boundaries, not a mandate
for a framework, class per row, or directory per operation. Pure domain types
can be shared. An HTTP DTO must not be the engine's input just because its fields
happen to be convenient.

## Evidence and replacement plan

### 1. Domain and search orchestration

`components/builder/validation.ts` constructs a Quick HTTP request to validate
form criteria. Full invents a drawn bounding box, then copies criteria out of
that request. `lib/contracts/routes.ts` and `route-jobs.ts` define the same
criteria separately. Establish one criteria schema and parse the draft once.
Delete placeholder requests and field-by-field extraction.

`HikeBuilder.runQuick` resolves and polls provider work per pack, fans out route
requests, and merges results. `launchBatch` independently constructs jobs per
pack/region. Move those responsibilities to the search service. Map and named
place queries must also use geography rather than client-managed pack lists.
Delete pack selection, primary-pack state, pack URL reconciliation, per-pack
frontend loading state, and browser fanout after replacement endpoints are used.

`lib/reachability` exposes a second job lifecycle. Encapsulate provider submit,
poll, expiry, and cancellation inside area resolution. Driving contours depend
on origin/time, not a pack identity. Retain provider usage accounting, deadlines,
and source failures. Remove the public provider-job protocol when callers use
the search service. Do not replace it with another generalized queue.

### 2. Workspace, saved work, and preferences

`HikeBuilder` independently resets result state, selection, page state, and
geometry in several paths. Draft effects and saved-result loading both write
map overlays. One viewed snapshot must own its criteria and geometry; the draft
must remain a separate editable value. One active-view operation handles search,
opening a saved result, and pagination, rejecting stale completion.

`JobsModal` fetches result pages while the builder separately restores URLs and
loads subsequent pages. Give one resource ownership of job list/mutations and
one operation ownership of result loading. The modal emits intent. Preserve
closing behavior, partial results, cancellation, restart recovery, and deletion.

Preferences are reconstructed from incomplete form strings and written through
several full-object PUT paths. Introduce one validated preferences value and one
ordered persistence path. Keep transient input text local. Preserve modal
cancel, explicit defaults, immediate feedback, and visible save failures.

### 3. Map and results

`HikeMap` combines map lifetime, viewport requests, source merging, hover,
selection, markers, clipboard, and geometry layers. Keep MapLibre mechanics
inside one rendering bridge but remove application data orchestration from it.
Give each map source one writer. Preserve viewport cancellation and smooth
interaction rather than introducing state for every map event.

Result hover currently uses both React callbacks and a global CustomEvent.
Choose one explicit transport. Remove `routeTraceOverlay.ts` and the duplicate
selection/hover path. Shared clipboard behavior must not be imported from the
map component by results. Remove no-op access-point selection integration if no
product behavior consumes it.

### 4. Engine and graph session

The route engine consumes the HTTP request, including transport version and
reachability identifiers. The background child fabricates a reachability UUID.
Separate prepared area/start context from engine criteria. Validate transport
once at the application boundary and retain directed-route correctness checks
inside the engine.

Full enumerates starts, then calls generation twice per start, and generation
re-enumerates candidates. Prepare candidates and feasibility once in a graph
session. Search a prepared start without rediscovery. Preserve the union of
Quick and Thorough results: the current heuristic is not monotonic, so a larger
budget alone is not a proven substitute.

Keep physical-trail cycles, one-way restrictions, access exclusions, coverage,
metric correctness, near-match labeling, deterministic diversity, and bounded
cancellation. Simplify the representation and call graph before changing the
search method. Verify methodological changes separately.

### 5. Preparation and publication

Regional builders normalize topology, then wrap it back into
`PreparedTopologyAdapter`. Compilation recollects its one-element iterable and
revalidates the source. Pass normalized topology directly, keep validation at
the source boundary, and delete the wrapper and duplicate collection work.
Follow through on prepared access/named-area inputs where that removes the same
problem without a configurable pipeline framework.

The compiler activates/prunes artifacts before regional semantic audits.
Make the artifact builder own acceptance before activation. Consolidate the
repeated audit/report phase. A rejected build must leave the current pointer and
prior artifact intact. Source downloads remain immutable and cached.

### 6. Supported representations

All real builders produce schema 6, but active code writes/reads six formats.
Converge on the current graph format and reject obsolete artifacts at loading
with a rebuild instruction. Saved route geometry remains readable independently
of graph-format support. Do not delete users' installed artifacts during this
revision.

Real builds compute primitive topology, then compact away most of it. Remove
unused persistence and runtime branches after checking consumers. Preserve
feasibility, grouping, minimum stems, and directed connectivity. Compare computed
values before changing their algorithms.

`FixtureGraphRepository` duplicates production traversal/ranking, and the empty
installation fallback cannot generate current closed routes. Fixtures should
provide small data to the actual SQLite reader. Replace the alternate graph
implementation and expose an honest no-installed-data state.

## Execution and acceptance

- [x] Shared domain criteria and preparation boundaries replace transport-shaped inputs.
- [x] Geographic application operations hide packs and provider jobs from the frontend.
- [x] Workspace, saved work, and preference state have one owner each.
- [x] Map sources and hover have one explicit update path.
- [x] Engine sessions reuse prepared starts without transport fabrication.
- [x] Artifacts are audited before activation and use one supported graph representation.
- [x] Synthetic fixtures exercise production storage instead of a second graph engine.
- [x] Superseded paths, adapters, fields, and documentation are removed or updated.
- [x] Final source reduction, remaining complexity, tests, real-data comparisons, and UI behavior are measured.

Use isolated commits for independent boundaries. Keep an implementation branch
while the system is transitional. Verification is proportionate: existing
behavioral tests, regression cases for changed invariants, deterministic graph
and metric comparisons, full build/check gates, and desktop/mobile interaction.
Do not count tests for obsolete behavior as requirements to keep that behavior.
Record failures and unresolved decisions rather than declaring the goal complete
when only one wave passes.

## Integrated evidence, 2026-09-06

The first wave is integrated through `c663ef5` on `codex/system-design`.
Application source is 96 lines smaller than `810e44c` (844 added, 940 removed).
Tests/helpers are 159 lines larger (425 added, 266 removed). These figures count
renames as removal/addition and use the baseline scope above. This is a modest
reduction, not acceptance of the full revision.

- One criteria schema validates the form and supplies both search policies.
  Full no longer manufactures a foreground request or placeholder bounding box.
- The engine accepts criteria and execution policy independently of HTTP.
  Exhaustive work prepares starts and feasibility once. A three-start comparison
  preserves complete Quick/Thorough responses while candidate enumeration and
  topology loading each occur once.
- Foreground and exhaustive work use the same local compute host. The child owns
  graph lifetime and receives only pack identity, criteria, and resolved area.
  Production SQLite fixtures exercise both operations. Cancellation tests keep
  the app loop responsive while terminating synchronous work in either mode.
  The solver retains its computation budget, while the host allows five seconds
  for startup and response transfer. Live testing caught and corrected registry
  serialization and premature host timeout failures.
- Hover uses one React callback path. Viewport loading alone writes trail data.
  Clipboard code is shared independently of the map. Unused access selection,
  redundant trail props, and the global hover event were deleted.
- Preferences have one validated value and serialized writes. Local numeric
  drafts cannot leak into unrelated saves. Search waits for initial settings.
  Delayed writes, invalid drafts, modal cancel, save failure, and retry are
  covered by focused behavior tests. Workspace and saved-view ownership remain
  open work.
- Compilation consumes normalized topology directly. Regional audits and
  reports precede activation, including cached artifact reactivation. A rejected
  real schema-6 fixture leaves the previous pointer and artifact intact.
  Current-format-only compilation and reading remain open work.

Two final `npm run verify` passes each completed lint, type checking, 456 offline
tests across 85 files, and the production build. Two integrated browser passes
each completed six flows. Live localhost inspection covered bounded real-data
Quick responses, restoring seven saved routes, zoom/pan, and mobile panel
scrolling. The selected Santa Cruz demo search exhausted its computation budget
without routes, so this is not evidence of improved search yield. No schema,
installed artifact, dependency, or saved database changed. Temporary worktrees
and branches were removed. The integration branch remains active.

Next: geographic application operations, followed by workspace/saved-view
ownership and current graph representations. Pack selection, provider polling,
and browser fanout are still present and must be removed as part of that work.

## Geographic wave contracts

`lib/contracts/search.ts` defines the replacement application boundary. A search
has one area and one set of criteria. The area is a drawn box, named-region IDs,
or an origin/duration with optional named-region IDs. Region IDs are opaque to
the browser. There is no pack selection. A Quick request adds the global route
count. One Full request creates one retained job across all eligible installed
data, preserving ten alternatives per start and exact-first result paging.

- `GET /api/search/catalog` returns region names/IDs, coverage geometries, and an
  initial map view. An empty coverage list means data is unavailable, not an
  alternate fixture runtime.
- `POST /api/search` accepts `SearchRequest` and returns `SearchResult`. The
  server resolves drive time once, chooses installed data, executes, namespaces
  identities, deduplicates geometry, and combines results. Partial failures and
  computation limits are explicit in `incomplete` and `messages`.
- `GET /api/map?bbox=...` returns `{ accessPoints, trailNetwork }` using the
  existing point and GeoJSON trail shapes, with identities namespaced by the
  server. Map loading no longer accepts a pack list.
- `/api/route-jobs` and its existing detail/cancel/results routes use version-2
  job envelopes. Creation accepts `SearchIntent`. The stored plan pins all
  contributing data versions and the resolved area. Existing version-1 jobs and
  result geometry must migrate losslessly, including partial progress, ordinal
  checkpoints, cancellations, and timestamps.

The job runner dependencies resolve a `SearchIntent` to a `SearchPlan`, resolve
an optional drive-time area once, and open one search session from
`{ request: SearchIntent, plan: SearchPlan, signal }`. The session retains the
existing enumerate/search-start/close operations, using globally unique start
IDs. The server composition owns the internal per-data sessions. Public jobs
carry the request and area snapshot, not the internal plan.

The workspace renders a viewed snapshot with its own area and criteria. Editing
the draft does not alter the meaning of already-saved results. The Jobs dialog
emits a job ID, one view operation loads its results, and pagination uses that
same operation. A complete migration deletes old frontend fanout, pack URLs,
provider polling, fake result adapters, and obsolete endpoints. The map's Demo
button is test scaffolding and will be removed in favor of real drawing in
browser checks.

## Geographic integration evidence, 2026-09-06

Integrated through `e9f722c`. Relative to `810e44c`, application source is 1,999
lines smaller (21,600 total), and tests/helpers are 1,755 lines smaller (9,287
total). Superseded API and frontend-orchestration tests were removed with those
paths. The remaining tests exercise the replacement behavior.

- The browser sends one geographic Quick request or one retained Full intent.
  Catalog and map queries use geography. Pack selection, URL reconciliation,
  client fanout, public provider jobs, and the Demo button are removed.
- One area resolver owns provider submission, polling, deadline, cancellation,
  and completed-contour caching. One Full record pins all contributing data.
- The workspace separates edited inputs from the viewed search snapshot. Search,
  opening saved work, and paging share cancellation and stale-result rejection.
  One jobs resource owns polling and mutations. Trail layers do not refresh
  merely because results change.
- SQLite migration preserves saved exact/close geometry, identities, ordinals,
  timestamps, checkpoints, and cancellation/deletion precedence. Historical
  schema fixtures test rollback and foreign-key integrity. The local database
  was backed up before migration; all 12 existing jobs remain available.
- Production SQLite/compute fixtures verify overlapping-data identities,
  geometric deduplication, a global Quick count, one contour resolution,
  no-data errors, cancellation, and start filtering without route clipping.

Two final `npm run verify` passes each pass 387 tests across 75 files plus lint,
TypeScript, and production build. Two browser passes each pass six offline
flows using real pointer drawing. Logs are `/private/tmp/alpine-geographic-verify2.log`,
`verify3.log`, `alpine-geographic-browser2.log`, and `browser3.log` (the latter
short names share the same geographic prefix). Live localhost inspection opens
seven preserved Henry Coe routes, keeps original criteria apart from the draft,
and verifies zoom/pan, mobile internal scrolling, and no console errors. A real
named-area Quick request returns HTTP 200 in 3,361 ms with explicit computation
truncation and zero routes; this does not claim improved yield.

The full revision remains incomplete. Next is one supported graph representation,
production-storage fixtures, and removal of the remaining superseded surfaces.

## Current graph representation contracts

Only the existing schema-6 manifest and `reachable-graph-fallback` runtime are
supported. Installed artifacts are not deleted or rewritten. Unsupported
versions fail with a rebuild instruction. Saved route geometry remains readable
without its original graph. The serialized schema-6 fields, physical SQLite
layout, migration rows 1–6, metrics, and data-version inputs remain unchanged.
Empty historical primitive tables stay in that physical layout, while unused
write/read branches and the alternate primitive output mode are removed.

The production fixture uses `fixtureCompileOptions(...)`,
`writePackDatabase(path, contents)`, and the input shapes/meaning of
`buildClosedRouteTopology(...)`. Test graphs supply data to those production
writers/readers; they do not implement traversal or ranking. The original
schema-6 compiled fixture is retained at
`/private/tmp/alpine-schema6-baseline/fixture-pack/fixture-v6` for table/metric
comparison. The compiler and reader changes were integrated independently, then verified together.


## Final representation and ownership evidence

The compiler and reader support one existing format. Obsolete manifest variants,
primitive-output branches, schema-dependent SQL, fabricated graph defaults, and
the duplicate fixture graph engine are removed. Tests now serialize small graph
inputs into production SQLite. The engine returns domain candidates and real
search diagnostics without transport IDs, request echoes, or display metadata.
Installed-data discovery no longer constructs the removed pack-UI response.

The frozen schema-6 fixture and new compiler output have identical manifests,
audits, all 126 rows across 32 tables, metric values, provenance, and version
inputs. SQL definitions differ only in whitespace. Twelve old/new reader
comparisons preserve candidates, induced graphs, and bounded reachable graphs
under both access policies. All five installed regional databases load with the
new reader. Their artifacts were neither rebuilt nor rewritten.

The final ownership checks preserve unresolved location intent after a failed
lookup, show pagination failures alongside retained cards, keep draw callbacks
stable across unrelated updates, and disclose failed Full-search trailheads
while preserving successful results. Unused drawing and results-state options
are removed. A Strict Mode regression confirms saved jobs load after the initial
mount request is cancelled.

Live inspection caught overview maps unnecessarily loading hidden detailed
trails. The viewport now requests details only at trail zoom. The same real
Santa Cruz overview changed from a 6.4-second rejected detail request to a
522-millisecond successful response with 392 access points and no hidden trails.
This is a local observation, not a general performance benchmark.

### Complexity deliberately retained

- The closed-route heuristic, directed reconstruction, physical-cycle checks,
  metric computation, and Quick/Thorough union remain. This revision changes
  representation and ownership, not the search method or its yield.
- A compute child remains necessary to isolate synchronous route search. Full
  work retains durable checkpoints, cancellation, and version pinning.
- Empty historical SQLite tables remain in the existing artifact layout to
  preserve installed data. No runtime mode reads or populates those primitives.
- Provider deadlines, usage accounting, and cancellation remain inside area
  resolution. Dense detailed map queries remain bounded and can require zooming
  in. The app is local and does not introduce a general queue or plugin system.


## Final acceptance

The full revision is complete through `b097b6d` on `codex/system-design`.
Final accounting relative to `810e44c`, using the identical scope above:

| Category | Before | After | Net change |
| --- | ---: | ---: | ---: |
| Application source | 23,599 | 20,485 | -3,114 |
| Tests and helpers | 11,042 | 9,019 | -2,023 |
| Tracked Markdown | 3,591 | 3,986 | +395 |

Application source files decrease from 166 to 155. No dependency was added.
These totals include all waves, not merely pack-selection removal, and do not
count moving code as a reduction. Test removals follow removed APIs and alternate
implementations; regression tests cover the replacement invariants.

Two final `npm run verify` passes each pass 383 offline tests across 74 files,
lint, type checking, and production build. Two `npm run test:browser` passes each
pass six flows. Logs: `/private/tmp/alpine-final-verify5.log`,
`/private/tmp/alpine-final-verify6.log`, `/private/tmp/alpine-final-browser5.log`,
and `/private/tmp/alpine-final-browser6.log`.

Final live inspection restored seven saved Henry Coe routes, original 25–30-mile
criteria alongside the independent 1–4-mile draft, desktop map zoom/pan, and a
390-by-844 mobile viewport. The results panel scrolls 297 pixels internally
(716-pixel content, 419-pixel viewport). The fresh tab reports no console errors.
All original 12 jobs remain. A new local Full job appeared during verification
and was left running without modification. A real Henry Coe Quick request
returned HTTP 200 in 3,614 ms with explicit computation truncation and no routes.
An earlier concurrent-load attempt returned 503. This work does not claim better
search yield or guaranteed latency under load.

All delegated worktrees and branches are removed. The integration branch holds
the complete reviewable revision. Installed artifacts, archive tags, and saved
result geometry remain preserved. No publication or deployment was performed.
