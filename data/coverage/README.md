# Coverage geometry evidence

These committed GeoJSON features describe provider extents and a reviewed scope
exclusion. They are not trail topology, land ownership grants, or completeness
claims. Source URLs, timestamps, SHA-256 values, and attribution are stored in
each feature's properties.

- `washington-source.geojson` and `norcal-source.geojson` preserve all coordinates
  from the official Geofabrik `.poly` files downloaded on 2026-09-24. `.poly`
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

Desired collection envelopes remain independent from provider extents. Planning
splits requests into supported and unavailable geometry before producing work
units. Reviewed exclusions also apply to drawn requests. Unavailable geometry
is retained in the plan with a reason, and cannot become installed coverage.
