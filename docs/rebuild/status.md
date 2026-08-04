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
- [ ] Gate 3 — Santa Cruz Mountains pack and full local UX
  - Evidence: not started
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
