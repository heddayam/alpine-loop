# North Cascades pack charter

External geography and source review: **2026-09-22**. The boundary is a
versioned build input; the validated pack remains a candidate until route and
application review is complete.

## Identity and scope

- Pack ID: `north-cascades`; display name: North Cascades.
- Coverage input: `boundary.geojson`, version `north-cascades-boundary-v3`.
  It is the **exact hard route-geometry boundary**. A named, drawn, or
  drive-time area selects starting portals and does not clip a route.
- Intended users: hikers seeking locally generated closed routes across the
  northern Washington Cascades. This is not a catalog of known hikes.
  Unknown access is included by default, and exact matches remain separate
  from labeled close matches.

The v3 polygon keeps Mount Baker and Baker Lake/Baker River approaches,
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
plus public trail approach corridors. It has 55 unique vertices and bbox
`[-122.12, 48.015, -119.78, 49.0]`; its approximate spherical area is
11,918 km². The northern edge stops at 49.0°N rather than following slight
OSM border-line drift into British Columbia. Its western edge turns east
around the Baker/Skagit foothills instead of including Bellingham and the
Puget lowlands. The east and southeast edges turn west around Pasayten and
the Lake Chelan–Sawtooth approaches instead of including the Okanogan basin.
The southern edge bends north around the Glacier Peak core, with a narrow
PCT–South Fork Agnes lobe, while retaining the Stehekin/Agnes Creek,
Cascade Pass, and Sawtooth pedestrian connections.
Roads inside the polygon remain build-only portal context, never published
route edges.

Against the **configured August 1, 2026 Washington OSM snapshot**, the
polygon contains 100% of mapped Lake Chelan NRA and Lake Chelan–Sawtooth
Wilderness, 99.989% of Mount Baker Wilderness, 99.960% of Ross Lake NRA,
99.929% of North Cascades National Park, 99.940% of Stephen Mather
Wilderness, and 99.898% of Pasayten Wilderness. The omitted area comes from
OSM border vertices at 49.0001–49.0009°N and the two v3 nodata-fringe
insets; those insets remove only 0.052 km² of the mapped Mount Baker
Wilderness and 0.018 km² of the mapped park/Stephen Mather overlap. These
are area-overlap measurements, not a trail-edge or legal-boundary audit. Seven
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
western touch. The v3 polygon intersection remains 0.092981 square degrees,
approximately 765 km². This keeps the pedestrian Stehekin approaches and
southern NPS trails from being severed by a pack seam; two packs may contain
the same physical OSM ways, but a generated route cannot cross between their
graphs mid-search. The existing Central pack remains responsible for Glacier
Peak, Napeequa/Chiwawa, and the Alpine Lakes core. Before activation, inspect
remaining North/Central boundary-crossing hiking ways around Baker River,
Cascade River, Stehekin/Agnes Creek and the PCT. Adjust the polygon if another
included cycle or public approach is cut. Compiled topology and portal counts
are reported below; a successful audit does not prove every crossing useful.

An August 1 OSM `osmium extract --strategy complete_ways` spike against the
v2 polygon retained 3,947 raw ways tagged `highway=path`, `footway`,
`steps`, `pedestrian`, `track`, or `bridleway`: 109 cross the boundary
(33 `path`, 76 `track`). This is an inventory of raw
tags, **not** normalized published hiking edges or a cycle/portal audit.
The relevant southern path crossings include PCT `way/760899610` at the new
southern edge, Cloudy Pass `way/5838989`, and Emerald Park
`way/387049074`. The PCT also crosses
49°N at `way/350466146`; no Canadian continuation belongs in this pack.
East-side crossings include North Summit `way/6089583`, Pearrygin Creek
`way/427618491`, and Tiffany Lake `way/721319912`; west-side crossings
include Cascade Trail `way/286337915`. Before activation, inspect the
published segments and cycle-bearing components around these crossings.
The other southern and east Pasayten/Methow cuts remain review decisions,
not evidence that a route can cross between packs.

