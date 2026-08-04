# Multi-agent implementation runbook

## Integrator contract

The primary agent runs the whole effort. It reads `AGENTS.md`, this runbook, the
implementation plan, data policy, and status file before acting. It owns:

- task decomposition and dependency order;
- root `package.json`, lockfile, framework/test configs, and shared contracts;
- integration, conflict resolution, full-suite verification, and status updates;
- creation and removal of subagent branches/worktrees.

At most four agents may be active including the integrator, so spawn no more
than three subagents at a time. Use subagents only when their inputs are already
stable and their file ownership does not overlap. Never have multiple agents edit
the lockfile or shared schema files.

Each delegated prompt must include: objective, allowed files, forbidden files,
accepted contracts, required tests, the exact verification command, and the
requirement to return a concise summary plus commit hash. Subagents may inspect
the whole repo but edit only their ownership set.

## Git/worktree lifecycle

For every task:

1. Integrator starts from a verified `main` and creates `codex/<short-task>` in a
   dedicated worktree if simultaneous edits are planned.
2. Subagent makes one focused commit and reports tests and known limitations.
3. Integrator reviews the diff and runs the task’s focused tests.
4. Integrator integrates (prefer squash), then runs the gate suite on `main`.
5. Integrator removes the worktree and deletes the task branch immediately.

Never retain “maybe useful” branches; tags or commits already preserve history.
There may be only one active integration branch, and it should normally be
unnecessary because the integrator integrates directly in dependency order.

## Wave 0 — integrator only: stabilize the contracts

Do not delegate setup because the following files are shared by all later work.

Deliverables:

- scaffold standard Next.js/TypeScript/MapLibre app and ordinary npm scripts;
- configure lint, unit tests, browser tests, and build exclusions for `legacy`;
- create `lib/contracts` request/response/manifest schemas exactly as specified;
- create a tiny fixture graph capable of all four shapes;
- define `GraphRepository`, graph primitives, solver budget, and adapter
  interfaces without implementing the full solver;
- add a CI-equivalent local `npm run verify` script;
- update Gate 0 evidence and commit.

Verification: clean install, lint, typecheck, unit tests, and production build.

## Wave 1 — three parallel foundations

Spawn these agents after Gate 0 contracts are committed.

### Agent A: map and builder shell

Ownership: `app/**`, `components/builder/**`, `components/map/**`, and related UI
tests only. Do not edit `package.json`, lockfile, shared contracts, solver, or
data compiler.

Deliver rectangle draw/edit/clear, hard-boundary preview, access-point selection
from the fixture repository endpoint, all range inputs, route-shape controls,
unknown-access toggle, 1–20 route count defaulting to 10, validation, responsive
panels, and accessible loading/empty states. Mock the generation API in component
tests; do not invent a second contract.

### Agent B: pack compiler foundation

Ownership: `lib/data/**`, `scripts/**`, `data/fixtures/source/**`, and compiler
tests. Do not edit app UI, solver, root config, or shared contracts.

Deliver versioned source-adapter interfaces, a fixture OSM-like topology adapter,
a fixture official-access overlay adapter, fixture elevation sampling, SQLite
pack writing, manifest creation, atomic publish behavior, and an audit report.
All tests use committed tiny inputs and no network.

### Agent C: solver foundation

Ownership: `lib/graph/**`, `lib/solver/**`, `data/fixtures/graph/**`, and solver
tests. Do not edit UI, API route, compiler, root config, or shared contracts.

Deliver read-only fixture/SQLite repositories, induced hard-boundary graph,
direction and access filtering, deterministic canonical IDs, budget/cancellation
checks, candidate/scoring primitives, and initial shape generation. Test every
invariant with small graphs.

### Wave 1 integration gate

Integrator reviews and integrates B, C, then A (or another conflict-free order),
wires only shared boundaries, runs full verification, performs a manual draw
interaction, updates Gate 1 evidence, and removes all three worktrees/branches.

## Wave 2 — vertical slice

After Gate 1, spawn up to three agents with these disjoint goals.

### Agent D: API and repository integration

Ownership: `app/api/routes/**`, API integration tests, and narrowly required
server composition modules. Use existing contracts and solver. Implement
validation, pack loading, abort/deadline propagation, diagnostics, structured
errors, and no-network tests.

### Agent E: shape completeness and constraint quality

Ownership: `lib/solver/**`, solver fixtures, solver tests. Complete all four
route shapes, direction-aware metrics, min/max constraints, 35% lollipop rule,
80% overlap diversity, exact/near-miss separation, stable ranking, requested
count handling, and partial/budget behavior.

### Agent F: result exploration UX

Ownership: `components/results/**`, narrowly scoped integration in existing UI
composition files agreed with the integrator, and UI/browser tests. Deliver
exact and near-miss sections, route selection/highlighting, metric/warning cards,
partial/no-result/error/cancelled states, elevation profile when present, and
responsive/keyboard behavior.

### Wave 2 integration gate

Integrator connects the real UI → API → solver → fixture pack path, adds one
Playwright happy-path test and one no-exact-match test, runs deterministic repeat
checks, updates Gate 2 evidence, and removes all task branches/worktrees.

## Wave 3 — real data and system QA

Run at most two data agents in parallel with one QA agent while the integrator
coordinates source decisions.

### Agent G: OSM and elevation pipeline

Ownership: OSM/DEM adapters and build scripts. Implement pinned Geofabrik
Northern California download, polygon extraction with `osmium-tool`, hiking
topology normalization, 3DEP ingestion, edge metric calculation, caching, and
resume-safe atomic staging. Network calls occur only in explicit refresh
commands, never tests or runtime.

### Agent H: official access overlays and pack audit

Ownership: authority adapters, access reconciliation, provenance, licensing
metadata, and audit tests. Locate authoritative downloadable/ArcGIS REST layers
for the first-pack agencies, pin their endpoints/schema, fail on drift, and
produce known/unknown/closed/conflict counts. Do not scrape dashboards.

### Agent I: scenario and usability QA

Ownership: curated scenario fixtures, browser tests, accessibility checks, and
performance harness. Do not rewrite product code unless the integrator assigns a
specific fix. Exercise representative small/large rectangles, every shape,
strict/impossible constraints, 1 and 20 results, unknown access, stale data, and
budget exhaustion.

### Wave 3 integration gate

Integrator builds the pack from an empty cache, reviews the audit and license
records, runs curated scenarios, confirms typical searches meet the 3 s budget,
updates Gate 3, and removes worktrees/branches.

## Wave 4 — integrator-led hardening

Delegate only isolated fixes discovered by the gate audit. The integrator:

- completes keyboard, screen-reader, responsive, and non-color distinctions;
- confirms every error/partial/stale/cancelled state;
- verifies fresh-clone setup and the bootstrap documentation;
- searches for generated data, secrets, retired hosting config, stale branches,
  and worktrees;
- runs the full verify and browser suites twice to catch nondeterminism;
- updates Gate 4 and writes the release/readiness summary.

## Review checklist for every subagent result

- The diff stays within assigned ownership.
- Public contracts are reused rather than duplicated.
- Tests assert behavior, including failure/boundary cases, without network.
- Generated data, caches, credentials, and large binaries are absent.
- Deterministic output and cancellation/budgets are preserved.
- User-visible constraint relaxation never occurs silently.
- The focused tests and full current gate suite pass.
