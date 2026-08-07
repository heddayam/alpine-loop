# Monterey–Carmel reviewed access evidence

Reviewed on 2026-08-07. Runtime and automated tests never call the documented
services. The pack has no live official-access refresh dependency.

## Published build inputs

`../access-restrictions.json` is the sole algorithmic official-access input. It
contains exactly two reviewed removals, `way/55856070` and `way/55856129`, for
the California State Parks Rocky Ridge Trail hazard closure. The pack build
applies them by exact OSM way ID before deriving portals and fails if either way
is absent from the pinned extract.

`reviewed-access.json` remains committed as a provenance-rich name overlay. Its
ten entrance records may rename a nearby topology-derived portal, but never
create an access point or connector edge. The closure record retained in that
historical review is provenance only; it is not applied by the pack. Both
committed files are hashed pack sources.

Creekside Terrace and Badger Hills use exact EPSG:4326 geometry from BLM's
filtered two-feature Trail Head query. The query's `LAT`/`LONG` attributes agree
with its geometry within two metres. Other entrance coordinates were manually
cross-checked against the named official map feature.

The former USFS National Forest System Trails input was removed. Its 15 matched
features had no affirmative pedestrian permission or prohibition and measured
zero algorithmic route-set delta, so refreshing and line-matching it added no
pack behavior.

## Excluded cross-check

`california-state-parks-recreational-routes.blocked.json` documents the
statewide ArcGIS layer and an exact Point Lobos/Garrapata query. The inspected
query returned zero features; the layer has no pedestrian access or closure
field. Its terms prohibit alteration, require attribution, and require advance
approval for commercial use. It is therefore documentation only and is never
ingested.

The State Parks host's certificate chain could not be validated by the local
review environment. Exact page bytes were retrieved only for hashing after the
same canonical pages were independently verified through the web retrieval
service. Refresh automation must not disable TLS verification.