The v1 preflight found a specific loop severed near South Fork Agnes Creek.
At its former boundary, PCT `way/760899610` and South Fork Agnes
`way/1346658204` crossed within 0.96 km of trail connection *inside* North.
Their exterior sides joined through 17.235 km of PCT
`way/760899610`, PCT North Connector `way/1346658207`, and South Fork
Agnes `way/1346658206`/`way/1346658204`, for an approximately 18.2 km
raw OSM circuit. All 1,137 nodes of that exterior arc are within Central's
exact boundary. The four ways have no restrictive OSM `foot` or `access`
tags; the PCT has `foot=designated`. The v2 correction adds a locally
simplified envelope about 400 m around that exterior arc, adding about
10.9 km² and leaving every arc segment at least 319 m inside the new exact
boundary. It does not remove any v1 coverage or broadly expand into the
Glacier Peak core.
`way/1346658204`, `way/1346658206`, and `way/1346658207` no longer cross
the southern boundary; the PCT continues south and still crosses it. This
is evidence of raw pedestrian topology, not a compiled route or access
portal. The OSM `way/1346658204` also has `trail_visibility=bad`,
`fixme=survey`, and a note questioning the ford location; the crossing and
route must receive explicit QA before activation. The east-side crossing
inspection found attached but separate
inside trail components around North Summit, Bernhardt Mine, and Tiffany
Lake; it did not establish a short cycle severed there. Retain the east
edge pending compiled component and portal review.

The v3 correction addresses a real elevation void at two tiny north-border
crossings, without moving the PCT crossing or the Central seam. The first
schema-6 compile failed on `osm-way-53658218:45:forward`: its northern
endpoint `[-121.4077738, 48.9998624]` on the Chilliwack River Ecological
Reserve Trail was nodata in the pinned `n49w122` DEM, while the next point
south sampled 631.79 m. A scan of 224,435 raw trail nodes within the v2
polygon found 93 nodata nodes, all in `[-121.8123303, -121.697848]` at
48.9977002–48.9999778°N or at the Chilliwack point. They are on 12 raw
ways, chiefly the Canadian-named TA4, TA8, BR717, Tamihi Forest Service
Road, and Chilliwack connectors. Direct samples of the official 2023 and
2018 `n49w122` revisions and the neighboring 2018 `n50w122` product were
also nodata at representative points, so another pinned tile would not fill
the void. The v3 edge follows 49°N elsewhere but insets to 48.9975°N
between 121.815°W and 121.695°W, and to 48.9992°N between 121.409°W
and 121.406°W. It removes approximately 2.46 km² and 89 previously
in-boundary physical segments on 10 of those ways. A full v3 scan found
zero nodata among 224,335 in-boundary raw trail nodes, and the compiled
schema-6 pack has zero missing trail elevation nodes or edges. These insets
exclude transboundary stubs; no compiled cycle lost to the change has yet
been demonstrated.

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

The current `search-regions.json` publishes the whole pack, Mount Baker
Wilderness `relation/6116357`, and Lake Chelan–Sawtooth Wilderness
`relation/6116621`. A 2026-09-22 preflight used the exact v2 polygon and
the builder's `osmium extract --strategy complete_ways`, named-area
`tags-filter`, polygon `export --attributes=type,id`, and normalizer on the
pinned August 1 Washington PBF. The export contained 73 polygon features;
the normalizer retained 68 named areas, including those two relations with
their exact names. North Cascades National Park `relation/2421537` and
Pasayten Wilderness `relation/6116548` exist in the *statewide* snapshot
but did **not** survive the regional extraction/export, so they are not
published as selectors. The narrower North Cascades National Park South Unit
relation does survive, but it cannot stand in for the whole park. The
missing full-park and Pasayten selectors, Stephen Mather Wilderness, and
narrower Methow/Highway 20 areas are deferred until a stable, complete
polygon and useful derived portals can be reviewed. The hard coverage
polygon still includes the intended park and Pasayten trails. The final v3
pack contains 69 named areas and all three requested selectors. With the
shared 500 m approach band, Mount Baker Wilderness has nine default-eligible,
cycle-bearing portals (including Artist Point, Hannegan, Heliotrope Ridge,
and Tomyhoi); Lake Chelan–Sawtooth Wilderness has one, the unknown-access,
low-confidence Crescent Mine Trail trailhead. A read-only path check of the
published graph followed Crescent Mine Trail and Twisp Pass Trail for 606 m
from that portal into the source wilderness polygon. The selector is thin but
its sole eligible approach reaches the intended area. The shared approach
band alone would not have proved that connection.

