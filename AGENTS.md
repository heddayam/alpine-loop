# Alpine Loop

Work backward from the hiker's experience. The active user goal and
`docs/goal.json` define acceptance. The old `docs/rebuild` plans are historical;
do not resume their gates or carry their architecture into the replacement.

## Product

- Generate loops and lollipops from trail data, with distance, elevation-gain,
  and repeated-trail constraints. Never silently relax a constraint.
- Search regions are exactly the prepared GMBA/highway sections. Search every
  eligible start in the selected regions; panning and zooming do not change scope.
  Include uncertain access by default, label it, and allow its exclusion.
  Respect explicit prohibitions.
- Search every eligible start through durable FIFO jobs. Publish immutable
  diverse results only after complete exploration and geometry storage. Keep
  progress honest; cancellation and failure expose no partial results.
- Keep job history until manual deletion. Browser reconnect restores jobs and
  stable completed-result URLs. On server restart, interrupt running jobs and
  continue queued jobs; automatic mid-search resume and legacy APIs/data formats
  are not compatibility requirements.
- Washington first; California later. No universal mileage cap, mountain-core
  qualification, drive-time service, or steepness controls in the first release.
- Focus on desktop UI for now. Challenge each element's purpose, position,
  wording and appearance against the user's next decision.
- Longer searches are acceptable. Prioritize thorough exploration, useful route
  choices, clear progress and responsive cancellation over sub-10-second results.
  Do not add machinery or truncate work solely to satisfy earlier speed targets.
- Local launch acquires usable prepared data automatically. Users never prepare
  OSM/elevation data or configure catalogs. Hosted delivery is live at
  `https://alpineloop.org` through Cloudflare Tunnel and an Azure VM. See
  `docs/hosting.md` for the last verified release and operator instructions.

## Development and releases

- Default to local development. A feature or fix request means implement, build,
  and check the running local app. Deploy when the user requests a live-site
  update or the current task already includes a production release; do not ask
  again for a release already authorized in that task.
- A new session first checks Git status, the active branch, current remote refs,
  and `docs/hosting.md`. Do not infer the deployed version from `main` or HEAD.
  Until integrated into main, `codex/cloudflare-azure` contains the hosted app;
  main alone does not contain the hosting setup or all hosted UI changes.
- Use `npm start` for native development or the local `compose.yaml`. After each
  app fix, build, typecheck, restart/rebuild the relevant local instance, and
  verify the affected flow in the running app. Run appropriate focused tests.
  Do not interrupt another session's local app or run two servers against the
  same job directory.
- Local mode and hosted mode differ: hosted Settings shows supported coverage,
  data installation is operator-controlled, and signed cookies isolate jobs.
  Hosted mutation checks require HTTPS; plain localhost HTTP is not a complete
  hosted-mode preview. Use hosted fixtures or an isolated HTTPS preview when
  verifying those behaviors before release.
- Committing, pushing, and merging Git changes do not deploy the site. Production
  releases are manual and use committed source. Before releasing, compare the
  intended changes with the commit and flag any requested edits still uncommitted.
- Follow `docs/hosting.md` for releases. Preserve server data and secrets, verify
  the deployed revision, health, and affected public flow, and update the last
  verified release record. A deployment interrupts active searches.
- Preparing region data locally does not publish it. Publish prepared assets,
  update the pinned `scripts/data-release.json`, and deploy explicitly to change
  hosted coverage. Never commit generated datasets or visitor histories.

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
- Prioritize robust code and engineering over patchwork tests. Add a test only
  when it independently protects a meaningful correctness or failure boundary.
- Keep generated datasets, downloads, caches, databases, and secrets out of Git.
  Never open a live container's WAL database through the host filesystem.
- No stack receives protected status. Add a dependency or subsystem only when
  it earns its complexity for the confirmed product. Do not restore legacy
  source as another active application.
