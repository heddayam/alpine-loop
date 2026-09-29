# Coverage geometry evidence

These committed GeoJSON features describe provider extents and a reviewed scope
exclusion. They are not trail topology, land ownership grants, or completeness
claims. Source URLs, timestamps, SHA-256 values, and attribution are stored in
each feature's properties.

- `washington-source.geojson`, `norcal-source.geojson` and `oregon-source.geojson`
  record reviewed provider extents. Norcal and Oregon preserve the official
  Geofabrik `.poly` coordinates; Washington replaces the mainland north edge with
  the pinned IBC line documented in `washington-ibc-border.md`. The Geofabrik
  polygons were downloaded on 2026-09-24 (Washington/Norcal) and 2026-09-29 UTC
  (Oregon). `.poly`
  outer rings become GeoJSON polygon shells; `!` rings become holes. No smoothing
  or bounding-box substitution is applied. The provider publishes current
  polygons rather than a polygon version accompanying each historical PBF;
  this limitation is recorded explicitly. OSM complete-way extraction can
  include incidental geometry outside these extents; those stubs do not expand
  advertised source coverage.
- `yakama-exclusion.geojson` preserves relation/7320420 from the pinned
  `washington-260801` PBF (SHA-256 recorded in the feature), extracted using
  `osmium getid --add-referenced` and polygon export. Its coordinates are not
  simplified. This carries forward the explicit exclusion reviewed in
  `data/regions/southwest-cascades/charter.md`; the OSM polygon is geographic
  evidence, not a surveyed legal boundary. Inclusion of designated recreation
  areas requires separate authority-backed review.

`regions/catalog.json` is the sole developer catalog of named start areas.
Boundary and approach provenance are explicit per entry; neither an agency nor
Washington geography is hardcoded in the loader. Each build verifies the entire
25-mile routing buffer against its recipe's provider extents after applying the
explicit international support limit and exclusions. Source gaps fail before
processing. Named areas select starts; they do not clip hiking routes.

Washington and California recipes share the compiler and preserve their reviewed
restrictions. `regions/washington-restoration.md` and
`regions/california-restoration.md` describe reused inputs, checkpoints and gaps.
The retained `data/regions/*` source configurations and geometries are preparation
inputs, not a second runtime catalog. Old registry and pack-size files are removed.

Use `data regions`, `data plan REGION [REGION...]`, and
`data build REGION [REGION...]`. Builds run sequentially and publish independently.
Configured definitions are not proof of built, installed, or complete coverage;
those acceptance states are recorded in `docs/rebuild/status.md`.

Oregon uses the same `2026-08-01T20:21:21Z` OSM snapshot timestamp as Washington.
Its 252,076,488-byte PBF was streamed once into the ignored shared source cache,
verified against the provider MD5 and pinned by SHA-256
`777d9898e1cf0a80b73b2c503028fe0c15120f6547ae692cc48d6fae26b0847e`.
The configuration in `sources/oregon.json` and the geometry are committed; raw
source bytes and receipts remain outside Git. Southwest's Oregon support does
not add an Oregon start-area selection.
