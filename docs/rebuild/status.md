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
- [ ] Gate 4 — trailhead-filter redesign, hardening, accessibility, deterministic tests, documentation
  - Evidence: in progress. The previous hard-rectangle UI baseline passed 183 offline tests, the production build, and all five Chromium flows before the V2 cutover. Gate 4 now additionally requires Draw, Named region, and Drive time access-point filters; routes may leave filter geometry but never pack coverage; the Santa Cruz pack must be rebuilt at schema 2 with named areas; and multi-start generation must remain deterministic and budgeted. Fresh-clone prerequisites and the final release-readiness audit remain outstanding.

## Current product decisions

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

## Resume point after Wave 3

- Start the next session from clean `main`; the Gate 3 implementation baseline
  is commit `855d992` (`feat: complete Wave 3 regional pack`). Do not repeat
  Waves 0–3 or begin from one of the archived pre-rebuild tags.
- Gate 4 is the next and only incomplete gate. Follow its checklist in
  `docs/rebuild/agent-runbook.md`; keep the product contracts above unchanged.
- The generated regional pack, source cache, build cache, and audits are local
  ignored artifacts. The verified pack pointer is
  `.local-data/packs/santa-cruz-mountains/current.json`, currently resolving to
  data version `scm-561dc87c0f4a6bed`. Rebuild it only through the explicit
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