The v3 checkpoint retains eight loop-capable clusters: Baker Lake/Baker
River; Artist Point/Hannegan; Diablo/Ross Lake; Rainy/Maple Pass; Stehekin
via a pedestrian approach; Methow/Twisp; and Pasayten west and east. The
mapped Baker Lake Trailhead, Baker River, and Swift Creek starts returned no
closed candidate under a broad 0.1–30 mi, 100% repeated-trail probe. The
Bayview Loop Trail trailhead yields a genuine 1.24 mi simple loop on Baker
Lake. The East Bank Trailhead by Ross Lake triggered a stack overflow in the
pre-fix recursive route validator; the integration branch replaced that DFS
with an iterative traversal. The original East Bank request then completed
without an exception but found only labeled 40–41 mi close matches for its
5–25 mi target. The nearby Happy Creek Trailhead yields a 0.31 mi forest-walk
lollipop. These short routes are presented with their measured scale, rather
than implying a long wilderness loop. Scatter Creek and Chewuch Trail Q0
replace the initially selected Twisp and Iron Gate anchors because they have
real eligible cycle-bearing starts and measured 20–30 mi loops. War Creek is
the Stehekin *foot-approach* anchor; a landing or water taxi is not a start.
Each retained anchor is within 150 m of its selected derived portal and has a
plausible exact request plus an impossible 40,000–45,000 ft gain request that
returns an explicitly violated close match.

Cascade Pass remains inside hard coverage and has an eligible trailhead 41 m
from the reference point, but both it and the nearby Lookout Mountain
Trailhead returned **zero closed candidates** in the broad 0.1–30 mi,
100% repetition probe. That trail cluster is essentially linear in this
snapshot and is deliberately deferred as a route checkpoint. It is not
represented by a made-up exact loop. Other specific starts may likewise have
no closed route even though the regional pack has many feasible portals.

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

