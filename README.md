# Alpine Loop

Alpine Loop is a local-first **hike builder**. A user filters eligible
trailheads by a drawn area, an installed named region, or a typical drive-time
area, optionally chooses one of those trailheads, sets physical constraints and
acceptable repeated trail, and receives closed routes from a versioned local
trail-graph pack. Filter shapes do not clip hikes; exact installed-pack coverage
is the route boundary.

The application is standard local Next.js plus MapLibre. No hosted deployment
stack is part of the active build.

## Run locally

Use Node.js 22 or newer, then install and verify the ordinary local app:

```sh
npm ci
npm run verify
npm run dev
```

Open <http://localhost:3000> in a browser. The committed fixture keeps the UI
and automated tests usable without generated data; route generation requires
an installed schema-5 regional pack for Batch search and exact grade-experience
filtering.

### Enable drive-time filters

ArcGIS credentials stay server-only. Copy `.env.example` to `.env` and
set either one shared scoped key or separate geocoding and routing keys:

```sh
# One key authorized for both temporary geocoding and service areas:
ARCGIS_API_KEY=your-scoped-key

# Or separate least-privilege keys:
ARCGIS_GEOCODING_API_KEY=your-geocoding-key
ARCGIS_ROUTING_API_KEY=your-routing-key
```

Restart `npm run dev` after changing `.env`. Typed place suggestions need
geocoding access; calculating the typical drive-time area needs routing service
area access. The browser never receives either credential. Provider jobs and
reachability results stay in process memory for 30 minutes. A launched Batch
job snapshots its origin and contour in ignored local SQLite until that job is
deleted; aggregate monthly provider counters are stored separately.

## Build a regional pack

Real-pack builds additionally require `osmium-tool` and
[uv](https://docs.astral.sh/uv/). Python and rasterio are invoked through uv;
do not install project Python packages with pip. This explicit command is the
only workflow that refreshes sources over the network:

```sh
npm run pack:bootstrap -- --pack=monterey-carmel
```

To rebuild only from an already populated pinned source cache:

```sh
npm run pack:bootstrap -- \
  --pack=monterey-carmel \
  --offline \
  --cache=.cache/sources \
  --build-cache=.cache/build/monterey-carmel/sources \
  --output=.local-data/packs
```

Downloads, build caches, SQLite databases, audit output, and generated packs
remain local and ignored by Git. Normal runtime and automated tests never use
the network.

### Verify an installed closed-route pack

The retained real-pack checkpoints exercise the active V3 closed-route runtime
against representative starts. For Monterey–Carmel:

```sh
node --import tsx scripts/research/gate9-monterey-carmel-checkpoint.ts \
  --database=.local-data/packs/monterey-carmel/<data-version>/pack.sqlite \
  --manifest=.local-data/packs/monterey-carmel/<data-version>/manifest.json \
  --effort=thorough
```

The original Santa Cruz checkpoint remains available:

```sh
node --import tsx scripts/research/gate5-topology-real-checkpoint.ts \
  --database=.local-data/packs/santa-cruz-mountains/<data-version>/pack.sqlite \
  --manifest=.local-data/packs/santa-cruz-mountains/<data-version>/manifest.json
```

Closed-route search uses bounded penalized forward/return searches, strict
disjoint-return refinement, core-aware lollipop search, below-range assembly,
and local repair. The production validator remains authoritative for closure,
coverage, topology, repetition, shared stem, and exact-versus-near-miss status.

## Project references

- [Current status and resume point](docs/rebuild/status.md)
- [Implementation specification](docs/rebuild/implementation-plan.md)
- [Closed-route engine reference](docs/rebuild/closed-route-topology-plan.md)
- [Data-source and licensing policy](docs/rebuild/data-sources.md)
- [Regional expansion roadmap and pack-onboarding protocol](docs/rebuild/regional-expansion-plan.md)

The removed pre-rebuild app remains recoverable from the
`archive/pre-redo-main-2026-08-04`, `archive/pre-redo-trails-2026-08-04`, and
`archive/pre-redo-working-2026-08-04` tags.
