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
multipart extraction. The reviewed selector list therefore contains the
whole pack and the five forest wildernesses that survived preparation:
Buckhorn, Wonder Mountain, Colonel Bob, Mount Skokomish, and The Brothers.
Retain each wilderness selector beyond preflight only if the compiled pack has
useful default-eligible, cycle-bearing portals inside the polygon or shared
500 m approach band. The band does not prove that a trail enters the named
area. Park, forest, and Daniel J. Evans remain deferred selector candidates;
their source polygons are not silently reconstructed from the pack boundary.

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

Before catalog activation, inspect the 179 raw path/footway/track ways that
touch but are not wholly covered by this draft boundary, especially coastal
crossings; audit source access and jurisdiction seams; derive portal/building
and connected-cycle distributions; refresh pinned sources once; build twice
offline from independent preparation roots with byte-identical manifest,
SQLite, and audits; pass representative exact/close route and browser checks.
This charter does not claim those checks have passed. Generated downloads,
packs, receipts, caches, and databases stay outside Git.
