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
  - Evidence: an explicit refresh populated an initially empty `.cache/gate3-empty/sources` using `npm run pack:bootstrap -- --pack=santa-cruz-mountains --cache=.cache/gate3-empty/sources --build-cache=.cache/gate3-empty/build/santa-cruz-mountains/sources --output=.local-data/packs`; an offline replay with the same paths and `--offline` reproduced data version `scm-561dc87c0f4a6bed`. The ignored pack contains 430,766 nodes, 875,166 directed edges, 3,215 access points, and four pinned sources. Its persisted regional audit reports 3,266 components (177,573 nodes / 41.22% in the largest), 55,253 rejected source ways, zero conflicts, zero missing elevation values, zero implausible metrics, and no unattributed or unknown-source records. Access audit evidence records 366 public access points, 249 outside UCSC, and four public points in the representative Monte Bello mountain box; OSM is ODbL and 3DEP is public domain, while Midpen and Santa Clara County overlays remain local-evaluation-only pending redistribution-license review. The installed-pack scenario command `node --import tsx lib/qa/run-scenarios.ts --suite data/fixtures/scenarios/santa-cruz-gate3-real.json --database .local-data/packs/santa-cruz-mountains/scm-561dc87c0f4a6bed/pack.sqlite --manifest .local-data/packs/santa-cruz-mountains/scm-561dc87c0f4a6bed/manifest.json` passes 29/29 runs, including small/large hard rectangles, all route shapes, known/unknown access, strict impossible constraints, partial-budget behavior, and every requested count from 1 through 20; all count-sweep requests were filled and the slowest typical search was 619.136 ms against the 3,000 ms budget. `npm run verify` passes 178 offline tests across 33 files plus the Next.js production build, and `npm run test:browser` passes all five Chromium regression flows. Final live in-app-browser checks on `localhost:3000` generated 10 exact default out-and-backs and seven exact loops in Monte Bello, kept short-stem routes classified as loops, preserved geographically anchored MapLibre coverage/trails/routes/hover/trailheads through zoom and pan, and confirmed the mobile map stays fixed while the results panel scrolls internally.
- [ ] Gate 4 — hardening, accessibility, deterministic tests, documentation
  - Evidence: not started

## Current product decisions

- First coverage pack: Santa Cruz Mountains.
- User selects 1–20 routes; default 10.
- Route shapes: loop, lollipop, out-and-back, point-to-point.
- Hard rectangle boundary; optional explicit starting access point.
- Unknown access excluded by default.
- Exact matches are distinct from labeled near misses.
- Local Next.js + MapLibre only; no hosted deployment stack.
