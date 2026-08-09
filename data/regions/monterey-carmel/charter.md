# Monterey–Carmel pack charter

## Identity and purpose

- Pack ID: `monterey-carmel`
- Display name: Monterey–Carmel
- Intended users: hikers generating closed routes across the Monterey
  Peninsula, Carmel Valley, and the connected northern Santa Lucia trail
  systems, from short coastal walks to longer ridge and backcountry loops.
- Coverage contract: `boundary.geojson` version
  `monterey-carmel-boundary-v1` is the exact hard route-geometry boundary.
  Filter geometry selects eligible access points and never clips routes. A
  padded acquisition extent, if later required, cannot expand runtime coverage.

The pack is a route generator, not a catalog of established hikes. Unknown
access remains included by default and may be disabled explicitly. Exact
matches and clearly labeled close matches stay separate.

## Included and excluded systems

The concave boundary keeps these planned systems and their practical
connections in one pack:

- Fort Ord National Monument, including the Creekside Terrace and Badger Hills
  sides of the signed public trail network;
- Palo Corona Regional Park, including the permit-free Rancho Cañada unit and
  the restricted west/east-gate approaches;
- Garland Ranch Regional Park and the connected Kahn Ranch trail system;
- Point Lobos State Natural Reserve;
- Garrapata State Park; and
- a narrow northern Santa Lucia connection between the Carmel Valley and
  coastal systems where the extracted hiking network remains connected.

The polygon is shaped around those networks rather than Monterey County or a
rectangular download extent. Its southern lobe stops at latitude `36.32` and
its eastern limit is `-121.66`. It does not continue into deep Big Sur, the
Ventana backcountry, or the broader Los Padres National Forest. None of
`Ventana`, `Los Padres`, `Big Sur`, `Andrew Molera`, or `Pfeiffer` appeared in
the final extracted named-area inventory. Reference-complete extraction does
retain remote members of intersecting ways and relations outside the polygon;
those objects never enlarge exact coverage, and crossing/outside segments are
rejected during compilation.

## Managing authorities and access responsibilities

- The Bureau of Land Management manages Fort Ord National Monument. BLM's
  current visitor guidance says unsigned trails and trails absent from the
  official recreation map are closed; its map also marks military-munitions
  hazards and Army-managed land closed to public use. A topology line in OSM
  therefore cannot be treated as hiking permission without signed-trail or
  current BLM evidence.
- Monterey Peninsula Regional Park District (MPRPD) manages Palo Corona,
  Garland Ranch, and Kahn Ranch. Rancho Cañada is a permit-free Palo Corona
  entrance, while Highway 1 and South Bank access have permit/parking
  conditions. Kahn Ranch access via Hitchcock Canyon Road requires a vehicle
  permit; hikers may instead enter from the Vasquez–Cougar Ridge trails inside
  Garland Ranch without that permit. Entrance-specific conditions must remain
  explicit rather than being promoted to blanket park permission.
- California State Parks manages Point Lobos and Garrapata. Point Lobos is a
  day-use reserve with operating-hour and designated-trail restrictions.
  Garrapata uses numbered Highway 1 access points; State Parks currently
  identifies the main gated entrance opposite Gate 8 for Soberanes Canyon and
  Rocky Ridge access. Current project or closure notices must override an older
  trail map.
- Adjacent lands include Big Sur Land Trust, Santa Lucia Conservancy, U.S.
  Army, county, municipal, and private holdings. Parking, a gate, or a line on
  the topology baseline is not permission for adjacent property.

Current official closure/prohibition evidence outranks current permission,
which outranks clear OSM access tags. Unresolved conflicts remain unknown. The
committed reviewed overlay preserves the official page/map hashes, review date,
entrance conditions, and exact closure targets without redistributing the
copyrighted source pages or maps. The separate USFS line inventory is a pinned
machine-readable cross-check and remains unknown unless its fields become
affirmative.

## Reviewed search-region decisions

The whole pack and all five roadmap candidates were checked against the pinned
OSM named-area inventory. Publication requires a stable named-area ID plus
useful in-polygon topology and a snapped access point in a cycle-bearing
component.