The official [USGS National Map product catalog](https://tnmaccess.nationalmap.gov/api/v1/products)
was queried on 2026-09-22 for the exact bbox
`[-122.12, 48.015, -119.78, 49.0]`, dataset `National Elevation Dataset
(NED) 1/3 arc-second`, and extent `1 x 1 degree`. The response had 24
historical/current records. `elevation-source.json` pins the newest published
GeoTIFF revision for each of the **four tiles with positive area** inside
the boundary:

| Tile | Pinned product ID | Publication date | Verified bytes | SHA-256 |
| --- | --- | --- | ---: | --- |
| `n49w120` | `689d4591d4be027ac158993c` | 2025-08-13 | 455,715,088 | `71e36877bb877bc74e129e7d6565f11006403ef8afacddbee93e88b16520dd23` |
| `n49w121` | `689d4591d4be027ac158993a` | 2025-08-13 | 460,254,841 | `0641c47ed684ffa5cd50d25f80aff2b9fad91cc0e84b65ee3c7e900369e9eee7` |
| `n49w122` | `689d4590d4be027ac1589938` | 2025-08-13 | 479,441,377 | `f0c67d4ee5e2ee67e652bd512c590f609ce3c5766a6d38a23fd460abb6804d73` |
| `n49w123` | `6604fa86d34e64ff154955db` | 2024-03-27 | 354,482,800 | `fec8c29431bf8ffa5e8a0f16288e906c571965f247038f6bd81805a9f3b0040d` |

The four private-cache receipts share retrieval time
`2026-09-23T04:35:23.144Z`; the OSM receipt and every DEM file passed its
hash check before each build. The catalog also returns `n50` tiles touching
the top edge at 49.0°N; they have no positive-area intersection with this
Washington-only polygon and are not pinned. The `north-cascades-elevation`
namespace is region-unique. Rasterio reports EPSG:4269 horizontal CRS for
all four GeoTIFFs; the collection declares the catalog's NAVD88 vertical
datum, which has not been independently surveyed. USGS elevation is U.S.
public-domain data with attribution. [USFS wilderness boundary
documentation](https://data.fs.usda.gov/geodata/other_fs/wilderness/stateMap.php?stateID=WA),
USFS maps, and NPS pages are review-only inputs for this charter. No USFS or
NPS line, point, map image, or terms-sensitive material is imported or
redistributed as a pack source by this commit. Any future official trail
supplement must meet the shared licensed, connected-gap conflation rules.

## Schema-6 build and route QA

An explicit source refresh and complete v3 build, followed by two fresh
offline preparation/output builds, published the same schema-6 data version
`nc-989d91f71a1d0be6`. Each run executed all ten build stages into a
different output root. The SHA-256 hashes matched across all three outputs:

| Published file | SHA-256 |
| --- | --- |
| `manifest.json` | `c1388c780d6d6ff20731b2000b2682cc9734b4aa1dbb20f3adf998ec994b8c5a` |
| `pack.sqlite` | `44c73bac912b9ce1ef898fa039235199133b7ee6c997cfc6389d5b84e6ec70c5` |
| `audit.json` | `b76cc471f4ae1210b4e9b742b6ad12897e8e9960d77bf28ff4b1c4549d43a60e` |
| `regional-audit.json` | `be32e8543d19041737d38d7f0a19c48c2e19b255e59d913d194c8d2267cd7182` |
| `portal-audit.json` | `4740a933b4f541ef443bcb1837eb1852a84c47026150361d54a9c947d69b81af` |

The pack has 224,334 nodes, 447,092 directed trail edges, 631 published
portals, 69 named areas, and three search regions. No road, street, or
sidewalk edge is published. The compiler rejected 11,130 directed source
edges at the exact coverage boundary. The regional audit reports **zero errors,
outside-coverage edges, missing elevation nodes/edges, conflicts, isolated
nodes, implausible metrics, unattributed records, and unknown source refs**.
SQLite `integrity_check` is `ok` and `foreign_key_check` is empty. The graph
has 625 disconnected components and its largest has 51,882 nodes (23.13%);
those are review warnings, not an assertion of universal walkability. The
PCT–South Fork Agnes lobe still publishes 214, 234, and 90 directed edges
from `way/1346658204`, `way/1346658206`, and `way/1346658207` respectively.

The portal report derived 637 starts, of which 631 are inside coverage; 184
have mapped parking evidence. Published portals have nearby-building counts
from 0 to 258 (mean 12.4); 279 have at least one nearby building and 38 hit
the shared 50-building built-up exclusion. The inclusive cycle profile
marks 303 portals feasible and 328 without a reachable cycle; the known-only
profile marks 42 feasible. Applying access, buildings, and inclusive cycle
filters yields 282 default-eligible starts. The most built-up examples are
near Winthrop and Baker/Skagit foothill towns, which is directionally
plausible. These counts do not establish seasonal or legal public access.

The eight retained `scenarios.json` cases passed the **Thorough** checkpoint:

| Cluster | Selected derived portal / distance | Exact | Impossible-request labeled close |
| --- | --- | ---: | ---: |
| Baker Lake | Bayview Loop / 0 m | 1 | 1 |
| Artist Point | Artist Point / 0 m | 1 | 1 |
| Diablo/Ross Lake | Happy Creek / 0 m | 1 | 1 |
| Rainy/Maple Pass | Rainy Pass / 145 m | 2 | 3 |
| Stehekin foot approach | War Creek / 149 m | 1 | 2 |
| Methow/Twisp | Scatter Creek / 0 m | 2 | 2 |
| Pasayten west | Harts Pass / 20 m | 1 | 1 |
| Pasayten east | Chewuch Trail Q0 / 0 m | 3 | 3 |

All 16 Thorough runs had zero directed-validation rejections, and their
combined measured solver wall time was 13.2 s. A full **Quick** checkpoint
also passed all eight cases, with at least one exact and one labeled close
match in each. These are empirical route outcomes, not a guarantee for every
start. The east Pasayten broad search can also surface OSM segments named as
forest road or abandoned Coleman Ridge/Fire Creek trails. Those mapped paths
remain in the pack with their `trail-visibility:horrible` or other source
condition flags and their original access states; no authority-backed exact-way
restriction was established. The live Chewuch Quick result used Basin Creek,
Cathedral Driveway, Chewuch, Windy Creek, and Windy Peak trails, without an
abandoned segment, and carried its uncertain-access warning. The South Fork
Agnes ford uncertainty noted above still needs on-the-ground judgment.

Catalog activation passed after the shared integration verification: two
`npm run verify` runs each passed 553 tests, lint, types, and build; two
`npm run test:browser` runs each passed seven Chromium flows. The live app
listed North and its two named selectors, returned 103 trail features and five
starts around Artist Point, and returned an exact 18.4 km Artist Point Quick
route. A real Full-search persistence and mobile check used the installed
Olympic pack in the same catalog. The Cascade Pass linear-trail limitation,
border crossings, and South Creek closure lead remain explicit review items
for a later source revision. Raw downloads, generated packs, receipts, and
audit databases stay outside Git.
