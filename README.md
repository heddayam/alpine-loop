# Alpine Search

Alpine Search is being rebuilt as a local-first **hike builder**. A user draws a
reasonably sized rectangle on the map, optionally chooses a trailhead, specifies
route shape and physical constraints, chooses how many alternatives to request,
and receives generated routes from a versioned local trail-graph pack.

This branch is intentionally a documentation-first foundation. The previous
application has been removed from the active build so the new architecture does
not inherit its hosting and data assumptions.

## Start the implementation in a new Codex session

Use this prompt verbatim:

> Read `AGENTS.md`, then read every file in `docs/rebuild/`. Act as the primary
> integrator. Start at the first incomplete gate in `docs/rebuild/status.md` and
> execute the waves in `docs/rebuild/agent-runbook.md`. Proactively spawn the
> prescribed subagents for independent work, keep their file ownership
> disjoint, integrate and verify each gate, and continue until the first usable
> Santa Cruz Mountains hike-builder slice is complete. Do not redesign the
> decided interfaces or restore any hosted deployment stack.

The implementation specification is [docs/rebuild/implementation-plan.md](docs/rebuild/implementation-plan.md).
The agent workflow is [docs/rebuild/agent-runbook.md](docs/rebuild/agent-runbook.md).
The data policy is [docs/rebuild/data-sources.md](docs/rebuild/data-sources.md).

## What is preserved

- `legacy/isochrones/source/` is an exact source snapshot of the old `main`
  reachability/isochrone app. It is intentionally outside the future build.
- `archive/pre-redo-main-2026-08-04` preserves the old main branch.
- `archive/pre-redo-trails-2026-08-04` preserves the most complete trail-search
  branch.
- `archive/pre-redo-working-2026-08-04` preserves the former working branch.

The local-only target will use ordinary `npm install`, `npm run dev`,
`npm run build`, and `npm start`. No production hosting configuration belongs in
this foundation.
