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

### Enable drive-time filters

ArcGIS credentials stay server-only. Copy `.env.example` to `.env.local` and
set either one shared scoped key or separate geocoding and routing keys:

```sh
# One key authorized for both temporary geocoding and service areas:
ARCGIS_API_KEY=your-scoped-key

# Or separate least-privilege keys:
ARCGIS_GEOCODING_API_KEY=your-geocoding-key
ARCGIS_ROUTING_API_KEY=your-routing-key
```

Restart `npm run dev` after changing `.env.local`. Typed place suggestions need
geocoding access; calculating the typical drive-time area needs routing service
area access. The browser never receives either credential. Provider jobs and
location-bearing results stay in process memory for 30 minutes; only aggregate
monthly usage counters are stored in ignored local SQLite.

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

### Verify an installed schema-3 pack

The retained real-pack checkpoint exercises the active V3 closed-route runtime
against representative Santa Cruz trailheads:

```sh
node --import tsx scripts/research/gate5-topology-real-checkpoint.ts \
  --database=.local-data/packs/santa-cruz-mountains/<data-version>/pack.sqlite \
  --manifest=.local-data/packs/santa-cruz-mountains/<data-version>/manifest.json
```

Closed-route search uses bounded penalized forward/return searches, strict
disjoint-return refinement, core-aware lollipop search, below-range assembly,
and local repair. The production validator remains authoritative for closure,
coverage, topology, repetition, shared stem, and exact-versus-near-miss status.

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
