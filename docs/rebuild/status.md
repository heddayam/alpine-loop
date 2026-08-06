# Rebuild status

This is the durable resume point for humans and agents. Check a gate only after
its acceptance criteria pass and record the verifying commands or artifact in
the evidence line.

- [x] Gate 0 — active app scaffold, shared contracts, fixture graph
  - Evidence: `npm ci` and `npm run verify` pass on Node 24.11.0; 14 boundary/fixture tests cover request, response, manifest, and all four fixture route shapes; Next.js 16.3.0 production build succeeds with `legacy/**` and generated data excluded.
- [x] Gate 1 — map shell, pack pipeline skeleton, solver foundation
  - Evidence: `npm run verify` passes with 57 offline tests across 11 files and a successful Next.js production build; focused compiler/solver/UI suites pass; live local browser check loaded USGS MapLibre, drew/edited/cleared a hard rectangle, and loaded the in-bound fixture access point. Fixture bootstrap smoke build publishes 7 nodes, 17 directed edges, 2 access points, manifest, audit, and SQLite pack atomically.
- [x] Gate 2 — end-to-end route generation on committed fixtures
  - Evidence: `npm run verify` passes with 95 deterministic offline tests across 15 files and a successful production build; `npm run test:browser` passes 2 Chromium flows (draw/configure/generate/inspect and impossible constraints with labeled near misses) using an in-memory tile fixture; direct local API smoke returned 3 exact routes in 31 ms with validated geometry, metrics, warnings, provenance, and diagnostics.
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

## Post-gate fixes

- 2026-08-06 — corrected steepest sustained grade to use exact rolling 100 m
  windows across reconstructed edge boundaries, with a conditional linear-time
  search prefilter and authoritative post-reconstruction classification. The
  rebuilt schema-4 pack `scm-dc5ca38b5b94a230` has 0 graded edges shorter than
  100 m, 11,057 edges with valid sustained-grade measurements, and zero audit
  errors. `npm run verify` passes 323 tests across 60 files plus the production
  build; two consecutive `npm run test:browser` runs pass all four Chromium
  flows; the real-pack checkpoint reports zero directed-validation rejections.

## Local data and risks

- Generated packs, source/build caches, route-job databases, and audits are
  local ignored artifacts. Rebuild packs only through the explicit commands in
  `README.md`; use uv for Python dependencies.
- Preserve `public/vendor/maplibre/`: the local worker assets are required for
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
