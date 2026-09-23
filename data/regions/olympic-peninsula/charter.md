# Olympic Peninsula pack charter

## Identity and hard coverage

- Pack ID: `olympic-peninsula`; display name: Olympic Peninsula.
- Schema-6 shared regional builder, data-version prefix `op`.
- Exact build boundary: `boundary.geojson`, version
  `olympic-peninsula-boundary-v1`. Named, drawn, and drive-time areas select
  access points; they do not clip a hiking route.

This pack generates closed hikes from source trail topology. It is not a list
of known itineraries. Unknown access remains included by default, and exact
matches stay separate from labeled close matches.

The boundary was drafted from Olympic National Park and Olympic National
Forest polygons in the pinned August 1, 2026 Washington OSM extract, with
small forest fragments lacking a hiking network omitted. It preserves the
park's coastal sections, the mountain/forest core, and 33 source inholding
holes. The valid four-part MultiPolygon has bbox
`[-124.7425886, 47.2992132, -122.8837697, 48.2752636]`. One detached
forest-only area west of Lake Crescent contained only mapped road tracks and
was removed. This exact boundary is a coverage decision, not a claim that
every OSM path within it is public or passable.

The four retained parts are the main mountain and forest system; the north
coast including Ozette, Rialto, and Shi Shi's park beach; the South Coast from
Second/Third Beach toward Hoh Head; and the Kalaloch coastal strip. The
boundary deliberately excludes Kitsap, unrelated lowland trails, and tribal
approaches where public trail permission has not been reviewed. A boundary
component is not presumed to connect to another by hiking trail or ferry.

## Coastal trail evidence and tide limitation

The pinned OSM extract has `highway=path` ways for Cape Alava Trail
`way/139732434`, Sand Point Trail `way/36745087`, and Ozette River to Sand Pt
Beach Travelway `way/139733448` plus its short continuation ways. Their
source nodes form a connected cycle, and every named leg is inside the exact
boundary. This is a **source topology preflight**, not a solver result.
The graph also contains named North/South Coast Beach Travelway, Rialto,
Kalaloch, and Hoh Head paths. Some coastal source lines cross the park/forest
outline or follow a low-tide line; the boundary and access review must be
revisited after compilation before claiming full travelway coverage.

