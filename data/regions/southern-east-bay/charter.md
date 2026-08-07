# Southern East Bay pack charter

## Identity and purpose

- Pack ID: `southern-east-bay`
- Display name: Southern East Bay
- Intended users: local hikers generating closed routes from the southern
  Alameda foothills into the connected Mission Peak–Sunol–Ohlone–Del Valle
  corridor, including short local loops and longer backcountry routes.
- Coverage contract: `boundary.geojson` version
  `southern-east-bay-boundary-v1` is the exact hard route-geometry boundary.
  Filter geometry selects eligible access points and never clips routes. A
  padded source-download extent, if later used, cannot expand runtime coverage.

The pack remains a route generator, not a catalog of known hikes. Unknown
access is included by default and can be explicitly disabled. Exact matches and
clearly labeled near misses remain separate.

## Included and excluded systems

The boundary keeps these connected southern Alameda systems whole:

- Pleasanton Ridge, plus the adjacent Garin, Dry Creek Pioneer, Five Canyons,
  and southern foothill connections that lead toward Vargas Plateau;
- Vargas Plateau and Mission Peak, including their Niles/Sunol approaches;
- Sunol Regional Wilderness;
- the signed Ohlone Wilderness Trail corridor across EBRPD and San Francisco
  Public Utilities Commission watershed land; and
- Ohlone Wilderness and Del Valle, including both sides of the lake where they
  form loop-capable hiking networks.

The concave polygon intentionally stops south of the northern East Bay systems
and west/north of the broader Diablo Range. It excludes Mount Diablo, the
Berkeley/Oakland hills, Henry W. Coe State Park, and Stanislaus National Forest.
The pinned OSM named-area inventory contained none of those excluded names.
Reference-complete OSM extraction can pull relation or way members beyond the
polygon; those members do not expand coverage, and every segment crossing or
leaving the exact polygon is rejected by compilation.

## Managing authorities and access responsibilities

- East Bay Regional Park District (EBRPD) manages the six major included park
  systems and is the primary authority for trail permissions and restrictions.
- San Francisco Public Utilities Commission watershed land is crossed only by
  the signed Ohlone corridor. Off-corridor watershed travel is not inferred as
  public access.
- City of Fremont/Ohlone College and local road or staging-area owners affect
  practical Mission Peak entrances; their parking or entrance geography must
  not be treated as permission for unrelated land.
- Current closure/prohibition evidence outranks current permission, which
  outranks clear OSM access tags, with unresolved evidence remaining unknown.

Every route start is now derived as an OSM trail/street portal. EBRPD entrance
points are optional name overlays and cannot create starts or change access.
Safety-critical removals live in the committed exact-way restriction list,
which includes the current reviewed closures. No page or PDF is scraped into
the build.

## Reviewed search-region decisions

The onboarding review considered the whole pack plus the five roadmap
candidates. Only candidates with a real OSM named-area ID, useful snapped access
points, and cycle-bearing extracted topology are published in
`search-regions.json`:

| Decision | OSM named area | Snapped access points | Physical segments | Cycle observation |
| --- | --- | ---: | ---: | --- |
| Retain | `relation/11518106` Pleasanton Ridge Regional Park | 2 | 6,122 | 4 cycle-bearing components; total cycle rank 80 |
| Defer | `relation/11274796` Mission Peak Regional Preserve | 0 | 2,266 | 2 cycle-bearing components, but all three official entrances and their snappable nodes fall outside the exact named polygon |
| Retain | `relation/317363` Sunol Regional Wilderness | 11 | 2,852 | 2 cycle-bearing components; total cycle rank 26 |
| Defer | `relation/11520322` Ohlone Regional Wilderness Preserve | 0 | 1,782 | 1 cycle-bearing component, but Ohlone intentionally has no direct public entrance |
| Retain | `relation/226483` Del Valle Regional Park | 13 | 4,031 | 6 cycle-bearing components; total cycle rank 56 |

The published list therefore has four entries: the whole pack, Pleasanton
Ridge, Sunol, and Del Valle. Mission Peak and Ohlone stay in pack coverage and
scenario QA but cannot become reviewed selectors until an approved access model
provides at least one eligible start inside the selected geometry. Vargas
Plateau was inspected (`relation/11352838`, 1 snapped access point and 425
physical segments) but was not one of the roadmap's reviewed selector
candidates, so it remains a scenario cluster rather than a published selector.

All five candidate IDs and exact names were found in the extracted named-area
inventory before the retain/defer decision. The official Mission Peak entrance
preflight confirmed: Anza-Pine is outside the polygon and 256.84 m from the
nearest retained network node; Stanford is outside and 11.18 m from a retained
node that is also outside; Ohlone College is outside and 200.42 m from a
retained node that is also outside. Closed-area variants such as Pleasanton
Ridge's restricted area were not selected.

## Representative starts and scenarios

`scenarios.json` records the official Foothill Road, Stanford Avenue, Vargas
Plateau, Sunol, and Del Valle entrance coordinates plus an intended Sunol
approach point for the Ohlone Wilderness Trail, which has no direct official
entrance. Each cluster has a broad plausible distance/elevation request intended
to produce at least one exact closed route and a deliberately impossible 1–2
mile / 8,000–9,000 foot request that must remain near-miss-only. These are
activation expectations, not claims that were proven during boundary preflight;
the built pack must run and pass every scenario before activation.

## Neighboring-pack overlap

No overlap with the current Santa Cruz Mountains pack is required. A future
Henry Coe pack may overlap only if a later connectivity audit shows that a
coherent loop-capable trail system would otherwise be split. The present
boundary deliberately excludes Henry Coe and does not use a county rectangle to
avoid or manufacture overlap.