| Decision | OSM named area | Snapped access points | Physical segments | Cycle observation |
| --- | --- | ---: | ---: | --- |
| Defer | `relation/6188476` Fort Ord National Monument | 3 | 5,524 | 2 cycle-bearing components and total cycle rank 76, but no snapped access point lies in a cycle-bearing component inside the exact named polygon |
| Retain | `relation/15100521` Palo Corona Regional Park | 3 | 2,934 | 3 cycle-bearing components; 1 has access; total cycle rank 34 |
| Retain | `way/682362148` Garland Ranch Regional Park | 6 | 3,869 | 2 cycle-bearing components; 1 has access; total cycle rank 57 |
| Retain | `relation/13029412` Point Lobos State Natural Reserve | 13 | 1,118 | 1 cycle-bearing component with access; total cycle rank 12 |
| Retain | `relation/184336` Garrapata State Park | 3 | 1,177 | 4 cycle-bearing components; 2 have access; total cycle rank 10 |

The published list therefore contains the whole pack plus Palo Corona,
Garland Ranch, Point Lobos, and Garrapata. Fort Ord remains fully covered and
has its own scenario, but is deferred as a named selector until an approved
official entrance model connects Creekside Terrace or Badger Hills to the
cycle-bearing network inside the exact named polygon. This avoids inventing a
selector that would return no eligible starts.

The inventory also contained a smaller duplicate Palo Corona way
(`way/1129100800`, no snapped access) and the Rancho Cañada sub-area
(`way/760477929`). The complete protected-area relation is used for the Palo
Corona selector. Kahn Ranch has no supported standalone polygon in the pinned
OSM inventory, so it remains a covered scenario cluster rather than an invented
named selector.

## Representative starts and scenarios

`scenarios.json` spans every major planned cluster: the mapped public Main
Entrance & Gate on Fort Ord's eastern network, permit-free Rancho Cañada at
Palo Corona, Garland's visitor-center side,
the permit-dependent Hitchcock Canyon entrance at Kahn Ranch, Piney Woods at
Point Lobos, and official gate 8 at Garrapata.
Each scenario contains a plausible distance/elevation request intended to
produce at least one exact closed route and a deliberately impossible 1–2 mile
/ 8,000–9,000 foot request that must return close matches only. The final Thorough
checkpoint passed all six scenarios with 28 exact routes, an explicitly labeled
close match for every impossible request, and zero directed-validation
rejections. Garrapata's honest exact range is 1–3 miles because the current
Rocky Ridge closure removes the longer ridge loop from eligible topology.

## Neighboring-pack overlap

No overlap with the current Santa Cruz Mountains or Southern East Bay packs is
required. The northern edge ends south of the Santa Cruz pack, and the eastern
edge does not approach the East Bay pack. A future neighboring Central Coast
pack may overlap only if a connectivity audit shows that a coherent
loop-capable system would otherwise be split; county boundaries are not used to
create or prevent overlap.

## Boundary and topology preflight

Preflight used the pinned Geofabrik Northern California snapshot at SHA-256
`215f18449e6cd190200a7dc1188a63dba2bec1f20fb3d1637c4f11c1f9134342`,
retrieved `2026-08-06T20:35:30.702Z`, with upstream timestamp
`2026-08-02T01:02:04.000Z`. The commands used the production `complete_ways`
polygon strategy, production hiking filter, 200 m access snap, exact coverage
predicate, and production named-area normalization.

- Boundary bbox: `[-121.985, 36.32, -121.66, 36.715]`; the Polygon exterior
  is closed, counter-clockwise, non-zero-area, and non-self-intersecting.
- Complete-ways extract: 7,213,525 bytes; 1,169,481 nodes; 104,743 ways; 1,280
  relations. Reference completion explains the larger object data bbox and
  cannot enlarge exact pack coverage.
- Hiking filter: 2,126,957 bytes; 290,192 nodes; 28,116 ways; 5 relations.
- Production normalization: 137,151 input/retained nodes, 13,040
  hiking-relevant ways, 2,112 raw access points, and 15,076 rejected
  non-hiking ways.
- 200 m access snapping: 1,845 snapped, 8 already connected, 211 duplicates
  removed, and 259 rejected beyond tolerance, leaving 1,642 deduplicated
  access points.
- Exact coverage: 134,167 incident nodes and 136,627 physical segments
  retained; 887 crossing/outside physical segments were rejected, representing
  1,555 directed edges. All 1,642 snapped access points remained in coverage.
- Connectivity spike: 1,056 weak components, 254 cycle-bearing components, and
  122 cycle-bearing components with at least one snapped access point. Total
  cycle rank was 3,516. The largest component had 14,831 nodes, 15,191 unique
  physical segments, cycle rank 361, and 44 access points.
