# Alpine Loop

Alpine Loop is a **loop hike builder**. A user filters eligible
trailheads by a drawn area, an installed named region, or a typical drive-time
area, sets physical constraints and
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

Open <http://localhost:3000> in a browser. Search requires installed schema-6
regional data. Without it, the app shows a data-unavailable state. Automated
tests compile small committed inputs into the same SQLite format used locally.

Quick search returns up to the requested number of alternatives across eligible data.
Full search attempts every eligible trailhead and retains up to ten exact routes
per start, or a clearly labeled close match. One Full search creates one saved
job. Results keep their original area and criteria while the form remains editable.

### Run with Docker

From a fresh clone, create the local environment file and start the production
app:

```sh
cp .env.example .env
docker compose up --build
```

Open <http://localhost:3000>. Compose checks the app at `/api/health` and passes
the ArcGIS variables from `.env` into the container. The ArcGIS keys are
optional: leave them blank if place suggestions and drive-time filters are not
needed, or configure them as described below.

The service binds to localhost by default. Set `ALPINE_PORT=8080` in `.env` to
use <http://localhost:8080> instead. Set `ALPINE_BIND_ADDRESS=0.0.0.0` only when
access from other devices on the local network is intentional.

Generating routes requires installed regional data under the host's ignored
`.local-data/packs` directory. Compose mounts that catalog read-only. Job, settings, and provider state use the persistent
`alpine-runtime` Docker volume. Both survive image rebuilds and container
restarts. Secrets, generated packs, and runtime databases are not copied into
the image or committed to Git.

Stop the app with:

```sh
docker compose down
```

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

Restart the local app or recreate the Docker service after changing `.env`.
Typed place suggestions need geocoding access; calculating the typical
drive-time area needs routing service area access. The browser never receives
either credential. Completed drive-time areas are cached in process memory for 30 minutes.
A Full search snapshots its origin and contour in
ignored local SQLite until that job is deleted; aggregate monthly provider
counters are stored separately.

### Override the installed-pack catalog

The app loads all installed regional packs from `.local-data/packs` by default.
`ALPINE_PACK_ROOT` replaces that entire catalog; it does not select an
alternative build for one region. Leave it unset during normal development.
For isolated pack testing, scope the override to that one process and expect
only packs installed beneath the alternate root to be available:

```sh
ALPINE_PACK_ROOT=.local-data/packs-experiment npm run dev
```

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
remain local and ignored by Git. Automated tests never use the network. The runtime reads trails locally;
basemap tiles, place suggestions, and drive-time resolution use their providers.

### Verify an installed closed-route pack

Every new schema-6 region uses the shared checkpoint runner. For Henry Coe:

```sh
npm run --silent pack:checkpoint -- \
  --pack=henry-coe \
  --database=.local-data/packs/henry-coe/<data-version>/pack.sqlite \
  --manifest=.local-data/packs/henry-coe/<data-version>/manifest.json \
  --effort=thorough
```

The shared real-pack checkpoint exercises the closed-route engine
against representative starts. For Monterey–Carmel:

```sh
npm run --silent pack:checkpoint -- \
  --pack=monterey-carmel \
  --database=.local-data/packs/monterey-carmel/<data-version>/pack.sqlite \
  --manifest=.local-data/packs/monterey-carmel/<data-version>/manifest.json \
  --effort=thorough
```

Closed-route search uses bounded penalized forward/return searches, strict
disjoint-return refinement, core-aware lollipop search, below-range assembly,
and local repair. The production validator remains authoritative for closure,
coverage, topology, repetition, shared stem, and exact-versus-close-match status.

## Project references

- [Current status and resume point](docs/rebuild/status.md)
- [Implementation specification](docs/rebuild/implementation-plan.md)
- [Closed-route engine reference](docs/rebuild/closed-route-topology-plan.md)
- [Data-source and licensing policy](docs/rebuild/data-sources.md)
- [Regional expansion roadmap and pack-onboarding protocol](docs/rebuild/regional-expansion-plan.md)
- [Exact schema-6 region onboarding checklist and friction ledger](docs/rebuild/region-onboarding-checklist.md)
- [Access-point derivation plan](docs/rebuild/access-point-derivation-plan.md)

The removed pre-rebuild app remains recoverable from the
`archive/pre-redo-main-2026-08-04`, `archive/pre-redo-trails-2026-08-04`, and
`archive/pre-redo-working-2026-08-04` tags.
