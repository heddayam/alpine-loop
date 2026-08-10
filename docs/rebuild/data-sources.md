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

OSM remains the baseline, but a region may opt into a pinned, licensed official
trail supplement through the versioned conflation pipeline. The supplement must
be terrestrial and explicitly hiking-enabled, must remove geometry already
represented within the reviewed tolerance, and may publish only components that
attach to the baseline graph. Exact and near junctions may meet at any angle;
larger displacement is accepted only when trail bearings align. Ambiguous ends
remain visibly truncated instead of receiving an invented connector. Added
edges keep `unknown` access, exact source/feature provenance, and a build audit;
an official trail line never grants legal access or creates an authority
restriction. Disconnected islands, short noise, duplicate official records, and
unlicensed inputs fail or remain rejected evidence.

### Access portals and reviewed restrictions

Derive route starts from the same pinned OSM extract as the hiking graph. During
preparation, classify hiking ways plus only the road classes needed to detect
where a drivable network touches a trail. Cluster those contacts into portals,
rank them by reachable trail network and nearby trailhead/parking evidence, then
discard every road, sidewalk, and evidence-only row before publishing the pack.
The runtime graph remains trail-only.

OSM access tags remain the baseline. Preserve `public` and `unknown` separately
for provenance, ranking, and review; both are traversable by default, while
`private`, `closed`, and `prohibited` are never traversable. Conflicting evidence
must never be resolved toward permissive access.

Keep safety-critical authority removals in a small, committed per-region file
keyed by exact OSM way ID. Every entry must be restrictive, reviewed, attributed,
and covered by a pinned content hash; a missing, duplicate, or conflicting target
fails the build. Do not call a live authority restriction service or spatially
infer a restriction during a pack build.

Official entrance points are optional cosmetic evidence. A validated, pinned
entrance snapshot may rename or raise confidence on a nearby derived portal, but
it cannot create a portal, change its access state, or add a connector edge. A
region without such a source gets generic portal names, not missing routes.

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

### Buildings (is this start in a neighbourhood)

- Source: the **same pinned OSM extract** as the trail topology. `wa/building`
  is filtered out of the prepared region, exported, and reduced to centroids by
  `lib/data/osm/buildings.ts`. No second dataset, no raster, no Python.
- Purpose: the product only ever wants wilderness starts, so this is one
  measurement and one rule, not a taxonomy the user picks from. An access point
  is rejected when **50 or more buildings** sit within **500 m** of its snapped
  node (`lib/data/wilderness.ts`).
- Only centroids are retained, rounded to five decimal places (about a metre,
  against a 500 m counting radius). The filtered `.pbf` and the export are
  deleted before the staging directory is committed: it is renamed into place,
  so anything left behind is kept forever. Santa Cruz retains 3.9 MB for
  189,826 buildings.
- This **replaces GHS-POP**, which was previously used for the same decision.
  The reasoning for the swap, and why the earlier argument against OSM
  built-up signals did not survive measurement:
  - The old concern was that OSM built-up coverage is patchy in the rural US.
    That is true of `landuse=residential`; it is not true of building
    footprints, which have national import coverage. 1,444 of 1,549 Santa Cruz
    portals have at least one building within 500 m.
  - A population figure summed over kilometres describes the wrong thing. Fall
    Creek Fire Road and the Henry Cowell nature centre sat in near-identical
    population fields (380 and 368 people/km², both "populated") because Felton
    is inside the radius. Buildings separate them 9 against 28, and both are
    correctly kept.
  - Every start GHS-POP flagged as urban is also flagged by the building rule,
    so nothing is lost at the top end.
- Deleting the raster path removed the pinned GHSL download, the tile-grid
  arithmetic, the uv/rasterio sampler, and `tools/dem/sample_population.py`, and
  cut about 35 MB per region from the source cache.
- No fallback: a region whose extract yields no buildings fails the build rather
  than silently treating every start as wild.

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
- Point an atomic `current` manifest/symlink at the new version, then prune older
  validated builds for that pack. Failed builds leave the current build intact.
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

The authoritative region order, boundary intent, selector behavior, and
onboarding/activation gates are defined in the [regional expansion
roadmap](regional-expansion-plan.md). At the data layer, adding a region should
require only:

1. a new versioned coverage polygon and manifest seed;
2. a pinned OSM extract plus any reviewed exact-way removals, optional
   entrance-name overlay, and optional pinned official-trail supplement;
3. the same topology, elevation, metric, validation, and publish pipeline;
4. curated scenario tests for that region.

It must not require changes to route algorithms, request schemas, UI labels, or
database tables. Optional regional capabilities appear only through manifest
flags with documented confidence/freshness semantics.
