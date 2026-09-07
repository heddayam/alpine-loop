# Alpine Loop

Alpine Loop generates loop hikes from local trail data. Choose an area or
drive time, set your hiking limits and how much trail you are willing to repeat,
then search for routes.

Area filters select trailheads. Hikes can extend beyond the selected area, but
must stay within the installed data coverage. Exact matches and close matches
are shown separately.

The app runs locally with Next.js and MapLibre.

## Run locally

Install Node.js 22 or newer, then run:

```sh
npm ci
npm run verify
npm run dev
```

Open <http://localhost:3000>. To search for hikes, first
[build a regional pack](#build-a-regional-pack). The app shows a message when
no regional data is installed.

- **Quick search** returns up to the number of routes you request.
- **Full search** tries every eligible trailhead and saves up to ten exact routes
  per start, or a labeled close match. Each search is saved with its original
  area and criteria, so you can keep editing the form.

### Run with Docker

Create a local settings file and start the app:

```sh
cp .env.example .env
docker compose up --build
```

Open <http://localhost:3000>. ArcGIS keys are optional. Add them to `.env` if
you want [place suggestions and drive-time filters](#enable-drive-time-filters).

By default, the app is available only on this computer. Set `ALPINE_PORT=8080`
in `.env` to use port 8080. To allow access from other devices on your local
network, also set `ALPINE_BIND_ADDRESS=0.0.0.0`.

Build regional packs in `.local-data/packs` on your computer. Docker reads them
from that folder and stores saved searches, settings, and provider state in the
`alpine-runtime` volume. Both survive rebuilds and restarts.

Stop the app with:

```sh
docker compose down
```

### Enable drive-time filters

Copy `.env.example` to `.env` if you have not already done so. Add an ArcGIS key
with access to temporary geocoding and routing service areas:

```sh
ARCGIS_API_KEY=your-scoped-key
```

Or use separate keys:

```sh
ARCGIS_GEOCODING_API_KEY=your-geocoding-key
ARCGIS_ROUTING_API_KEY=your-routing-key
```

Restart the app or recreate the Docker service after changing `.env`.
Geocoding powers place suggestions. Routing service areas power drive-time
filters. Keys stay on the server.

Drive-time areas are cached in memory for 30 minutes. Full searches also save
their origin and drive-time area locally until you delete the search. Monthly
provider usage counts are stored separately.

### Use a different data folder

The app reads regional packs from `.local-data/packs`. To test a different set
of packs, set `ALPINE_PACK_ROOT` for that run:

```sh
ALPINE_PACK_ROOT=.local-data/packs-experiment npm run dev
```

Only packs in the chosen folder will be available. Leave this setting unset
to use the default folder.

## Build a regional pack

Install `osmium-tool` and [uv](https://docs.astral.sh/uv/), then download the
source data and build a pack:

```sh
npm run pack:bootstrap -- --pack=monterey-carmel
```

The build uses uv to run Python and rasterio. You do not need to install Python
packages with pip.

To rebuild from previously downloaded sources without network access:

```sh
npm run pack:bootstrap -- \
  --pack=monterey-carmel \
  --offline \
  --cache=.cache/sources \
  --build-cache=.cache/build/monterey-carmel/sources \
  --output=.local-data/packs
```

Downloads, caches, databases, build reports, and generated packs stay local and
are ignored by Git. Tests use small fixtures stored in the repository and never
access the network. The app reads trails locally, but uses online services for
map tiles, place suggestions, and drive-time filters.

### Check a regional pack

Run the route checks against an installed schema-6 pack. Replace
`<data-version>` with the folder name created by the build:

```sh
npm run --silent pack:checkpoint -- \
  --pack=monterey-carmel \
  --database=.local-data/packs/monterey-carmel/<data-version>/pack.sqlite \
  --manifest=.local-data/packs/monterey-carmel/<data-version>/manifest.json \
  --effort=thorough
```

For another region, change the pack name and both file paths. These checks
generate routes from sample trailheads and validate them with the same rules
the app uses.

## Project docs

- [Status and next steps](docs/rebuild/status.md)
- [Implementation plan](docs/rebuild/implementation-plan.md)
- [Route engine](docs/rebuild/closed-route-topology-plan.md)
- [Data sources and licensing](docs/rebuild/data-sources.md)
- [Regional expansion plan](docs/rebuild/regional-expansion-plan.md)
- [New region checklist](docs/rebuild/region-onboarding-checklist.md)
- [How trail access points are chosen](docs/rebuild/access-point-derivation-plan.md)
