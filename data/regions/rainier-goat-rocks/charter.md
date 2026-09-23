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

Version 1 publishes only `pack:rainier-goat-rocks`. The four source area
relations are stable candidate selectors, but their derived portal counts,
500 m named-region approach-band distributions, building counts, and cycle
reachability have not yet been measured. Do not publish them as reviewed
selectors until that graph evidence exists. A narrower Naches/White Pass
selector likewise needs a stable named polygon and useful eligible portals.

`scenarios.json` records nine OSM trailhead anchors: Longmire/Paradise,
Mowich/Carbon, Sunrise/White River, Ohanapecosh, Chinook/Naches,
Greenwater/Norse Peak, White Pass, Snowgrass, and Walupt Lake. These are
checkpoint targets, not created access points or claims of passing routes.
Before activation every anchor must resolve to a derived portal within 500 m
and each cluster must pass its plausible exact request and impossible-gain
close-match request. An east-side Goat Rocks anchor remains deferred: the
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
  Product bytes and SHA-256 are not yet acquired; the one deliberate refresh
  must record and verify them before offline builds.
- NPS/USFS maps and trail pages inform scope and seam review only. No official
  trail supplement or entrance source is configured. Any future supplement
  needs exact license and source pin review and must pass the generic connected
  gap conflation rule. It cannot add portals or legal permission.
- No exact-way authority restriction is asserted in v1. NPS overnight
  wilderness permits, weather, fires, snow, and changing road/trail notices
  are trip-planning context, not a static OSM way closure. A durable
  restriction later requires a dated authority review and exact way IDs.

## Activation blockers

The boundary and source definitions are pinned, but this pack is **not
activated**. Refresh source caches once; perform two fresh offline builds and
compare data version and every output byte hash. Require zero audit, integrity,
provenance, out-of-coverage, and missing-elevation errors. Review PCT/upper
Cispus seam edges with Southwest, all boundary-crossing trails, component
islands, public/unknown/restricted portal counts, built-up starts, and both
cycle profiles. Then run every scenario, Quick and Full spot checks, the app
and browser suites twice, and only then link `packId` in the catalog. Generated
packs, raw downloads, caches, and databases remain ignored.
