# Whole-repository architecture review

Reviewed from `aaae59f` using the local `improve-codebase-architecture` and
`codebase-design` skills. The user explicitly requested the entire repository,
without prioritizing recent changes, and authorized implementation through
completion. Existing product and artifact contracts remain authoritative.

## Implemented

1. **Direct topology preparation.** Regional builders now call the preparation
   module for one validated graph. Removed two shallow classes, the unused
   topology adapter interface, and four stream collectors. Fixture preparation
   validates hashes, duplicate nodes, and missing references in the same call.
   Production preparation versions and cache identities remain unchanged.
2. **One topology identity module.** Compilation, audit, and the feasibility
   reader use the same canonical hashing implementation. The audit no longer
   imports the compiler merely to hash values. A frozen pre-change hash protects
   compatibility independently of agreement between the writer and reader.
3. **Bounded JSON reading.** Search, jobs, geocoding, and settings share the
   streaming reader. Geocoding previously buffered the entire body before its
   size check; settings had no bound. Limits are 16 KiB for geocoding and 32 KiB
   for the other callers. Endpoint error formats and attribution stay local.
4. **Smaller solver interface.** Removed unread reconstruction/candidate fields,
   an unused Dijkstra option, a duplicate budget, and an unused geometry helper.
   Working traversal arrays remain internal. Route hashing and the feasibility
   read interface each have one definition. Removed empty checkpoint metadata.
5. **One active elevation implementation.** Removed the unused command-line
   GDAL sampler and its obsolete test. All regional builders already use the
   locked Rasterio implementation; that implementation and its tests remain.
6. **Dialog focus ownership.** Jobs and Settings share initial focus, Escape,
   focus restoration, and Tab handling. Deleting or disabling the focused job
   action no longer lets the next Tab escape to the underlying page. Settings
   retains its save-in-progress close guard. Tests exercise the actual dialog.

## Review coverage and retained complexity

| Area | Decision |
| --- | --- |
| App routes, contracts, root configuration | Keep thin transport adapters, strict contracts, local Next.js, and Docker runtime. |
| Builder, preferences, Jobs, results | Keep separate edited/viewed snapshots and ordered operations; consolidate demonstrated dialog focus behavior. |
| Map and geometry | Keep MapLibre lifetime and source ownership together. Splitting the large implementation into files alone adds no depth. |
| Search, driving areas, worker process | Keep provider cancellation/deadlines, compute isolation, and explicit partial failure reporting. |
| Job storage and migrations | Keep the live public read after asynchronous version checks; a pre-check snapshot could return deleted jobs or stale progress. |
| Solver and graph | Remove unused surfaces; retain distinct heaps/decompositions with different tie breaking, cancellation, and allocation requirements. |
| Source ingestion and regional preparation | Preserve reviewed restrictions, source-specific normalization, immutable downloads, and regional reports. No general configurable pipeline. |
| Artifact readers, audits, publication | Share hashing; preserve audit-before-activation and the existing physical schema. |
| Scripts, Python DEM tool, test infrastructure | Keep the reproducible active tooling and independent browser fixtures; remove dead checkpoint metadata. |

Bulk job metadata reads, a shorter SQL cursor comparison, and shared installed
artifact finalization remain possible small follow-ups. No measured bottleneck
or correctness problem justified widening this pass for them. The closed-route
heuristic and Quick/Thorough union remain essential implementation complexity.

## Size and compatibility evidence

Same accounting as `system-design.md`: tracked TS, TSX, Python, MJS, and CSS under
`app`, `components`, `lib`, `scripts`, and `tools`; tests, test helpers, and
internal fixtures counted separately. Moves are not counted as deletions.

| Category | Before | After | Change |
| --- | ---: | ---: | ---: |
| Application lines | 20,485 | 20,245 | -240 |
| Tests and helpers | 9,019 | 9,149 | +130 |
| Combined | 29,504 | 29,394 | -110 |
| Application files | 155 | 157 | +2 |

The additional modules own shared identity and focus rules; fewer files was not
the objective. No dependency was added. Additional tests cover previously
unprotected request limits, malformed topology, and focus recovery.

The baseline fixture and final compiler produce identical manifests and all
126 rows across 32 SQLite tables. All five installed packs pass feasibility
validation without modification. Six complete deterministic search responses
(loop, lollipop, figure-eight; Quick and Thorough) are byte-identical before and
after, SHA-256 `49c0ad97f37a675fc755bbfc865edd4a15f6bce386b8264f5af2dca043bb177f`.

Live localhost inspection restored seven saved Henry Coe routes, preserved the
25–30-mile viewed criteria beside the independent 1–4-mile draft, and checked
map zoom/pan and anchored markers. At 390 × 844, the results panel scrolled
297 pixels internally (716-pixel content, 419-pixel viewport). Settings wrapped
Shift+Tab to Done and restored focus to its trigger on Escape. No browser console
errors were observed. No installed pack, saved job, preference, or secret was
modified by these checks.

## Final verification

Two final `npm run verify` passes each passed lint, type checking, all 394
offline tests across 76 files, and the production build. Two final
`npm run test:browser` passes each passed all six Chromium flows, including
dialog keyboard behavior and mobile interaction. Logs are
`/private/tmp/alpine-architecture-verify2.log`, `verify3.log`,
`/private/tmp/alpine-architecture-browser1.log`, and `browser2.log` (short names
share the same `alpine-architecture-` prefix). The first sandboxed browser launch
could not bind localhost; rerunning with local-server permission passed.

All six focused implementation commits are integrated through `6a14e84` on
`codex/system-design`. All four temporary worktrees and task branches are
removed. Existing untracked skill files remain untouched. Generated data and
databases remain ignored; archive tags and existing branches are preserved.
No deployment or publication was performed.
