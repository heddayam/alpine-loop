# Alpine Loop

Alpine Loop generates loop hikes from local trail data. Choose a region, draw
an area, or set a minimum and maximum drive time; then specify distance, elevation, grade, and how
much trail you are willing to repeat.

- **Full search** works through every eligible trailhead and saves its progress
  and results. You can cancel it and keep the routes found so far.
- **Exact and close matches stay separate.** Constraints are never relaxed
  silently, and unknown trail access is included unless you disable it.

Areas select starting points; they do not clip hikes. Routes can extend beyond
an area while staying inside installed data coverage. Results include route
geometry, elevation profiles, repetition, and mapped trail conditions.

Open a route in Results and choose **Export GPX** to download its full track
and starting point. In [CalTopo](https://training.caltopo.com/all_users/import-export/import),
choose **Import** and select the downloaded `.gpx` file. Export also works for
saved Full-search results.

## Get started

Install Git and Docker with Docker Compose, and make sure Docker is running. I personally use orbStack.
On Windows, use a WSL terminal with Docker integration enabled.

```sh
git clone https://github.com/heddayam/alpine-loop.git
cd alpine-loop
./alpine.sh
```

Open [localhost:3000](http://localhost:3000). In **Coverage**, beside Settings,
select map sections, review their download and disk sizes, and download them.
You can pause or resume downloads and keep searching the current installation.
The whole selection activates after verification. Named hiking regions remain
search filters; they are separate from download sections.

Set `ALPINE_COVERAGE_CATALOG` to a maintained HTTPS `release.json` URL, or use a
local developer release. Docker defaults to `.local-data/releases/prepared`.
A public catalog is not bundled with the repository. Without a configured
release, Coverage explains that data is unavailable.

The app downloads prepared SQLite data. It does not run Python, GDAL, osmium,
or source compilation. Mapped beach trails are supported; tide timing is not
modeled.

### Manage your data

Use Coverage to add, update, or remove sections. Updates replace all selected
coverage with one compatible release. Verified downloads survive interruption;
running and saved searches retain their referenced installation. Previously
built regional packs require a one-time reinstall. Saved route geometry,
metadata, and GPX exports remain readable; legacy files are preserved until
replacement coverage has been verified.

| Data | Location |
| --- | --- |
| Native installed artifacts and download jobs | `.local-data/coverage/` |
| Developer release output | `.local-data/releases/prepared/` |
| Developer sources and staging | `.cache/` or configured build root |
| Docker coverage, searches, and settings | `alpine-runtime` Docker volume |

`docker compose down` preserves runtime data; `docker compose down -v` deletes
that volume. Restart with `./alpine.sh` or `docker compose up -d app`.

### Optional settings

Named regions and drawn areas work without API keys. For place suggestions and
drive-time filters, add an ArcGIS key with temporary geocoding and routing
service-area access to `.env`:

```dotenv
ARCGIS_API_KEY=your-key
```

Separate scoped keys are also supported; see [.env.example](.env.example).
Keys stay on the server. Apply changes with
`docker compose up --force-recreate` or restart the local development server.
Trail and elevation data are local; map tiles, place suggestions, and drive-time
filters use online services.

The app binds to localhost by default. Set `ALPINE_PORT=8080` in `.env` to change
the port, or `ALPINE_BIND_ADDRESS=0.0.0.0` to allow local-network access.

## Develop

Use Node.js 24:

```sh
npm ci
npm run dev
```

Open [localhost:3000](http://localhost:3000). Changes reload automatically. Local
development stores saved searches and settings in `.local-data/runtime/`.
Set `ALPINE_COVERAGE_CATALOG` to the release directory used by your build.

```sh
npm run verify                  # Lint, types, unit tests, production build
npx playwright install chromium # First browser-test setup
npm run test:browser             # Browser flows using committed fixtures
```

Automated tests do not fetch trail data or call external providers.

### Developer data builds

The workflow is **discover → inspect networks → build selected IDs**. A source
recipe pins provider data, supported source boundaries and reviewed exclusions;
it contains no hike or geographic build selector. Discovery saves connectivity
without downloading elevation or preparing route graphs. The first import still
reads the full provider extract and can take time and substantial disk space.
Later commands verify and reuse that discovery.

```sh
# Build the tooling image; this does not build trail data.
docker compose build data

# This checkout already has the pinned Washington extract in this cache.
docker compose run --rm \
  -e ALPINE_SOURCE_CACHE=/app/.cache/progressive-feasibility/shared-sources \
  data scripts/data.ts discover data/coverage/recipes/washington.json
```

Discovery prints the paths to `catalog.json` and `networks.html` under
`.cache/build/discovery/`. Open the printed HTML path in your browser. It works
offline and lets you sort/filter networks, inspect their full geographic extents,
trail length, node/edge counts and structural cycle rank, then copy an ID.
These are source-network extents, not detailed trail lines. Cycle rank does not
count valid hikes; a network with rank zero has no simple physical loop.
Download and prepared-file sizes remain unknown until compilation.

Set `CATALOG` to the exact catalog path printed by discovery and `NETWORK` to
the ID you chose. Then run:

```sh
CATALOG='.cache/build/discovery/<fingerprint>/catalog.json'
NETWORK='network-<id-from-preview>'

docker compose run --rm \
  -e ALPINE_SOURCE_CACHE=/app/.cache/progressive-feasibility/shared-sources \
  data scripts/data.ts build "$CATALOG" --network "$NETWORK"

# In another terminal, monitor discovery or preparation:
npm run data -- status --watch

# After preparation, audit the published files:
docker compose run --rm data scripts/data.ts inspect .local-data/releases/prepared/release.json
```

Replace the angle-bracket placeholders before running the assignments. Repeat
`--network ID` to build several networks into one catalog. The selected IDs define
the published catalog; include previously published IDs when extending it.
Unchanged network artifacts are reused. A changed or corrupted discovery is
rejected before preparation; rerun discovery when source inputs change.

The source-cache override reuses this checkout's existing downloads. A fresh
clone can omit it. Source recipes allow acquisition of missing inputs. Ctrl+C
stops at a checkpoint; repeat the command to reuse verified completed work.
Build reports live at `${ALPINE_COVERAGE_ROOT:-.cache/build}/status.json`.
`status [report.json] --watch` refreshes every five seconds; a stale report is
not a live heartbeat.

For native tooling, install `osmium-tool` and `uv`, then run
`uv sync --frozen --project tools/dem --python 3.12`. The equivalent commands are
`npm run data -- discover data/coverage/recipes/washington.json`,
`npm run data -- networks "$CATALOG"` to reopen inspection, and
`npm run data -- build "$CATALOG" --network "$NETWORK"`. Set
`ALPINE_SOURCE_CACHE` to the matching host cache path when reusing downloads.
The old geographic recipes, planner and standalone export command are removed.

The app already mounts `.local-data/releases`. Refresh it after publication,
open **Coverage**, select a network, review its extent/size and click **Download**.
Publication makes networks available; Download installs them for search. Building
or restarting the `app` image alone does neither. Old geographic coverage was
removed for the clean cutover; saved route results and settings were retained.

The separate Docker `data` service includes these tools and applies a 4 GiB
memory limit with swap disabled. The ordinary `app` image excludes them.
See [prepared coverage](docs/rebuild/prepared-coverage.md) for contracts,
configuration, and acceptance evidence. Large-region feasibility remains
unproven until the measured build gate passes.

### How it fits together

```mermaid
flowchart LR
    Sources["Pinned trail sources"] --> Discovery["Discover and inspect networks"]
    Discovery --> Selection["Choose network IDs"]
    Selection --> Builder["Prepare metrics, analyze and audit"]
    Builder --> Release["Static catalog + compressed SQLite files"]
    Release --> Download["Verify and activate installation"]
    Download --> Reader["One bounded graph reader"]
    Reader --> Solver["Existing hike solver"]
    Solver --> Map["Next.js + MapLibre"]
    Solver --> Jobs["Saved searches"]
```

There is no merged local routing database. Files share release-wide source
identities, and routes can cross installed section boundaries. Full search
uses one coherent graph and distributes starts among bounded workers.
`ALPINE_SOLVER_WORKERS` accepts 1–8 and defaults to at most two available CPUs.
Saved Full searches remain FIFO with ordered checkpoints.

- `app/` and `components/` — API routes and map workspace.
- `lib/solver/` and `lib/graph/` — route generation and bounded graph reads.
- `lib/data/` and `lib/coverage/` — developer compilation and audits.
- `lib/coverage-install/` — prepared downloads, installations, and retention.
- `lib/route-jobs/` — saved search execution and persistence.

## Further reading

- [System design](docs/rebuild/system-design.md) and [product behavior](docs/rebuild/implementation-plan.md)
- [Route engine](docs/rebuild/closed-route-topology-plan.md)
- [Data sources and licensing](docs/rebuild/data-sources.md)
- [Regional roadmap](docs/rebuild/regional-expansion-plan.md) and [new region checklist](docs/rebuild/region-onboarding-checklist.md)
- [Project status](docs/rebuild/status.md)
