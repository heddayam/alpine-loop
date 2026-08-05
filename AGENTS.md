# Alpine Search agent instructions

This repository is a clean reboot. The product and technical decisions are in
`docs/rebuild/implementation-plan.md`; the execution protocol is in
`docs/rebuild/agent-runbook.md`. Read both files completely before changing the
application.

## Required operating mode

- The primary agent is the integrator and owns the shared contracts, root
  configuration, lockfile, and final verification.
- Start at the first incomplete gate in `docs/rebuild/status.md`.
- When a wave has independent work, proactively spawn the bounded subagents
  prescribed by `docs/rebuild/agent-runbook.md` (at most three at once, leaving
  one concurrency slot for the integrator). Do not wait for another request to
  delegate.
- Give each subagent exclusive file ownership and a concrete testable outcome.
  Use short-lived `codex/<task>` branches or isolated worktrees. Integrate one
  focused commit at a time, then remove its worktree and branch.
- Do not ask subagents to redesign the product, API, route definitions, or data
  contract. Escalate only a genuine contradiction or an unavailable required
  data source.
- Update `docs/rebuild/status.md` with evidence whenever a gate is completed.
- Keep network access out of automated tests. Use committed fixtures.
- Keep generated regional packs, raw downloads, caches, secrets, and databases
  out of Git.

## Product invariants

- This is a hike-route generator, not a catalog of known hikes.
- Drawn areas, named regions, and drive-time contours filter eligible access
  points; they do not clip hiking routes. Exact installed-pack coverage is the
  hard geometry boundary.
- Unknown access is included by default and can be explicitly disabled.
- Return exact matches separately from clearly labeled near misses; never relax
  constraints silently.
- Route count is chosen by the user from 1 through 20 and defaults to 10.
- The active app is standard local Next.js plus MapLibre. Do not restore Sites,
  ChatGPT/OpenAI hosting, Cloudflare Workers, D1, R2, vinext, or Vite hosting.
- `legacy/isochrones/source` is reference material only and must remain excluded
  from the active build and TypeScript configuration.

## Git hygiene

- `main` must remain releasable and have one clear purpose per commit.
- Prefer `codex/<task>` branches, squash integration, and branch deletion after
  merge. There may be at most one active integration branch.
- Never leave completed worktrees behind.
- Preserve the `archive/pre-redo-*` tags. They are the durable path to old work.
