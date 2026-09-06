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

- [ ] Shared domain criteria and preparation boundaries replace transport-shaped inputs.
- [ ] Geographic application operations hide packs and provider jobs from the frontend.
- [ ] Workspace, saved work, and preference state have one owner each.
- [ ] Map sources and hover have one explicit update path.
- [ ] Engine sessions reuse prepared starts without transport fabrication.
- [ ] Artifacts are audited before activation and use one supported graph representation.
- [ ] Synthetic fixtures exercise production storage instead of a second graph engine.
- [ ] Superseded paths, adapters, fields, and documentation are removed or updated.
- [ ] Final source reduction, remaining complexity, tests, real-data comparisons, and UI behavior are measured.

Use isolated commits for independent boundaries. Keep an implementation branch
while the system is transitional. Verification is proportionate: existing
behavioral tests, regression cases for changed invariants, deterministic graph
and metric comparisons, full build/check gates, and desktop/mobile interaction.
Do not count tests for obsolete behavior as requirements to keep that behavior.
Record failures and unresolved decisions rather than declaring the goal complete
when only one wave passes.