- Named-area export: 327 polygon features normalized to 167 supported, named
  areas. Every retained and deferred candidate ID/name in the table was
  present.

These boundary-spike observations were subsequently verified by the clean
schema-5 pack build summarized below.

## Pinned source and license decisions

### Topology and named areas

Geofabrik Northern California OSM snapshot `norcal-260801`, expected length
648,017,783 bytes, ODbL 1.0. The immutable cache receipt records the exact hash,
retrieval time, upstream time, ETag, and original URL above. Redistributing a
derived OSM database requires the appropriate ODbL offer and license materials;
raw caches and generated packs remain out of Git.

### Elevation

USGS 3DEP 1/3 arc-second (nominal 10 m), NAD83/NAVD88, U.S. public domain. The
boundary lies entirely in one one-degree product: `68afba90d4be02645f9b2943`
(`n37w122`, 2025-08-26). The existing immutable cache receipt records retrieval
`2026-08-06T20:27:02.492Z`, 415,276,131 bytes, and SHA-256
`786ad73dc03e5c7cde26b285631ef04198e386ac83d3e91ac8c1e577e7fdcd80`.
The collection namespace is `monterey-carmel-elevation`; immutable raw product
caches may be shared.

### Population

European Commission Joint Research Centre GHS-POP R2023A, epoch 2020,
`4326_3ss` / 3 arc-second, under the European Commission reuse notice with JRC
attribution. The boundary and 0.25-degree tile-selection padding use tile
`R6_C6`. Its immutable receipt records retrieval
`2026-08-06T20:27:02.511Z`, 19,853,385 bytes, and SHA-256
`326be24446a214d874691f961db3db7b8e6a3b09ead8b9f568322b67fdcb19a6`.
The collection namespace is `monterey-carmel-population`; absent all-zero tiles
retain the documented zero-population meaning.

### Official access and current restrictions

`official-sources/reviewed-access.json` is the strict, committed v1 overlay for
the official BLM, MPRPD, and California State Parks pages, maps, and the BLM
Trail Head query reviewed on 2026-08-07. It records eight exact source URLs,
content hashes, byte lengths, review/upstream dates, and source-specific reuse
decisions; normalizes ten conservative entrance points; preserves every permit,
parking, hours, signed-trail, and designated-trail condition; and targets the
current Rocky Ridge closure only to OSM ways `55856070` and `55856129`. Source
page and map bytes are not redistributed. The adapter fails closed on schema or
hash drift and never creates connector edges.

The official USDA Forest Service National Forest System Trails query is the
only refreshable Monterey official-source config. Its 15 northern Los Padres
line features are U.S. Government works, but the inspected fields contain no
affirmative pedestrian permission or prohibition. Adapter v1 therefore emits
unknown only; ten spatial joins are retained as cross-check evidence and do not
promote access. The statewide California State Parks recreational-routes layer
is explicitly excluded: the exact Point Lobos/Garrapata query returned no
features, exposes no access/closure field, and its terms do not support this
derived-pack use. OSM remains the topology baseline and unknown-access fallback,
never a substitute for a current official closure.

## Final build and activation evidence

The activated schema-5 pack is `mc-8cd6885ec6e0215a`: 134,167 nodes, 272,717
directed edges, 1,650 access points, 168 named areas, five reviewed search
regions, and five manifest sources. Its core and regional audits report zero
errors, conflicts, missing elevation/profile/population values, unattributed
records, unknown source references, or persisted edges outside exact coverage.
The compiler intentionally rejected 1,555 crossing/outside source edges.

The reviewed overlay added nine entrances, rejected one point that could not be
snapped safely, and deduplicated one entrance against existing topology. Both
Rocky Ridge way targets were present and closed exactly. Two fresh offline
builds from the same pinned cache were byte-for-byte identical: manifest
SHA-256 `9b1731fcd42e532ca5ad3e69572a42b9beca682f7c80454ccec01c2d58086945`
and SQLite SHA-256
`d814b48b3d841ceb124bca70e9fab47799381801cc7752dd0e258e3a3bc843f8`,
with identical core, regional, and access-join audit hashes. Fort Ord stays
covered and scenario-tested through the whole-pack selector; its standalone
selector remains deferred for the documented topology/access reason.
