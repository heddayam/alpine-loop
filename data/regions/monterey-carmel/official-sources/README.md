# Monterey–Carmel official access evidence

Reviewed on 2026-08-07. Runtime and automated tests never call these services.
Refresh downloads are immutable, hashed, and fail closed on an empty response,
schema or feature-count drift, transfer truncation, undocumented values, or a
license decision other than the one pinned here.

## Build inputs

`reviewed-access.json` is a small committed overlay because MPRPD and California
State Parks do not publish a reusable entrance/closure feed covering these
systems. BLM's machine-readable national Trail Head layer supplies the exact
Fort Ord entrance geometry. The overlay records eight exact official page/map
or query responses (URL,
upstream/review date, SHA-256, byte length, license decision, and reviewed
facts), ten named entrance points, and the current Garrapata Rocky Ridge Trail
closure. Coordinates were manually cross-checked against the named map feature;
they are conservative snap candidates and do not create connector edges.

The normalized ID convention is deliberate:

- `entrance/<stable-id>` is a named entrance candidate. It is public evidence
  with medium confidence; permit, parking, signed-trail, and designated-trail
  conditions remain explicit in the committed record and display name.
- `way/<id>` is high-confidence current closure evidence for an exact OSM way.
  The reviewed Rocky Ridge closure targets `way/55856070` and `way/55856129`.
  The pack build must verify both targets exist in the pinned Geofabrik snapshot
  before applying the closure and must fail if either is absent.

Creekside Terrace and Badger Hills use the exact EPSG:4326 geometry from BLM's
filtered two-feature Trail Head query. The query's `LAT`/`LONG` attributes agree
with its geometry within two metres; the layer credits BLM's Network Operations
Center and is a U.S. Government work.

No separate `current-closures.json` is needed: the strict reviewed snapshot
distinguishes entrance records from exact trail-closure targets and the adapter
emits closures at the higher official-restriction precedence.

`usfs-national-forest-system-trails.json` pins the official USDA Forest Service
EDW layer and a northern Monterey review envelope. The exact query returned 15
features with unique `globalid` values. The response exposes `allowed_terra_use`
values `21` or `321`, null `hiker_pedestrian_managed`,
`hiker_pedestrian_accpt`, `hiker_pedestrian_disc`, and
`hiker_pedestrian_restricted`, plus `hiker_pedestrian_accpt_disc` equal to
`01/01-12/31`. Those codes do not document affirmative pedestrian permission or
a current closure by themselves. Adapter v1 therefore maps every accepted
record to **unknown** access, maps no value to public/prohibited/closed, and
fails on any other value. The lines are cross-check/join candidates only; exact
pack coverage still discards deep Big Sur and Ventana geometry.

`MONTEREY_OFFICIAL_SOURCE_SET` contains only the USFS config. The reviewed
overlay is read from its exact committed path by
`montereyReviewedAccessSnapshot()` and is not refreshed from the network.

## Excluded cross-check

`california-state-parks-recreational-routes.blocked.json` documents the
statewide ArcGIS layer and an exact Point Lobos/Garrapata query. The inspected
query returned zero features; the layer has no pedestrian access or closure
field. Its terms prohibit alteration, require attribution, and require advance
approval for commercial use. It is therefore excluded from
`MONTEREY_OFFICIAL_SOURCE_SET` and never ingested. The reviewed State Parks
pages/map are used instead, with derivative-pack redistribution still marked
for review.

The State Parks host's certificate chain could not be validated by the local
review environment. Exact page bytes were retrieved only for hashing after the
same canonical pages were independently verified through the web retrieval
service. Refresh automation must not disable TLS verification; it should fail
closed until the host presents a verifiable chain.
