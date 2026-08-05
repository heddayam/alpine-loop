# Alpine Search

Alpine Search is a local-first **hike builder**. A user filters eligible
trailheads by a drawn area, an installed named region, or a typical drive-time
area, optionally chooses one of those trailheads, specifies route shape and
physical constraints, and receives generated routes from a versioned local
trail-graph pack. Filter shapes do not clip hikes; exact installed-pack coverage
is the route boundary.

The active application is standard local Next.js plus MapLibre. The previous
application remains excluded under `legacy/`; no hosted deployment stack is
part of the active build.

## Run locally

Use Node.js 22 or newer, then install and verify the ordinary local app:

```sh
npm ci
npm run verify
npm run dev
```

Without an installed regional pack the app uses its small committed fixture.
Open <http://localhost:3000> in a browser.

## Build the Santa Cruz Mountains pack

Real-pack builds additionally require `osmium-tool` and
[uv](https://docs.astral.sh/uv/). Python and rasterio are invoked through uv;
do not install project Python packages with pip. This explicit command is the
only workflow that refreshes sources over the network:

```sh
npm run pack:bootstrap -- --pack=santa-cruz-mountains
```

To rebuild only from an already populated pinned source cache:

```sh
npm run pack:bootstrap -- \
  --pack=santa-cruz-mountains \
  --offline \
  --cache=.cache/sources \
  --build-cache=.cache/build/santa-cruz-mountains/sources \
  --output=.local-data/packs
```

Downloads, build caches, SQLite databases, audit output, and generated packs
remain local and ignored by Git. Normal runtime and automated tests never use
the network.

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

The local-only target uses ordinary `npm install`, `npm run dev`,
`npm run build`, and `npm start`. No production hosting configuration belongs in
this repository.
