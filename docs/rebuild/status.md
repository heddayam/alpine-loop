# Rebuild status

This is the durable resume point for humans and agents. Check a gate only after
its acceptance criteria pass and record the verifying commands or artifact in
the evidence line.

## Active system design revision

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
