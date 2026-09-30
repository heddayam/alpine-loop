# Alpine Loop

Work backward from the hiker's experience. The active user goal and
`docs/goal.json` define acceptance. The old `docs/rebuild` plans are historical;
do not resume their gates or carry their architecture into the replacement.

## Product

- Generate loops and lollipops from trail data, with distance, elevation-gain,
  and repeated-trail constraints. Never silently relax a constraint.
- The visible or drawn area selects starts; it does not clip routes. Familiar
  hiking-region names are navigation shortcuts. Include uncertain access by
  default, label it, and allow its exclusion. Respect explicit prohibitions.
- Search every eligible start, show diverse results progressively, distinguish
  attempted starts from completed exploration, and disclose unfinished work.
- Keep the current search alive while the server runs. Reopening the browser
  reconnects. Restart recovery, old saved jobs, old APIs, and old data formats
  are not compatibility requirements.
- Washington first; California later. No universal mileage cap, mountain-core
  qualification, drive-time service, or steepness controls in the first release.
- Local launch acquires usable prepared data automatically. Hosted use starts
  from a URL. Users never prepare OSM/elevation data or configure catalogs.

## Execution

- First deliver a complete small slice on real data. Freeze at least 20 realistic
  benchmark queries across three Washington areas before optimizing.
- The integrator owns shared models, root configuration, lockfile, integration,
  and final verification. Delegate up to three independent tasks with exclusive
  file ownership, a concrete outcome, and a focused commit in separate worktrees.
- Use one active `codex/` integration branch. Preserve existing archive tags and
  user-owned changes. Remove task worktrees and branches after integration.
- Measure maintained app plus preparation/tooling code with `scripts/source-size.mjs`.
  Moving code or compressing formatting does not count as simplification.
- Keep tests focused on independent route correctness and real whole-app flows.
  Automated tests are offline and use committed fixtures; real-data performance
  measurements are separate. No test-count target or repeated full-suite ritual.
- Keep generated datasets, downloads, caches, databases, and secrets out of Git.
  Never open a live container's WAL database through the host filesystem.
- No stack receives protected status. Add a dependency or subsystem only when
  it earns its complexity for the confirmed product. Do not restore legacy
  source as another active application.
