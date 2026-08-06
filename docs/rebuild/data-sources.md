# Data sources and storage policy

## Decision summary

The application must not query OpenStreetMap while serving a user request. Build
a local, versioned regional graph pack in an explicit refresh pipeline. This is
more reliable, faster, reproducible, and friendlier to community services than
using the public editing API or Overpass as a routing backend.

An OSM account is **not required** to download or use OSM data. Create one only
if a human plans to edit OSM. Never automate edits or upload derived official
agency restrictions to OSM without a separate reviewed contribution workflow.

## First pack: Santa Cruz Mountains

The pack boundary should cover the Santa Cruz Mountains as a geographic unit,
not a particular park agency. Keep the boundary as a versioned GeoJSON build
input so it can be adjusted without changing app or solver code.

### Trail topology

- Primary snapshot: [Geofabrik Northern California
  `.osm.pbf`](https://download.geofabrik.de/north-america/us/california/norcal.html).
- Pin the source URL, retrieval time, upstream timestamp, size, and SHA-256 in
  build metadata.
- Use [`osmium extract`](https://docs.osmcode.org/osmium/latest/osmium-extract.html)
  with the versioned pack polygon and a reference-complete strategy before
  retaining ways/nodes needed for pedestrian topology.
- Interpret hiking-relevant highway/path/foot/access/oneway/route/relation tags
  through a versioned adapter with fixture tests.
- Use Overpass only for small manual QA queries while developing an adapter, not
  for a pack build dependency or at runtime.
- The main OSM API is an editing API and is not an appropriate bulk data or
  routing service. The [OSMF API usage policy](https://operations.osmfoundation.org/policies/api/)
  explicitly directs large/frequent readers to bulk downloads and geographic
  extracts.

### Official access and status overlays

Implement one adapter per authority. For the first pack, prioritize datasets from
Midpeninsula Regional Open Space District, California State Parks, Santa Clara
County Parks, and San Mateo County Parks. USGS National Digital Trails can be a
cross-check/fallback where its license and current availability fit.

Each adapter must save the original authority URL and version/date, normalize
only documented fields, and retain source references on every affected record.
Precedence should be explicit:

1. current official closure/prohibition;
2. current official public permission;
3. clear OSM access tags;
4. unknown.

Conflicting evidence becomes a build-audit error or `unknown`; it is never
silently resolved toward permissive access. Unknown access is included by
default and can be explicitly disabled by the user.

Agency services change. Adapter code must fail loudly on missing fields, schema
drift, unexpected coordinate systems, or empty responses. Do not scrape the
Midpen dashboard UI; find and pin its underlying authoritative ArcGIS REST layer
or an official downloadable dataset during Gate 3.

### Elevation

- Primary source: [USGS 3D Elevation Program 1/3 arc-second
  DEM](https://data.usgs.gov/datacatalog/data/USGS%3A3a81321b-c153-416f-98b7-cc8e5f0e17c3),
  using the best consistent resolution available across the complete pack
  (nominally 10 m / 1/3 arc-second when available).
- Record product identifiers, resolution, vertical datum, retrieval date, and
  hashes.
- Reproject/resample once in the compiler. Densify edge geometry, sample the DEM,
  suppress small vertical noise with one versioned algorithm, then persist
  direction-aware gain/loss, maximum elevation, and rolling-100 m grade.
- Never calculate route elevation by calling a remote elevation API at request
  time.

### Population (access-point remoteness)

- Primary source: [GHSL GHS-POP
  R2023A](https://data.jrc.ec.europa.eu/dataset/2ff68a52-5b5b-4a22-8f40-c41da8332cfe),
  3 arc-second (nominal 90 m) product in EPSG:4326. Use only the `4326_3ss`
  variant; the 100 m and 1 km products are Mollweide (ESRI:54009) and would need
  reprojection.
- Purpose: decide whether an access point sits in a populated area. GHS-POP
  disaggregates census counts using satellite-detected built-up area, which is a
  far better signal in the rural US than OSM `landuse=residential`, whose
  coverage is patchy exactly where it matters.
- Query the raster as a **sum over a radius**, not an interpolated point sample.
  Values are people-per-cell, and a trailhead at the edge of a subdivision sits
  in a near-zero cell while thousands live 300 m away.
- Tiles are 10 deg x 10 deg on a grid whose origin is offset from (-180, 90);
  `lib/data/population/tiles.ts` documents the verified constants. GHSL omits
  all-zero tiles, so an absent tile means zero people, not unknown. Every
  downloaded raster is checked against the predicted bounds at build time so a
  future region landing on a grid irregularity fails loudly instead of sampling
  the wrong part of the world.
- Persist only the raw measurement. Thresholds live in `lib/data/remoteness.ts`
  so they can be retuned without recompiling packs.
- Attribution: European Commission, Joint Research Centre. Reuse is authorised
  provided the source is acknowledged.

### Basemap

Use MapLibre with the [USGS Topo cached
MapServer](https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer)
from [The National Map services directory](https://apps.nationalmap.gov/services/)
as the default no-key context layer. Keep the selected tile URL and attribution
in one configuration module and verify its current service metadata during
implementation. The trail graph pack remains independent of the basemap and must
still function if tiles are temporarily unavailable.

## Storage lifecycle

```text
.cache/sources/<source>/<snapshot>/     ignored immutable downloads
.cache/build/<pack>/<run-id>/           ignored staging and audit artifacts
.local-data/packs/<pack>/<version>/     ignored validated runtime pack
data/fixtures/                          committed tiny deterministic inputs
```

- Download to a temporary filename, verify, then atomically rename.
- Never mutate a source snapshot in place.
- Build to a staging directory and publish only after all validation succeeds.
- Point an atomic `current` manifest/symlink at the new version; preserve the
  previous valid version for rollback.
- Database and manifest schema versions are separate from data versions.
- Runtime opens packs read-only and verifies manifest/database compatibility.
- Large files are not committed and Git LFS is unnecessary for the first slice.

## Licensing and attribution

[OSM data is under ODbL](https://www.openstreetmap.org/copyright/en-US). Display
OpenStreetMap attribution in the app and retain the license/source URL in every
pack manifest. Distribution of a derived OSM database may trigger ODbL
share-alike obligations; include the required database offer/license materials
before publishing any pack outside local development.

Preserve and display all required USGS and agency attribution. Store license
metadata per source instead of assuming all public-agency data has identical
terms. A pack build fails if a source lacks a recorded license/terms decision.

## Adding another region

Adding a region should require only:

1. a new versioned coverage polygon and manifest seed;
2. source/adapters needed for authoritative local access evidence;
3. the same topology, elevation, metric, validation, and publish pipeline;
4. curated scenario tests for that region.

It must not require changes to route algorithms, request schemas, UI labels, or
database tables. Optional regional capabilities appear only through manifest
flags with documented confidence/freshness semantics.
