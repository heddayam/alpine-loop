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
    passed all six clusters with 28 exact routes, a labeled near miss for every
    deliberately impossible request, and zero directed-validation rejections.
    Catalog/API inspection exposes Monterey as available and selected and
    returns all five reviewed regions. Two consecutive `npm run verify` runs
    each pass 386 tests across 77 files plus the production build, and two
    consecutive `npm run test:browser` runs each pass all five Chromium flows.

## Post-gate fixes

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
  match over a near miss, and the pack compiler removes generic OSM access records
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