Mapped beach tread is in scope now. Tide and surf timing is a later feature.
A generated route containing a beach segment cannot certify its passability
at a chosen time. [NPS wilderness coast](https://www.nps.gov/olym/planyourvisit/wilderness-coast.htm)
and [NPS tide guidance](https://home.nps.gov/olym/planyourvisit/tides-and-your-safety.htm)
are trip-planning authorities; no live tide or closure request enters the
build or runtime. Do not invent river-mouth crossings, overland headland
bypasses, or a beach link merely to close a graph cycle.

Makah and Quileute approaches require jurisdiction and current permit/fee
review before their starts can be treated as public. In particular, the OSM
Shi Shi Beach Road `way/5854558` is outside the hard boundary, so a route
cannot assume it connects the park beach to an access point. NPS distinguishes
park coast from neighboring tribal land; the [Makah visitor notice](https://makah.com/wp-content/uploads/2022/03/Public-Notice-for-Visitors-Reservation-Re-opening_Final-2.pdf)
and [NPS Mora/Rialto guide](https://www.nps.gov/olym/planyourvisit/visiting-mora-and-rialto.htm)
are review inputs, not imported access grants.

## Pinned sources

The OSM source is Geofabrik Washington `washington-260801`, upstream
`2026-08-01T20:21:21Z`, 359,826,867 bytes, SHA-256
`3bea264079e184675aac7d8ab104bff5339b9e3656a36c084f96f616271a0e4e`.
The verified immutable receipt was acquired on 2026-09-22. OSM supplies
topology, tags, portal and building evidence, and named areas under ODbL 1.0;
retain contributors and Geofabrik attribution and resolve derived-database
distribution obligations before release.

The official USGS National Map catalog was queried on 2026-09-22 using the
exact boundary bbox and 1-by-1-degree 1/3-arc-second products. Its 23 results
included historical versions; `elevation-source.json` pins the latest 2024
publication for each of six intersecting tiles: `n48w123`, `n48w124`,
`n48w125`, `n49w123`, `n49w124`, and `n49w125`. USGS 3DEP is public domain.
The deliberate 2026-09-23 refresh wrote immutable receipts for the six TIFFs:

| Tile | Product ID | Bytes | SHA-256 |
| --- | --- | ---: | --- |
| `n49w125` | `6604fa83d34e64ff154955d7` | 318,220,664 | `34b753c421a1f6a1d9983feca57222376bb1aca544bb5c77ed78dcec23544799` |
| `n49w124` | `6604fa84d34e64ff154955d9` | 87,446,876 | `cbfc7a739df9eff5a089959d0ffe651644d298ba26d4b553d9c7c04c093292d6` |
| `n49w123` | `6604fa86d34e64ff154955db` | 354,482,800 | `fec8c29431bf8ffa5e8a0f16288e906c571965f247038f6bd81805a9f3b0040d` |
| `n48w125` | `6604fa88d34e64ff154955dd` | 189,214,139 | `88f011c61a723c0bf32867fea6d29bea3bd9352acc5b8aad6c64924f9e98ce4c` |
| `n48w124` | `6604fa89d34e64ff154955df` | 489,343,591 | `eb714d6619e7dfa20541017af5897ce3a9670f75ebbd8aac784756bf327eb2b7` |
| `n48w123` | `6604fa8bd34e64ff154955e1` | 415,454,931 | `aecc6ef7492509dfd11586ad7961b20d086475df5b91a9cc252217af021d2b16` |

The collection retrieval timestamp is `2026-09-23T04:07:14.153Z`.
Catalog sizes were advisory; the table records downloaded bytes and hashes.

No official trail supplement, invented portal, or static temporary closure is
part of v1. Agency pages and maps are geographic and access-review evidence,
not downloadable topology. A durable restriction needs an exact OSM-way
target and reviewed authority evidence.

## Selectors and route checkpoints

The regional OSM preparation exported 12 named areas from this exact boundary.
It did not retain the larger Olympic National Park, Olympic National Forest,
or Daniel J. Evans Wilderness relations, which have members beyond the
multipart extraction. The reviewed selector list therefore contains the whole
pack and three forest wildernesses with compiled default-eligible,
cycle-bearing portals inside their polygons or the shared 500 m approach band:
Buckhorn (7), Colonel Bob (1), and Mount Skokomish (2). Wonder Mountain and
The Brothers survived area preparation but each matched zero eligible
portals, so they are deferred. The approach band does not prove that a trail
enters the named area. Park, forest, and Daniel J. Evans remain deferred
selector candidates; their source polygons are not silently reconstructed
from the pack boundary.

Review Hurricane Ridge/Deer Park, Elwha, Lake Crescent, Sol Duc, Dungeness,
Hoh, Bogachiel, Queets, Quinault/Graves Creek, Colonel Bob,
Dosewallips/Duckabush, Staircase, Ozette, Rialto, and the South Coast.
These are validation clusters, not preloaded hikes. A linear coast trail may
be represented without yielding an exact closed result. The pinned Colonel
Bob Peak Trailhead has no derived eligible portal within 500 m under the
shared trail/road-contact rule; it remains a recorded access gap, while the
nearby Kestner Homestead loop is a separate passing checkpoint. Each retained
route checkpoint must resolve to a derived portal and pass a plausible exact
request plus a deliberately impossible request with a labeled close result.

## Activation gate

The final candidate `op-34b052c73d4a5711` passed two fresh independent
offline builds from the same pinned caches. SHA-256 matched byte for byte:
manifest `189ae96ea59c5be3c3f3b941156b5a6a762f8cc93fa1e7cf14874d2844aef396`,
SQLite `18a3d68f6ca252a7cf8272a1960ddda6d3057abbb69073062f26e9b48b12d8fa`,
base audit `4bc6d4a581b591e4cd173aa80d4607203033a5376269951980eeb33bc8fcc7fa`,
regional audit `4f4272edabe92eb968a4460413211a8f3f4eafd7b38e0caec5969672246bec3d`,
and portal audit `1788c365774b6e6b09641f3da12a619d67a2ed8d2336e293244bb9fc7e919437`.
The audit has 128,029 nodes, 255,244 directed edges, 407 published access
points, zero missing elevation nodes/edges, zero outside-coverage edges, zero
unattributed records, and zero errors. The input included 437 derived portals,
of which 29 fell outside exact coverage; 128 published starts can reach a
cycle when unknown access is included. One published start is near an OSM
building. The graph has 446 disconnected components, and 13,314 source edges
were rejected by coverage/access normalization; these remain review signals.
The raw boundary-crossing inventory contains 139 tracks, 35 paths, and five
footways. Named coastal crossings include the Shi Shi–Ozette travelway,
South Kalaloch Beach, Second Beach's approach, Hoh Head Way, and Hoh Head
Low Tide Route. The first three meet unresolved tribal/neighboring-land
jurisdiction, while the Hoh Head lines briefly leave the mapped park outline;
the v1 hard boundary intentionally clips them rather than asserting an
unreviewed public corridor. Other crossings include Little River, Mount
Muller, Wynoochee, and several forest approach trails; they are not claimed
as complete circuits by this pack. The Ozette triangle's three validated
legs have no boundary crossing.

The final-version Thorough checkpoint passed all nine accepted scenarios,
each with an exact route and a labeled close match, with zero directed
validation rejections. Ozette's generated route follows Cape Alava Trail,
the mapped beach travelway, and Sand Point Trail: 14.25 km, 166 m gain, and
2.6% repeated trail. It carries the normal uncertain-access warning; tide
timing is still unmodeled. Quick spot checks passed Ozette and Hoh; the bounded
Quick search exhausted its budget at Sol Duc and found no impossible-request
close match at Buckhorn, while Thorough passed both. This is visible search
incompleteness, not silent constraint relaxation.

With a temporary local catalog link, the app catalog exposed all four retained
Olympic choices, `/api/map` returned 20 Ozette trail features and one access
point for a coastal viewport, and the real `/api/search` endpoint returned one
exact Ozette route. Desktop and 390 px mobile Chromium checks found the region
choice, working mobile map toggle, no horizontal overflow, and no page/console
errors. Basemap tiles did not render in that local browser run, so that check
does not establish live external-tile availability.

The final catalog links this verified pack. Two shared `npm run verify` runs
each passed 553 tests, lint, types, and build; two browser runs each passed
seven Chromium flows. A real installed-pack Full search near Ozette completed
with one exact coastal route, restored after an app restart, and was labeled
"Generated with older map data" when read against a separate empty pack root.
All four new packs appeared in desktop and 390 px mobile region controls with
no browser errors or horizontal overflow. The excluded crossing corridors
above require new jurisdiction evidence and a boundary version before they can
be claimed as complete routes. The Colonel Bob Peak Trailhead and some linear
coast routes lack a qualifying closed-route portal, and live tide-aware
passability remains deferred. Generated downloads, packs, receipts, caches,
and databases stay outside Git.
