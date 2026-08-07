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
matches and clearly labeled near misses stay separate.

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
authority pages reviewed for this charter establish requirements but are not
machine-readable pinned build inputs. Activation requires versioned official
access snapshots or reviewed overlays, adapter semantics, hashes, freshness,
and explicit redistribution decisions.

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

`scenarios.json` spans every major planned cluster: Creekside Terrace at Fort
Ord, permit-free Rancho Cañada at Palo Corona, Garland's visitor-center side,
the permit-dependent Hitchcock Canyon entrance at Kahn Ranch, Piney Woods at
Point Lobos, and the Soberanes Canyon/Rocky Ridge entrance area at Garrapata.
Each scenario contains a plausible distance/elevation request intended to
produce at least one exact closed route and a deliberately impossible 1–2 mile
/ 8,000–9,000 foot request that must remain near-miss-only. These are
activation expectations, not preflight claims. They must be rerun after
official access/closure evidence is joined, especially at Fort Ord, Kahn Ranch,
Palo Corona, and Garrapata.

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

These are boundary-spike observations, not a clean schema-5 pack audit.
Elevation/profile/population completeness, authority joins, source conflicts,
direction-aware topology, and final solver eligibility remain build-gate work.

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

Authority research began with the official BLM Fort Ord visitor page and 2022
trail map, MPRPD Palo Corona/Garland/Kahn pages and permit conditions, and
California State Parks Point Lobos/Garrapata pages and maps. Those pages provide
the signed-trail, entrance, permit, hours, and closure semantics summarized
above. They do not by themselves constitute pinned normalized build datasets,
and no affirmative derivative-data redistribution decision has been recorded
for MPRPD or State Parks material. Activation is blocked until each build input
has a cache receipt, exact content hash, review date, adapter version, field
mapping, freshness rule, and explicit license/redistribution decision. OSM
remains the topology baseline and unknown-access fallback, never a substitute
for a current official closure.

## Activation blockers and acceptance

This charter and preflight do not activate the catalog entry. Remaining work
includes approved official-access and closure inputs; explicit MPRPD, BLM, and
State Parks license/redistribution review; two identical offline schema-5
builds; zero audit errors or missing elevation/profile/population values;
representative exact and honest near-miss scenario passes; Fort Ord entrance
resolution or continued selector deferral; pack switching and saved-Job checks;
the full verify suite; and two consecutive browser-suite passes.
