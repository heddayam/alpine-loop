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
and Killen Creek for Adams, Blue Lake ORV Trailhead for the upper Cispus
network, Lemei for Indian Heaven, Big Hollow for Trapper Creek, and Rock Creek
for Silver Star–Tarbell. Ape Canyon, June Lake, and Blue Lake are actual OSM
parking areas (`way/65069378`, `way/439071688`, `way/716832243`); the other
anchors are named OSM trailheads. They create no independent starts. The
Blue Lake parking area is 110 m from the compiled public/medium Valley Trail
`#270` portal `osm-node-5689711673`, which can reach a cycle. The
[Forest Service Cat Creek map](https://www.fs.usda.gov/Internet/FSE_DOCUMENTS/fseprd1046758.pdf)
lists hiking as an allowable use on Valley Trail `#270`, despite the trailhead's
ORV name. The exact route runner passes both the plausible and intentionally
impossible requests from this portal.

Cody Day Use parking `way/717051347` remains a real access candidate, but its
nearby derived portal `osm-node-4104968385` cannot reach a compiled cycle.
The nearest eligible cycle portal is 1,549 m away, so Cody is excluded from
route checkpoints. This is a measured no-cycle outcome, not a source closure
claim. The previous Orr Creek Sno Park candidate had no pedestrian path within
1 km and was also removed. The wider repeated-trail allowances in these
backpacking-scale scenarios are explicit per-request test inputs, not changes
to product defaults.

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

| Tile | Publication date | Product ID | Download bytes | SHA-256 |
| --- | --- | --- | ---: | --- |
| `n46w122` | 2026-02-02 | `6981bb9ab66b0193caec85a4` | 448,644,793 | `a05756ba7ee345873528a9229d3df235239f6de245573425c72e5b6d127b9448` |
| `n46w123` | 2026-04-06 | `69e6dcc0b66b01f903b6a342` | 489,178,893 | `7d759eb0fb49907748ab5305430bfd6d04a58902db5f869cc1d7a2fe5b707e9e` |
| `n47w122` | 2025-08-13 | `689d4592d4be027ac1589946` | 455,225,246 | `a77505b9187d185eaebdb0abe71e7e3171ca00ad74363ce728de14b67d357bca` |
| `n47w123` | 2025-08-13 | `689d4592d4be027ac1589944` | 484,854,229 | `ab4fb0a2afa65c49c41cb0c59c5ea102329b6e1e47425159b884d05f540c4bb5` |

The configured resolution is 1/3 arc-second (nominal 10 m), horizontal datum
NAD83, vertical datum NAVD88. USGS data is public domain. Catalog sizes are
advisory; actual download bytes and hashes belong in immutable refresh receipts.
Use `southwest-cascades-elevation` as the collection namespace while sharing
identical raw tiles through the content-addressed cache. The deliberate source
refresh on 2026-09-22 local time recorded all four receipts at
`2026-09-23T04:35:25.464Z`; subsequent independent builds were offline.

## Compiled validation, 2026-09-22

One explicit source refresh and two independent offline preparations/builds
produced the same schema-6 version, `swc-f877817cbcde78fe`. All three
published sets are byte-identical:

| File | SHA-256 |
| --- | --- |
| `manifest.json` | `cfb2469729f711837164b125c06073fffb80f6b42e355d28f14712db6a9a0e34` |
| `pack.sqlite` | `e4fb757ab9c28bd7240ce4787f96b0aaa89f006c0a7df1b178ee0b34de895fa0` |
| `audit.json` | `2a5ffc4ec46af5bba76a4ec27a13ade9efe74d7bd6e84a92c828891f72ab0b5f` |
| `regional-audit.json` | `f7ff737571145e866821c51e5e58fb0c5ef798813e17c17a3b19f5e3cbc91290` |
| `portal-audit.json` | `d1ccc1548b7d51e8399ba9edb4e0a10787b3373f53e1a8c284223285409e4084` |

The compiled pack has 176,693 nodes, 352,490 directed trail edges, 839
in-coverage access points, and 7,168 source building centroids. There are
zero audit errors, source conflicts, isolated nodes, missing trail elevations,
outside-coverage edges, unattributed records, unknown source references, or
published context edges. SQLite integrity and foreign keys pass. The two
topology profiles are `known` and `inclusive`; the runtime uses the
`reachable-graph-fallback` mode, so compact decision-network tables are empty
by design. There are 26 known and 325 inclusive cycle-feasible portals; 324
inclusive portals pass the default building/access filter. Five portals exceed
the 50-building threshold, all at the Silver Star/Vancouver fringe; Rock
Creek's reviewed portal has 25 nearby buildings and remains eligible. The
portal derivation report found 122 parking-evidenced candidates.

The graph has 729 disconnected components and its largest component contains
34.6% of nodes. These reflect the large multi-cluster boundary and trail
islands, rather than a failed integrity gate. The build rejected 17,729 source
edges at coverage/restriction processing. In particular, western Boundary
Trail OSM ways `170400003` and `314513843` retain `access=no` as 88
prohibited directed edges; Klickitat Connector `way/1079336009`, whose
`foot=yes` overrides its generic `access=no`, remains public. The border
and reservation exclusions still require periodic source review; neither an
overlapping pack boundary nor a nearby OSM trail creates an authorized crossing.

The initial Thorough checkpoint passed eight of nine scenarios; Cody failed
the 500 m eligible-portal rule. After replacing that anchor with source-named
Blue Lake parking, all nine final Thorough and Quick checkpoints pass. For each
scenario, the impossible gain request yields zero exact routes and at least
one explicitly violated close match. All 36 runs have zero directed-validation
rejections.

| Scenario | Selected portal distance | Thorough exact | Thorough impossible close | Quick exact |
| --- | ---: | ---: | ---: | ---: |
| Ape Canyon–Loowit | 120 m | 3 | 1 | 1 |
| June Lake–Loowit | 9 m | 10 | 2 | 1 |
| Mount Margaret–Boundary | 26 m | 4 | 1 | 4 |
| Adams–Stagman | 16 m | 8 | 1 | 4 |
| Adams–Killen | 0 m | 5 | 2 | 2 |
| Upper Cispus–Blue Lake | 110 m | 10 | 1 | 10 |
| Indian Heaven–Lemei | 0 m | 2 | 1 | 2 |
| Trapper Creek–Big Hollow | 0 m | 6 | 2 | 6 |
| Silver Star–Tarbell | 187 m | 10 | 2 | 10 |

## Activation blockers

Before adding `packId` to the registry, review route geometry in the
application and run the integrator's cross-pack seam and browser checks. Trailhead names
and OSM evidence do not guarantee a compiled portal or viable circuit, as Cody
demonstrates. Generated artifacts, downloads, receipts, and caches remain
outside Git.
