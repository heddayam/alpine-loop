# Rebuild status

This is the durable resume point for humans and agents. Check a gate only after
its acceptance criteria pass and record the verifying commands or artifact in
the evidence line.

- [ ] Gate 0 — active app scaffold, shared contracts, fixture graph
  - Evidence: not started
- [ ] Gate 1 — map shell, pack pipeline skeleton, solver foundation
  - Evidence: not started
- [ ] Gate 2 — end-to-end route generation on committed fixtures
  - Evidence: not started
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
