# Southwest Cascades pack charter

## Identity and coverage

- Pack ID: `southwest-cascades`; display name: Southwest Cascades.
- Builder: schema 6, shared regional builder, data-version prefix `swc`.
- Hard coverage: `boundary.geojson`, version `southwest-cascades-boundary-v1`.
  Search areas select eligible starts and never clip routes. Unknown access
  remains default-included, while explicit restrictive tags remain restrictive.

This is a trail-network pack for generated closed hikes, not a list of known
itineraries. The boundary has a main southern Gifford Pinchot polygon and a
separate Silver Star–Tarbell lobe. It includes the Mount Saint Helens National
Volcanic Monument and its Boundary/Mount Margaret and Loowit feeder systems,
Mount Adams Wilderness and its west/north/south approaches, Indian Heaven and
Trapper Creek Wildernesses, and the Silver Star–Tarbell connected trails.
The [Forest Service Silver Star description](https://www.fs.usda.gov/r06/giffordpinchot/recreation/trails/trail-180-silver-star)
explicitly identifies the Tarbell connection and loop opportunities, so the
southern lobe is intentional. It does not imply that a pedestrian connector
exists between that lobe and the main polygon.

The build boundary is not a forest, county, wilderness, or download boundary.
Its concave main outline was reviewed against the named-area outlines and
trail/approach anchors in the **2026-08-01 Washington OSM extract**. A northern
extension includes the upper Cispus Blue Lake–Hamilton loops and the western
Klickitat Trail continuation. The small
Silver Star lobe keeps its connected trails without sweeping in the Columbia
Gorge or Vancouver foothills. The Yakama Reservation area in that same extract
was subtracted with an approximately 230–335 m coordinate buffer. That buffer
is a conservative pack-coverage margin, not an assertion of an exact legal
survey line. The exact bbox is:

```text
[-122.51, 45.68, -121.434711, 46.51]
```

### Boundary preflight, 2026-09-22

The review used the configured August 1 OSM PBF, `osmium tags-filter`/`export`,
and intersection checks on the resulting area and named trail geometries.
The OSM area relations are monument `relation/2455766`, Adams Wilderness
`relation/6109129`, Indian Heaven `relation/6109074`, Trapper Creek
`relation/6109053`, Yakama Reservation `relation/7320420`, and Goat Rocks
`relation/6109176`.

| Check | Geometry result |
| --- | --- |
| Monument, Indian Heaven, Trapper Creek | Their complete extracted area geometries fall inside the boundary. |
| Adams Wilderness | About 95% of the extracted area falls inside; the excluded eastern edge includes reservation overlap and the deliberate margin. |
| Yakama Reservation, Goat Rocks Wilderness | No area intersection with the Southwest boundary. |
| Named Loowit, Silver Star, Tarbell OSM ways | All extracted segments with those exact names fall inside. |
| Reviewed OSM anchors | Ape Canyon, June Lake, Norway Pass, Stagman Ridge, Killen Creek, Lemei, Big Hollow, and the in-boundary Rock Creek trailhead/parking features fall inside. |
| Upper Cispus seam | The Blue Lake–Hamilton pedestrian component has 17 OSM ways and cycle rank 3. Its named trail ways now fall wholly inside Southwest coverage. Klickitat Trail `way/492282425` is fully inside Southwest and overlaps the Rainier candidate over its eastern 46.7%. |

These are source-geometry checks, **not** a successful legal-access, derived
portal, or compiled-cycle audit. The preflight intentionally keeps the Loowit
circuit whole, including its south/east feeders. Before the northern extension,
23 named or referenced way segments in the upper Cispus study window had some
geometry outside both Southwest and Rainier candidates; after it, all 23 fall
inside their union. Two of those ways carry `access=no` and remain forbidden by
the access adapter despite lying inside coverage. The extension keeps zero area
intersection with the Goat Rocks Wilderness and Yakama Reservation OSM polygons;
its closest coordinate gaps are about 0.00743 and 0.00281 degrees,
respectively. The overlap with Rainier grows from 0.00148 to 0.01264 square
degrees. PCT `way/550208972` remains shared at the seam, with about 61% of its
geometry in Southwest and 49% in Rainier, including a deliberate overlap. No
pack crossing is modeled as a connector merely because boundaries overlap.
The full compiled boundary-crossing edge and route audits remain activation
gates.

## Access, exclusions, and authorities

The [USGS Mount Adams account](https://www.usgs.gov/volcanoes/mount-adams/science/geology-and-history-mount-adams)
states that the eastern half is in the Yakama Reservation and is closed to the
public outside designated recreation areas. The [Yakama Nation's own land
account](https://yakama.com/about/) establishes the reservation's independent
status and Mount Adams' importance. The v1 boundary excludes the OSM
reservation polygon and a conservative margin; it does **not** declare any
Yakama area publicly accessible. A future inclusion of a specifically
designated recreation area requires Yakama-authorized scope and access evidence,
then a new boundary/restriction review. An OSM path or unknown access tag does
not supply that authorization.

The [Forest Service Loowit guidance](https://www.fs.usda.gov/r06/giffordpinchot/recreation/loowit-trail-216)
describes an off-trail travel prohibition on one section. That is not a blanket
closure of Trail 216; no trail way is removed on this basis. Likewise, temporary
road, snow, fire, and landslide notices are not encoded in this static pack.
No durable exact-way restrictive override has passed review for v1, so there is
no `access-restrictions.json`. The pack adds no invented portal, trail connector,
or official trail supplement. Forest Service and Washington DNR trail material
is review evidence only. Any later official topology input must have a pinned
license and pass the shared attached-gap conflation rule.

Exclude Oregon, the Columbia River Gorge, the Goat Rocks core and Rainier-side
White Pass systems, urban/lowland trail islands, and Yakama Reservation land.
The Washington side of the Gorge remains a separate scope decision. The
southern lobe is limited to Silver Star–Tarbell, with its specific USFS and DNR
trail connections. Forest Service and Yakama Nation are the primary managing
authorities for the relevant coverage; their unit boundaries are not route
connectors or automatic permission to enter.

## Search regions and route checkpoints

Only the whole-pack selector is retained in `search-regions.json`. The monument,
Adams, Indian Heaven, and Trapper Creek named polygons exist in the pinned OSM
extract, but their utility as selectors depends on **derived** default-eligible,
cycle-bearing portals inside each area or the shared 500 m approach band. Silver
Star has no reviewed stable area polygon in the pinned inventory. These are
candidate selectors, not published selectors, until the compiled pack is
measured. A named area would filter starts only, never clip route geometry.

`scenarios.json` records nine review anchors: Ape Canyon and June Lake for
Loowit feeders, Norway Pass for Mount Margaret/Boundary Trail, Stagman Ridge
and Killen Creek for Adams, Cody Day Use for the upper Cispus/Klickitat seam,
Lemei for Indian Heaven, Big Hollow for Trapper Creek, and Rock Creek for Silver
Star–Tarbell. Ape Canyon, June Lake, and Cody are actual OSM parking areas
(`way/65069378`, `way/439071688`, `way/717051347`); the other anchors are
named OSM trailheads. They create no independent starts. Each plausible exact
and deliberately impossible gain request remains an **unverified checkpoint**
until it resolves to a derived portal within 500 m and passes the route runner.
At Cody, the parking polygon has a service-road node about 7 m away and a
`foot=designated` Klickitat Loop Trail node about 10 m away in the pinned OSM
snapshot. That trail belongs to a 23-way pedestrian component with cycle rank
2, making Cody an evidence-backed portal candidate, not a guaranteed compiled
portal or route. The previous Orr Creek Sno Park candidate had no pedestrian
path within 1 km and was removed from the scenarios.
The Blue Lake–Hamilton component itself has no confirmed derived portal yet;
its newly covered cycles must be checked during compiled portal QA.
The wider repeated-trail allowances in these backpacking-scale scenarios are
explicit per-request test inputs, not changes to product defaults.

## Pinned sources and licensing

### OpenStreetMap

Reuse Central Cascades' strict Geofabrik Washington extract configuration:
`washington-260801`, upstream `2026-08-01T20:21:21Z`, 359,826,867 bytes.
The verified immutable receipt acquired on 2026-09-22 records SHA-256
`3bea264079e184675aac7d8ab104bff5339b9e3656a36c084f96f616271a0e4e`.
OSM supplies hiking topology, access tags, portal and parking evidence,
buildings, and named areas. It is licensed under ODbL 1.0; preserve contributor
attribution and the required derived-database offer/license materials before
external distribution. No runtime OSM query is permitted.

### USGS 3DEP

The official National Map catalog was queried on 2026-09-22 with the exact
boundary bbox, dataset `National Elevation Dataset (NED) 1/3 arc-second`, and
`1 x 1 degree` product extent. Its 23 responses included historical revisions;
the latest publication date for each intersecting tile was selected:

| Tile | Publication date | Product ID |
| --- | --- | --- |
| `n46w122` | 2026-02-02 | `6981bb9ab66b0193caec85a4` |
| `n46w123` | 2026-04-06 | `69e6dcc0b66b01f903b6a342` |
| `n47w122` | 2025-08-13 | `689d4592d4be027ac1589946` |
| `n47w123` | 2025-08-13 | `689d4592d4be027ac1589944` |

The configured resolution is 1/3 arc-second (nominal 10 m), horizontal datum
NAD83, vertical datum NAVD88. USGS data is public domain. Catalog sizes are
advisory; actual download bytes and hashes belong in immutable refresh receipts.
Use `southwest-cascades-elevation` as the collection namespace while sharing
identical raw tiles through the content-addressed cache. No tile has been
downloaded as part of this boundary/config commit.

## Activation blockers

Before adding `packId` to the registry, inspect all compiled boundary-crossing
hiking ways and upper Cispus/Goat Rocks seam components, including Blue
Lake–Hamilton portal reachability; review Yakama edge proximity;
perform one deliberate source refresh; produce two byte-identical offline
schema-6 builds; pass portal/building/cycle, elevation, provenance, access, and
route audits; verify every scenario's exact and labeled close outcome; then
run application and browser checks. Trailhead names and OSM evidence do not
guarantee that a portal or a viable circuit exists. Generated artifacts,
downloads, receipts, and caches remain outside Git.
