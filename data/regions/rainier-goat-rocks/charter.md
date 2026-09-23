# Rainier–Goat Rocks pack charter

Review date: **2026-09-22**. Pack ID: `rainier-goat-rocks`. This is a
schema-6 route-generator pack, not a catalog of known hikes. The versioned
`rainier-goat-rocks-boundary-v1` polygon is the hard route-geometry boundary;
all search areas select starting portals only. Unknown access stays included
by default. Exact and labeled close matches stay separate.

## Coverage and seams

The intended unit contains Mount Rainier National Park's hiking network and
public approaches, including the complete Wonderland circuit; Norse Peak and
William O. Douglas Wilderness around Chinook/Naches and White Pass; and Goat
Rocks Wilderness with the Snowgrass, Walupt, and public east-side approaches.
The National Park Service describes Wonderland as a complete 93-mile loop and
lists Longmire, Mowich, Sunrise, White River, and other connecting trailheads
([NPS Wonderland](https://www.nps.gov/mora/planyourvisit/the-wonderland-trail.htm)).
The PCT through the two wilderness seams is hiking coverage, not an implied
road, shuttle, or transit connector.

`boundary.geojson` is a reviewed approach envelope around four named areas in
the pinned Washington OSM extract, plus the actual OSM PCT corridor north of
Norse Peak. Source relations and extract versions are:

| OSM named area | Relation | Version in 2026-08-01 extract |
| --- | --- | ---: |
| Mount Rainier National Park | `relation/1399219` | 31 |
| Norse Peak Wilderness | `relation/6109986` | 8 |
| William O. Douglas Wilderness | `relation/6109916` | 11 |
| Goat Rocks Wilderness | `relation/6109176` | 16 |

Construction is reproducible from the pinned OSM polygons and 16 PCT ways
`86478929`, `87120132`, `436166779`, `436166780`, `508572441`, `508572442`,
`914241891`–`914241894`, `1234175515`, `1234175516`, `1354456495`,
`1415930954`, `1415930955`, and `1545803896`. Coordinates were scaled at
76,000 m/degree longitude and 111,000 m/degree latitude for this local
geometry operation. Each source polygon/line was simplified by 100 m with
topology preserved and buffered 8 km. Their union was simplified by 250 m,
transformed back, and rounded to seven decimal places. The resulting valid,
closed, single polygon has 114 coordinates, about 5,507 km², and exact bbox:

```text
[-122.0849597, 46.3163758, -120.9891357, 47.456977]
```

The reviewed Aug 1 extract has 76 ways named `Wonderland Trail`; all are
inside this polygon. The first park/wilderness envelope left an **18.8 km
coverage gap** to Central Cascades across the continuous PCT around Stampede
Pass. The added OSM-based corridor now covers all 16 reviewed PCT ways from
Norse Peak into Central's exact polygon, with deliberate overlap. This is an
approach and seam envelope, not an administrative boundary. South of Goat
Rocks, the current edge intersects the PCT near `[-121.51, 46.32]` and High
Lakes Trail #116 near `[-121.55, 46.34]`. The Southwest candidate's upper
Cispus extension overlaps this PCT seam and contains the western continuation
of Klickitat Trail #7; Rainier contains its eastern continuation. Keep that
overlap when Southwest is frozen. Do not trim either pack at a nominal forest
line without graph review.

A whole-bbox OSM preflight counted 1,883 contained pedestrian ways and 41
boundary-crossing pedestrian ways. At the north edge, some crossings are
already inside Central's overlap (including the PCT, Gold Creek, and
Snoqualmie approaches). At the south edge, the PCT, High Lakes, Spring Creek,
Hamilton Peak, and Klickitat ways need the Southwest cross-pack audit. Other
crossings remain activation review items; this count is not a claim that
every one participates in a viable cycle.

Exclude Mount St. Helens, Mount Adams, and the southern Gifford Pinchot core
for Southwest; exclude the Alpine Lakes/Teanaway core for Central; exclude
isolated Tacoma/Yakima lowland trails. The buffer may contain disconnected
trail islands. The pack builder's portal and cycle audit, not this polygon
alone, decides which access points are eligible.

## Search regions and route checkpoints

Version 1 publishes `pack:rainier-goat-rocks` plus the source-relation
selectors for William O. Douglas (`relation/6109916`) and Goat Rocks
(`relation/6109176`). With unknown access included, the compiled graph has
303 whole-pack eligible portals, 25 in William O. Douglas's 500 m approach
band, and 13 in Goat Rocks's band. For all 38 of those narrower-selector
portals, a compiled trail path reaches the corresponding source polygon
within 10 km; examples include Pear Butte via OSM way `6201800`, Swamp Lake
via `455187111`, Snowgrass via `147614862`, and Walupt Lake via `968247257`.
The approach band permits starts just outside a wilderness line; it does not
clip routes to that line. Mount Rainier National Park and Norse Peak remain
candidate selectors: the same graph check found 52/53 and 9/11 eligible
portals with trail paths into their polygons, respectively, leaving three
fringe portals disconnected from those polygons. A narrower Naches/White
Pass selector still needs a stable named polygon and useful eligible portals.

`scenarios.json` records ten OSM trailhead anchors: Longmire/Paradise,
Mowich/Carbon, Sunrise/White River, Ohanapecosh, Chinook/Naches,
Greenwater/Norse Peak, White Pass, Pear Butte in William O. Douglas,
Snowgrass, and Walupt Lake. These are checkpoint targets, not created access
points. At Ohanapecosh, the nearest
eligible named public portal to the Silver Falls reference is Hot Springs
Nature Trailhead, 184 m away. Its compiled minimum stem to a cycle is
13.68 km; Laughingwater Creek, Cowlitz Divide, and Eastside Trail trailheads
also have stems over 11 km. A 3–18 mi closed-loop request found no route,
while a source-faithful 18–40 mi request found four exact routes and an
impossible-gain request returned a labeled close match in the final Thorough
checkpoint. The nearby unnamed southern portal has a shorter stem but is not
a sound replacement for the named Ohanapecosh anchor. All ten anchors resolve
to derived portals within 500 m and pass plausible exact and impossible-gain
close-match requests. An east-side Goat Rocks anchor remains deferred: the
reviewed OSM trailhead inventory did not identify a stable named east-side
portal in the boundary. Inspect compiled portals and agency maps before adding
one; do not invent a point.

## Sources, rights, and restrictions

- OSM topology, named areas, portal evidence, access tags, and buildings use
  Geofabrik Washington `washington-260801`, upstream
  `2026-08-01T20:21:21Z`, 359,826,867 bytes. The ignored local receipt
  reviewed on 2026-09-22 records SHA-256
  `3bea264079e184675aac7d8ab104bff5339b9e3656a36c084f96f616271a0e4e`
  and retrieval `2026-09-22T21:34:18.582Z`. Source configuration matches
  Central Cascades. OSM is ODbL 1.0: preserve contributor/Geofabrik
  attribution and review derived-database distribution obligations before
  external release ([Geofabrik Washington](https://download.geofabrik.de/north-america/us/washington.html),
  [OSM copyright](https://www.openstreetmap.org/copyright)).
- Elevation is USGS 3DEP 1/3 arc-second, nominal 10 m, NAD83/NAVD88 and U.S.
  public domain ([USGS 3DEP](https://www.usgs.gov/3d-elevation-program/about-3dep-products-services)).
  The official National Map 1 × 1 degree catalog was queried on 2026-09-22
  with the **exact final bbox** above. It returned 36 historical/current
  records across six bbox-intersecting tile cells. The polygon itself intersects
  five of them; `n48w121` is a bbox-only false positive. The latest tile
  edition by title was selected for each polygon-intersecting cell, rather
  than the latest catalog update time (which can change on a historical
  product):

  | Tile | Edition | Product ID |
  | --- | --- | --- |
  | `n47w121` | 2025-08-13 | `689d4592d4be027ac1589948` |
  | `n47w122` | 2025-08-13 | `689d4592d4be027ac1589946` |
  | `n47w123` | 2025-08-13 | `689d4592d4be027ac1589944` |
  | `n48w122` | 2025-08-13 | `689d4591d4be027ac158993e` |
  | `n48w123` | 2024-03-27 | `6604fa8bd34e64ff154955e1` |

  The region-unique collection namespace is `rainier-goat-rocks-elevation`.
  The 2026-09-23 exact-polygon source refresh pinned the USGS catalog snapshot
  to SHA-256 `a23c018f28d3d44782279b3aee0e4c75e27d1b8f9a37c243fa4330a3c010caed`.
  Its verified product receipts are:

  | Product ID | Bytes | SHA-256 |
  | --- | ---: | --- |
  | `6604fa8bd34e64ff154955e1` | 415,454,931 | `aecc6ef7492509dfd11586ad7961b20d086475df5b91a9cc252217af021d2b16` |
  | `689d4591d4be027ac158993e` | 473,964,013 | `40bccd5f1252cec0e5fd6f2a15e5a62590e42d43455a61cf1b48bc55784b5c85` |
  | `689d4592d4be027ac1589944` | 484,854,229 | `ab4fb0a2afa65c49c41cb0c59c5ea102329b6e1e47425159b884d05f540c4bb5` |
  | `689d4592d4be027ac1589946` | 455,225,246 | `a77505b9187d185eaebdb0abe71e7e3171ca00ad74363ce728de14b67d357bca` |
  | `689d4592d4be027ac1589948` | 430,526,125 | `617fda4ef940046a86c2cb56310fc88b8d8872942981ac6028aafd1e47dcd3f3` |
- NPS/USFS maps and trail pages inform scope and seam review only. No official
  trail supplement or entrance source is configured. Any future supplement
  needs exact license and source pin review and must pass the generic connected
  gap conflation rule. It cannot add portals or legal permission.
- No exact-way authority restriction is asserted in v1. NPS overnight
  wilderness permits, weather, fires, snow, and changing road/trail notices
  are trip-planning context, not a static OSM way closure. A durable
  restriction later requires a dated authority review and exact way IDs.

## Build and QA evidence

The explicit 2026-09-23 source refresh and two independent fresh offline
builds produced schema 6 data version `rgr-9037762d7a78ff57`. The offline
builds used separate preparation and output directories and gave identical
SHA-256 for every published output:

| Output | SHA-256 |
| --- | --- |
| `manifest.json` | `08df9d98e4227e32917ccbca07bece618911d45b9efe85f40f1fec96231ece1a` |
| `pack.sqlite` | `d5a42250352da588a2450706740ac5da704049675275c00f171dbd7faca61f85` |
| `audit.json` | `a6e22dce52c2c5d94966fb612e4a663fc490ec1d58d68d659b8ba1d6bed4f227` |
| `portal-audit.json` | `777e20ab43d66102f823c7651d675b2bd2c2013d81e25da164dae6dc6f7fd88a` |
| `regional-audit.json` | `f7defb95a57bede7f2383ce79486ae83ea060b9e4f016af716536b1ce3a46792` |

The compiled pack has 182,673 nodes, 364,899 directed edges, 853
in-boundary portals, 14 named areas, three search regions, and 2 pinned
sources. The portal audit counted 874 input candidates: 129 public, 737
unknown, five private, and three prohibited. Of these, 21 fall outside
coverage. The 853 published portals are 127 public, 719 unknown, five
private, and two prohibited; 28 starts have nearby building context, 196 have
parking evidence, and 303 are eligible under the default inclusive policy.
Known-only topology has 69 feasible starts; inclusive topology has 317.
There are 749 connected components, with 95,587 nodes in the largest.
The source-boundary review rejected 321 OSM ways/20,176 source edges and
found zero published edges outside exact coverage. The final reports have
zero conflicts, missing-elevation records, implausible metrics, provenance
failures, or errors. SQLite integrity and foreign-key checks pass. The two
audit warnings describe disconnected components and rejected source edges,
not failed pack invariants.

The Thorough checkpoint finds at least one exact route and a clearly labeled
close match for the impossible-gain request at each recorded cluster, with
zero directed-route validation rejections. Quick spot checks pass at
Ohanapecosh, Pear Butte, and Snowgrass. The William O. Douglas and Goat Rocks
scenarios use their published named selectors, including a Pear Butte portal
exactly at the OSM reference coordinate. Scenario inputs are checkpoint fixtures;
they are not part of the compiled data fingerprint.

## Activation blockers

This pack is **not activated**. The integrator still owns shared catalog
linkage, app and browser verification, and final cross-pack review. The
PCT/upper Cispus overlap has been measured against the Southwest correction;
retain it at integration. Disconnected trail islands and boundary-crossing
ways remain visible in the audits rather than silently promoted to viable
routes. Generated packs, raw downloads, caches, and databases remain ignored.
