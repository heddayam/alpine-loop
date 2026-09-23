# North Cascades pack charter

External geography and source review: **2026-09-22**. The boundary is a
versioned build input, not an activation or a claim that route preflight has
passed.

## Identity and scope

- Pack ID: `north-cascades`; display name: North Cascades.
- Coverage input: `boundary.geojson`, version `north-cascades-boundary-v1`.
  It is the **exact hard route-geometry boundary**. A named, drawn, or
  drive-time area selects starting portals and does not clip a route.
- Intended users: hikers seeking locally generated closed routes across the
  northern Washington Cascades. This is not a catalog of known hikes.
  Unknown access is included by default, and exact matches remain separate
  from labeled close matches.

The v1 polygon keeps Mount Baker and Baker Lake/Baker River approaches,
Artist Point/Hannegan and the northern NPS approaches, the Highway 20/Skagit
and Cascade River corridors, all three units of the North Cascades National
Park Service Complex, Pasayten west and east approaches, the Methow/Twisp
trail systems, and Lake Chelan–Sawtooth with its pedestrian links to
Stehekin. The [NPS trail guide](https://www.nps.gov/noca/planyourvisit/trailguide.htm)
lists park trails including Baker River, Copper Ridge, Cascade Pass,
East Bank, Bridge Creek, Agnes Creek, and Stehekin area trails. The
[NPS access guide](https://www.nps.gov/noca/planyourvisit/directions.htm)
identifies SR 20 and SR 542 as primary road approaches and identifies the
Cascade Pass, Rainy Pass, and Twisp River trail approaches to roadless
Stehekin. [USFS Mount Baker district](https://www.fs.usda.gov/r06/mbs/recreation/mt-baker-ranger-district?page=1)
lists Baker Lake and Baker River hiking trails. [USFS Colville Boundary Trail
#533](https://www.fs.usda.gov/r06/colville/recreation/boundary-533)
documents the Irongate approach through the east Pasayten to the Methow
district. The [USFS Okanogan–Wenatchee map](https://www.fs.usda.gov/Internet/FSE_DOCUMENTS/fseprd583796.pdf)
shows the Pasayten, Methow, Twisp River, Stehekin, and Lake
Chelan–Sawtooth relationship. These pages and maps were reviewed on the date
above as geographic evidence, not imported as topology or access grants.

Managing authorities for review are North Cascades National Park Service
Complex, Mount Baker–Snoqualmie National Forest, Okanogan–Wenatchee National
Forest, and Colville National Forest at the Pasayten east edge. Forest and
park borders are evidence for scope; they are not substituted for a hiking
graph or used as the hard pack boundary.

## Boundary construction and seam

The concave single `Polygon` is a deliberately generalized envelope of the
seven protected-area outlines named by `sourceNamedAreaIds` in the GeoJSON,
plus public trail approach corridors. It has 26 unique vertices and bbox
`[-122.12, 48.015, -119.78, 49.0]`; its approximate spherical area is
11,909 km². The northern edge stops at 49.0°N rather than following slight
OSM border-line drift into British Columbia. Its western edge turns east
around the Baker/Skagit foothills instead of including Bellingham and the
Puget lowlands. The east and southeast edges turn west around Pasayten and
the Lake Chelan–Sawtooth approaches instead of including the Okanogan basin.
The southern edge bends north around the Glacier Peak core but leaves the
Stehekin/Agnes Creek, Cascade Pass, and Sawtooth pedestrian connections whole.
Roads inside the polygon remain build-only portal context, never published
route edges.

Against the **configured August 1, 2026 Washington OSM snapshot**, the
polygon contains 100% of the mapped Mount Baker Wilderness, Lake Chelan NRA,
and Lake Chelan–Sawtooth Wilderness area; 99.96% of Ross Lake NRA, 99.93% of
North Cascades National Park, and 99.90% of Pasayten Wilderness. The omitted
fractions of the latter three and of Stephen Mather Wilderness (99.94%
inside) lie only in the OSM border vertices at 49.0001–49.0009°N. These are
area-overlap measurements, not a trail-edge or legal-boundary audit. Seven
OSM place/trailhead review anchors from the same snapshot fall inside the
polygon: Baker Lake Trailhead `[-121.6748747, 48.645561]`, Artist Point
`[-121.6921803, 48.8462004]`, Cascade Pass Trailhead
`[-121.0751562, 48.4754883]`, Rainy Pass `[-120.7339696, 48.5180169]`,
Harts Pass `[-120.6698889, 48.7210723]`, Iron Gate Trailhead
`[-119.9040355, 48.9085424]`, and Stehekin
`[-120.6574815, 48.3087794]`. An anchor is not a derived portal and does
not establish cycle reachability.

The polygon intentionally intersects Central Cascades in a main
Stehekin/Agnes Creek–southern park/Sawtooth area bounded by approximately
`[-121.3699091, 48.1224299, -120.5276988, 48.4758823]`, plus a tiny
western touch. The exact polygon intersection is 0.091656 square degrees,
approximately 754 km². This keeps the pedestrian Stehekin approaches and
southern NPS trails from being severed by a pack seam; two packs may contain
the same physical OSM ways, but a generated route cannot cross between their
graphs mid-search. The existing Central pack remains responsible for Glacier
Peak, Napeequa/Chiwawa, and the Alpine Lakes core. Before activation, inspect
every North/Central boundary-crossing hiking way around Baker River, Cascade
River, Stehekin/Agnes Creek and the PCT. Adjust the polygon if an included
cycle or public approach is cut. No cross-boundary edge count or compiled
portal count has yet been measured.

An August 1 OSM `osmium extract --strategy complete_ways` spike against this
exact polygon retained 3,938 raw ways tagged `highway=path`, `footway`,
`steps`, `pedestrian`, `track`, or `bridleway`: 3,831 lie wholly inside and
107 cross the boundary (31 `path`, 76 `track`). This is an inventory of raw
tags, **not** normalized published hiking edges or a cycle/portal audit.
The relevant southern path crossings include PCT `way/760899610` and South
Fork Agnes Creek `way/1346658204` at the Stehekin/Agnes seam, Cloudy Pass
`way/5838989`, and Emerald Park `way/387049074`. The PCT also crosses
49°N at `way/350466146`; no Canadian continuation belongs in this pack.
East-side crossings include North Summit `way/6089583`, Pearrygin Creek
`way/427618491`, and Tiffany Lake `way/721319912`; west-side crossings
include Cascade Trail `way/286337915`. Before activation, inspect the
published segments and cycle-bearing components around these crossings.
The southern PCT/Agnes and east Pasayten/Methow cuts are explicit unresolved
seam decisions, not evidence that a route can cross between packs.

## Explicit exclusions and access questions

- British Columbia and Canadian approach roads/trails beyond the state line.
  NPS notes that the Silver-Skagit road to Hozomeen comes from BC; it is not
  a US-side trail connector. [NPS directions](https://www.nps.gov/noca/planyourvisit/directions.htm).
- Ferry, water taxi, floatplane, boat, or shuttle links at Stehekin and Ross
  Lake. NPS distinguishes those from the listed foot approaches; no water or
  vehicle leg may complete a hiking cycle. [NPS directions](https://www.nps.gov/noca/planyourvisit/directions.htm).
- Disconnected Puget lowland, Okanogan basin, and Glacier Peak core trail
  systems. The exact boundary, rather than a search filter, enforces these
  exclusions.
- Changing snow, fire, road, ferry, and day-to-day closure conditions. They
  are outside this static data version and must not be inferred from a map.

The [USFS South Creek Trailhead listing](https://www.fs.usda.gov/visit/destinations?field_fs_states_tid_selective=All&field_rec_activities_target_id=All&field_rec_activities_tid_selective=11907&field_rec_forest_target_id=All&page=862)
reports a South Creek Trail #401 closure at private property with no public
through route. This is a **restriction-review lead**, not an applied override:
the precise current authority page, durable scope, and corresponding August 1
OSM way IDs must be checked before a restrictive exact-way file is committed.
Never promote an unknown OSM way to public access from an agency trail line.

## Search regions and route-check candidates

Candidate selectors are the whole pack; Mount Baker Wilderness; Pasayten
Wilderness; Lake Chelan–Sawtooth Wilderness; and the North Cascades NPS
complex/Stephen Mather Wilderness if the pinned named-area geometry and
derived portal distribution support a useful selector. A narrower Methow or
Highway 20 area requires a stable named polygon and the same portal review.
Only candidates present in the pinned OSM named-area inventory with useful
default-eligible, cycle-bearing portals may be committed to
`search-regions.json`. The shared 500 m named-region approach band applies;
it does not prove a portal's trail enters that named area. No selector is
approved by this charter alone.

Checkpoint clusters to prepare are Baker Lake/Baker River; Hannegan/Artist
Point; Cascade Pass; Diablo/Ross Lake; Rainy/Maple Pass; Stehekin via a
pedestrian approach; Methow/Twisp; and Pasayten west and east approaches.
Each retained cluster needs a reference coordinate within 500 m of a **derived
OSM portal**, a plausible exact route request, and a deliberately impossible
request that yields an honestly labeled close match. Boat-only access cannot
be counted as a route start. The representative OSM anchors above are
geographic checks only, not accepted checkpoint starts.

## Sources, license, and remaining gate

Use the same immutable Geofabrik Washington extract configured for Central:
`washington-260801`, upstream `2026-08-01T20:21:21Z`, URL
`https://download.geofabrik.de/north-america/us/washington-260801.osm.pbf`,
359,826,867 bytes. A fresh receipt inspected on 2026-09-22 records SHA-256
`3bea264079e184675aac7d8ab104bff5339b9e3656a36c084f96f616271a0e4e`
and retrieval at `2026-09-22T21:34:18.582Z`. OpenStreetMap data is under
[ODbL 1.0](https://www.openstreetmap.org/copyright); retain contributor and
Geofabrik attribution and resolve derived-database distribution obligations
before release. This pinned PBF supplies trail topology, access tags,
portal/building evidence, and named areas. An August 6 cache exists, but no
measurement above relies on it.

Query [USGS 3DEP 1/3 arc-second](https://www.usgs.gov/3d-elevation-program/about-3dep-products-services)
against this exact boundary and pin each intersecting product, version,
datum, hash, and receipt in a region-unique collection. USGS elevation is
U.S. public-domain data with attribution. [USFS wilderness boundary
documentation](https://data.fs.usda.gov/geodata/other_fs/wilderness/stateMap.php?stateID=WA),
USFS maps, and NPS pages are review-only inputs for this charter. No USFS or
NPS line, point, map image, or terms-sensitive material is imported or
redistributed as a pack source by this commit. Any future official trail
supplement must meet the shared licensed, connected-gap conflation rules.

Before builder activation, complete the schema-6 onboarding gate: review
boundary-crossing trail ways and disconnected components; select exact 3DEP
tiles and any durable exact-way restrictions; commit validated source configs,
search regions, and scenarios; derive and audit portals, buildings, and cycles;
build twice independently offline with byte-identical outputs; run the
representative exact/close route checks and application/browser verification.
Do not add a catalog `packId` until those checks pass. Keep raw downloads,
generated packs, receipts, and audit databases out of Git.