## Boundary and topology preflight

Preflight used the pinned Geofabrik Northern California snapshot at SHA-256
`215f18449e6cd190200a7dc1188a63dba2bec1f20fb3d1637c4f11c1f9134342`, retrieved
`2026-08-06T20:35:30.702Z`, with upstream timestamp
`2026-08-02T01:02:04.000Z`. Commands used the production `complete_ways`
polygon-extraction strategy and production hiking/named-area filters.

- Boundary bbox: `[-122.08, 37.365, -121.515, 37.75]`; the exterior ring is
  closed, counter-clockwise, non-zero-area, and non-self-intersecting.
- Complete-ways regional extract: 20,162,400 bytes; 2,761,010 nodes; 337,972
  ways; 5,712 relations. Reference completion explains the larger object data
  bbox and does not alter exact coverage.
- Hiking filter: 4,882,514 bytes; 511,153 nodes; 79,603 ways; 24 relations.
- Normalization: 257,037 retained/input nodes, 27,216 hiking-relevant ways,
  2,680 raw access points, and 52,387 rejected non-hiking ways.
- 200 m access snapping: 2,128 deduplicated access points before the final
  coverage check; 2,393 snapped, 2 already connected, 267 duplicates removed,
  and 285 rejected beyond tolerance.
- Exact coverage: 253,622 physical segments retained; 5,699 crossing/outside
  physical segments rejected (11,398 directed edges); 2,113 snapped access
  points remained in coverage.
- Connectivity spike: 2,174 weak components, 496 cycle-bearing components, and
  181 cycle-bearing components with at least one snapped access point. The
  largest component had 24,255 nodes, 25,264 unique adjacency edges, cycle rank
  1,010, and 108 access points.
- Named-area export: 459 filtered polygon features, yielding 363 supported,
  named, normalized polygons. Every retained selector ID and every deferred
  candidate ID/name above was present.

These counts are preflight observations, not a clean pack audit. Elevation,
population, authority matching, direction-aware topology profiles, and final
access eligibility are evaluated during the two identical offline builds.

## Pinned source and license decisions

### Topology

Geofabrik Northern California OSM snapshot `norcal-260801`, expected length
648,017,783 bytes, ODbL 1.0. The cache receipt records the exact SHA-256 above.
Redistributing a derived OSM database requires the appropriate ODbL offer and
license materials; local build inputs and generated packs remain out of Git.

### Elevation

USGS 3DEP 1/3 arc-second (nominal 10 m), NAD83/NAVD88, public domain. An
official National Map query on 2026-08-07 selected the latest pinned one-degree
products `68afba8dd4be02645f9b292f` (`n38w123`, 2025-08-26) and
`68afba8fd4be02645f9b293f` (`n38w122`, 2025-08-26). The region-specific
collection namespace is `southern-east-bay-elevation`; immutable raw product
caches may be shared.

### Population

European Commission Joint Research Centre GHS-POP R2023A, epoch 2020,
`4326_3ss` / 3 arc-second product. European Commission reuse is allowed with
JRC attribution. The region-specific collection namespace is
`southern-east-bay-population`; missing all-zero tiles retain the documented
zero-population meaning.

### Reviewed access removals

The former live EBRPD Roads and Trails line source is no longer a pack input.
`access-restrictions.json` preserves only its safety-relevant algorithmic
effect: 42 reviewed public/unknown-to-prohibited changes, plus the 3 current
Shady Glen closures. Eighteen already-private/prohibited matches were inert and
were omitted. The committed list targets exact OSM way IDs, accepts only
restrictive states, and is applied before portal derivation.

### Official entrances

EBRPD ArcGIS item `3795cd719b834488b3d2a208e2a9cef8`, layer 1 **EBRPD Park
Entrances**, filtered to the same six park names. The pinned query returned 25
features with 25 distinct non-null `GlobalID` values and no transfer-limit
flag: 12 Del Valle, 3 Mission Peak, 4 Pleasanton Ridge, 5 Sunol, 1 Vargas
Plateau, and no direct Ohlone entrance. The adapter validates the documented
fields, but the build uses these records only to name and raise confidence on
already-derived portals. Entrance presence, parking, walking, and closure
fields cannot create or remove a portal.

The entrance item has the same disclaimer and no affirmative reuse grant, so
local evaluation is permitted while normalized derivative redistribution
requires review or written permission. Exact item, layer, and inspected-response
hashes are recorded in `official-sources/ebrpd-park-entrances.json`.

### Current closure review

The official EBRPD [Alerts & Closures](https://www.ebparks.org/alerts-closures)
page was reviewed on 2026-08-06 local time. The 181,487-byte reviewed response
had SHA-256
`7da0a19c3982406e9171ad802c0d697e491f0d79bd79e90241b30a32a771c83b`.
The only current trail closure found in the included systems was Shady Glen
Trail at Sunol, first published July 23 and updated July 29, 2026.

`access-restrictions.json` records that human-reviewed fact against the three
matching ways in the pinned regional OSM snapshot: `way/133590543`,
`way/284501998`, and `way/284501999`. Builds read this committed list and never
scrape live HTML. The public page offers no affirmative data-reuse grant, so
the same local-evaluation and derivative-redistribution review requirement
applies. A fresh human review and updated restriction list are required before
a later pack release.

## Activation blockers and acceptance

This charter and data definition do not activate the pack or add the registry
`packId`. Activation still requires two identical offline builds, zero audit
errors, zero missing elevation/profile/population values, official-source and
license review, representative exact and honest near-miss scenario results,
pack switching and Jobs checks, `npm run verify`, and two consecutive browser
test passes. Mission Peak and Ohlone selector publication remains deferred as
described above.
