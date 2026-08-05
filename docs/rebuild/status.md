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
  - Evidence: an explicit refresh populated an initially empty `.cache/gate3-empty/sources` using `npm run pack:bootstrap -- --pack=santa-cruz-mountains --cache=.cache/gate3-empty/sources --build-cache=.cache/gate3-empty/build/santa-cruz-mountains/sources --output=.local-data/packs`; an offline replay with the same paths and `--offline` reproduced data version `scm-561dc87c0f4a6bed`. The ignored pack contains 430,766 nodes, 875,166 directed edges, 3,215 access points, and four pinned sources. Its persisted regional audit reports 3,266 components (177,573 nodes / 41.22% in the largest), 55,253 rejected source ways, zero conflicts, zero missing elevation values, zero implausible metrics, and no unattributed or unknown-source records. Access audit evidence records 366 public access points, 249 outside UCSC, and four public points in the representative Monte Bello mountain box; OSM is ODbL and 3DEP is public domain. The installed-pack scenario command `node --import tsx lib/qa/run-scenarios.ts --suite data/fixtures/scenarios/santa-cruz-gate3-real.json --database .local-data/packs/santa-cruz-mountains/scm-561dc87c0f4a6bed/pack.sqlite --manifest .local-data/packs/santa-cruz-mountains/scm-561dc87c0f4a6bed/manifest.json` passes 29/29 runs, including small/large hard rectangles, all route shapes, known/unknown access, strict impossible constraints, partial-budget behavior, and every requested count from 1 through 20; all count-sweep requests were filled and the slowest typical search was 619.136 ms against the 3,000 ms budget. `npm run verify` passes 178 offline tests across 33 files plus the Next.js production build, and `npm run test:browser` passes all five Chromium regression flows. Final live in-app-browser checks on `localhost:3000` generated 10 exact default out-and-backs and seven exact loops in Monte Bello, kept short-stem routes classified as loops, preserved geographically anchored MapLibre coverage/trails/routes/hover/trailheads through zoom and pan, and confirmed the mobile map stays fixed while the results panel scrolls internally.
- [x] Gate 4 — trailhead-filter redesign, hardening, accessibility, deterministic tests, documentation
  - Evidence: the active API strictly validates `GenerateRoutesRequestV2`; Draw area, installed Named region, and ArcGIS typical Drive time filters resolve eligible trailheads without clipping hiking geometry, while exact pack coverage remains a runtime-validated route boundary. The rebuilt schema-2 Santa Cruz pack (`scm-a339bce45af76f29`) contains 425,302 nodes, 863,917 directed edges, 3,207 access points, and 476 locally searchable named areas; its persisted audit reports zero outside-coverage persisted edges, zero missing elevation values, zero unattributed records, and 11,249 rejected source edges crossing concave coverage. The offline V2 installed-pack matrix passes 25/25 runs with a 2,641.350 ms slowest typical search; its targeted regression returns an exact 8.00-mile, 1,842-foot lollipop for the previously empty 6–10 mile / 1,500–2,500 foot request. Metric-preserving graph compression, target-directed alternative-return search, adaptive edge allocation, and topology classification cover simple loops, figure-eights, chained cycles, repeated connectors, lollipops, and out-and-backs. `npm run verify` passes 269 offline tests across 51 files plus the production build; two consecutive `npm run test:browser` runs each pass all seven Chromium flows. A temporary clean clone passed `npm ci` with zero vulnerabilities and the complete `npm run verify`; all subagent worktrees and branches were removed.

- [ ] Gate 5 — topology-first closed-route engine
  - Execution plan: `docs/rebuild/closed-route-topology-plan.md`.
  - POC evidence: the schema-2 Santa Cruz scan found 418 of 2,293 eligible access points unable to reach a cycle and grouped 1,875 viable access points into 353 nearest cycle-network portals. A unified closed-route lane preserved six overlap-diverse exact routes across five mountain starts while reducing combined wall time from 7.92 seconds to 5.93 seconds (25.1%). The retained POC harness is `scripts/research/closed-route-topology-poc.ts`; it is read-only and does not change production behavior.

## Gate 5 active product decisions

- The active redesign generates trailhead-rooted closed routes only. Loop,
  lollipop, figure-eight, chained-loop, and complex are derived result labels,
  not separate solver lanes.
- Maximum repeated trail is user-controlled from 0% through 100% and defaults
  to 35%. Compound cycles are allowed by default.
- Every eligible access point receives cheap cycle-feasibility evaluation;
  expensive work is grouped by reusable cycle network instead of capped at
  eight starts.
- The remaining decisions below describe the releasable Gate 4 baseline until
  the coordinated V3/schema-3 cutover.

## Gate 4 baseline product decisions

- First coverage pack: Santa Cruz Mountains.
- User selects 1–20 routes; default 10.
- Route shapes: loop, lollipop, out-and-back, point-to-point.
- Mutually exclusive Draw area, Named region, and typical Drive time trailhead
  filters; Drive time may be refined by one named region.
- Filter geometry constrains eligible access points, not hiking geometry; exact
  pack coverage is the route boundary.
- Drive time is 5–300 minutes, defaults to 30, and excludes live traffic.
- Hiking-route distance is capped at 30 miles.
- Automatic results search up to eight starts, softly diversify to two results
  per start, then backfill globally.
- Point-to-point finish filtering is user-controlled and defaults on.
- Unknown access included by default; users can explicitly restrict results to known access.
- Exact matches are distinct from labeled near misses.
- Local Next.js + MapLibre only; no hosted deployment stack.

## Completed Gate 4 baseline

- Gate 4 is complete on the trailhead-filter integration branch. Do not repeat
  Waves 0–4 or begin from one of the archived pre-rebuild tags.
- The active next investigation is Gate 5's topology-first closed-route engine.
  A more flexible Drive-time focus control remains a separate follow-up: one
  named-region intersection is insufficient for subjective mountain areas or
  multiple disjoint parks, and that must not become a silent V2 contract change.
- The generated regional pack, source cache, build cache, and audits are local
  ignored artifacts. The verified pack pointer is
  `.local-data/packs/santa-cruz-mountains/current.json`, currently resolving to
  schema-2 data version `scm-a339bce45af76f29`. Rebuild it only through the explicit
  commands documented in `README.md`; use uv for Python dependencies.
- Begin with `git status --short --branch`, `npm ci`, `npm run verify`, and
  `npm run test:browser`. Browser tests use an isolated local server and restore
  Next-generated TypeScript configuration changes, so they can run while the
  ordinary app is open on port 3000.
- Preserve `public/vendor/maplibre/`: the local worker assets are required for
  native GeoJSON rendering. Final visual checks must use the live in-app browser
  against localhost and include zoom/pan anchoring plus mobile internal-panel
  scrolling.

### Known follow-up risks

- The pack has 3,266 graph components and its largest component contains 41.22%
  of nodes. OSM parking relations are not yet ingested, and many access points
  correctly remain marked unknown and are visibly disclosed when included.
- Compact filters may contain few viable starting access points. Preserve honest
  exact/near-miss behavior; do not relabel a short-stem loop or silently relax
  route constraints.
- The production build emits a non-fatal Turbopack warning because the local
  pack root is selected dynamically at runtime. No hosted deployment work is in
  scope.

The current private, personal-use scope is compatible with keeping all generated
packs local and ignored. If the scope ever changes to shipping or publishing a
generated pack, review the Midpen and Santa Clara County dataset terms first;
their captured metadata does not state a clear affirmative redistribution
license. This is not a blocker for local use.
