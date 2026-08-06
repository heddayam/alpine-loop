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

- [ ] Gate 5 — topology-first closed-route engine
  - Execution plan: `docs/rebuild/closed-route-topology-plan.md`.
  - Historical POC evidence: the schema-2 Santa Cruz scan found 418 of 2,293
    eligible access points unable to reach a cycle and grouped 1,875 viable
    access points into 353 portals. The unified lane preserved six diverse
    exact routes while reducing five-start wall time from 7.92 s to 5.93 s.
    The POC was removed in `bb89da3`; the active real-pack checkpoint is
    `scripts/research/gate5-topology-real-checkpoint.ts`.

## Gate 5 active product decisions

- The active redesign generates trailhead-rooted closed routes only. Loop,
  lollipop, figure-eight, chained-loop, and complex are derived result labels,
  not separate solver lanes.
- Maximum repeated trail is user-controlled from 0% through 100% and defaults
  to 35%. Compound cycles are allowed by default.
- Every eligible access point receives cheap cycle-feasibility evaluation;
  expensive work is grouped by reusable cycle network instead of capped at
  eight starts.
- The V3 endpoint and UI are active. The selected implementation uses persisted
  feasibility pruning plus bounded reachable-graph penalized search; the
  abandoned primitive/topology-repository rewrite remains in Git history.
- Draw, Named region, and typical Drive time filters constrain eligible access
  points, never route geometry. Exact pack coverage remains the hard boundary.
- Unknown access is included by default and can be explicitly disabled. Exact
  matches and labeled near misses remain separate.
- Remote, rural, populated, and unmeasured access-point area types are selected
  explicitly in Settings; the same selection controls map visibility, previews,
  explicit starts, and automatic solver starts.

## Gate 5 remaining evidence

- Replace the active V2 Playwright fixtures with V3 closed-route coverage.
- Rebuild and audit the real Santa Cruz schema-3 pack, then run the retained
  five-start checkpoint at Quick and Thorough effort.
- Record deterministic route validity, exact/diverse results, truncation, and
  time-to-first-exact evidence.
- Run `npm run verify` and `npm run test:browser` twice and perform the final
  generated-data, secret, branch, and worktree audit.

## Local data and risks

- The generated regional pack, source cache, build cache, and audits are local
  ignored artifacts. The verified pack pointer is
  `.local-data/packs/santa-cruz-mountains/current.json`, currently resolving to
  schema-2 data version `scm-a339bce45af76f29`. Rebuild it only through the explicit
  commands documented in `README.md`; use uv for Python dependencies.
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
