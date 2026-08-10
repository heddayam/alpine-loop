# Central Cascades pack charter

## Identity and purpose

- Pack ID: `central-cascades`
- Display name: Central Cascades
- Builder contract: schema 6, shared basic regional builder, prefix `cc`, and
  `officialAccess: false`.
- Coverage contract: `boundary.geojson` version
  `central-cascades-boundary-v1` is the exact hard route-geometry boundary.
  Search regions and drawn or drive-time areas filter eligible access points;
  they never clip route geometry.

This is a route-generator pack, not a catalog of established hikes. Unknown
access remains included by default and may be disabled explicitly. Exact
matches and clearly labeled close matches remain separate. No official access
overlay or regional routing exception is part of v1.

## Cascades family and included systems

Washington Cascades expansion is divided into four independently rebuildable
packs rather than one statewide artifact: North Cascades, Central Cascades,
Rainier–Goat Rocks, and Southwest Cascades. Seams may overlap when that is
required to keep a viable hiking network whole.

Central Cascades keeps these connected systems and their public approaches:

1. the complete Glacier Peak Wilderness hiking network, including the
   Napeequa and Chiwawa valleys, Phelps Creek/Spider Meadow, Lake Wenatchee,
   Suiattle, North Fork Sauk, and Mountain Loop approaches;
2. the Stevens Pass connection between the Glacier Peak and Alpine Lakes
   systems;
3. the complete Alpine Lakes Wilderness hiking network, including
   Leavenworth/Icicle/Enchantments, Snoqualmie, Middle Fork Snoqualmie, Cle
   Elum, Salmon la Sac, and Tucquala approaches; and
4. Teanaway Community Forest and its public approach network.

The committed concave polygon is the reviewed union of the three stable OSM
named-area outlines with explicit approach corridors. Interior gaps produced
by that union are filled so the hard boundary does not cut trail connections
between included systems. Its exact bbox is:

```text
[-121.73319523634241, 47.19654585917808, -120.5276988, 48.4758823]
```

This is not a county, watershed, national-forest administrative boundary, or
rectangular download extent. Boundary-crossing trail edges, components,
cycle-bearing portals, and neighboring-pack overlap must be reviewed before
activation.

## Explicit exclusions

- Exclude North Cascades National Park complex, the Baker/Highway 20 systems,
  and Pasayten/Methow networks; those belong to the future North Cascades pack.
- Exclude Mount Rainier, Norse Peak/Naches/White Pass, and Goat Rocks; those
  belong to the future Rainier–Goat Rocks pack.
- Exclude Mount St. Helens, Mount Adams, and southern Gifford Pinchot; those
  belong to the future Southwest Cascades pack.
- Exclude disconnected Puget Sound lowland trail systems and the Columbia
  Basin. Roads retained around public approaches are build-time portal context,
  not hiking coverage.

An extracted trail touching a seam is a review trigger, not permission to grow
the pack. Extend a seam only when current authority evidence and component
inspection show that an included loop-capable network would otherwise be cut.

## Reviewed search regions

The following relations were verified against live OSM metadata on 2026-08-10
and predate the pinned 2026-08-06 Washington extract:

| Candidate | OSM object | Verified metadata | v1 decision |
| --- | --- | --- | --- |
| Glacier Peak Wilderness | `relation/6115914` | version 14, `2025-02-03T23:34:11Z` | Retain with the shared 500 m named-region approach band. Nearest default-eligible portals measured 49 m, 51 m, 85 m, and 219 m outside the legal boundary. |
| Alpine Lakes Wilderness | `relation/6112652` | version 19, `2025-02-03T23:34:11Z` | Retain with the same shared rule. Numerous default-eligible portals measured 91–489 m outside the legal boundary. |
| Teanaway Community Forest | `relation/6437099` | version 17, `2023-08-04T01:35:02Z` | Retain: 22 default-eligible derived portals fall inside the polygon. |

The v1 selectors are therefore the whole pack, Glacier Peak Wilderness, Alpine
Lakes Wilderness, and Teanaway Community Forest. The approach band is shared
runtime behavior for every reviewed named region; it is not custom geometry or
a Central Cascades exception. It applies only to derived trail portals and does
not relax drawn-area or drive-time geometry.

This remains a measured limitation: straight-line proximity to a legal boundary
does not prove that a portal's trail enters the named area, and a legitimate
approach farther than 500 m remains excluded. Every selector is therefore
reviewed against its portal distribution. A future topology-aware association
should replace proximity with evidence that the portal's trail network reaches
the named area. Napeequa/Chiwawa, Icicle/Enchantments, Snoqualmie, and Cle Elum
remain scenario clusters; do not publish narrower selectors until a stable
named polygon passes the same access and cycle checks.

## Representative scenario anchors

`scenarios.json` covers eight required clusters: east Glacier Peak/White River,
Chiwawa/Spider Meadow, west Glacier Peak, Stevens Pass, Icicle/Enchantments,
Snoqualmie/Alpine Lakes, Cle Elum/Salmon la Sac, and Teanaway. Coordinates are OSM trailhead
or trail-system review anchors, not independently created starts. Each must
resolve to a generic derived portal within 500 m before activation. Every
cluster has a broad plausible exact request and a deliberately impossible gain
request over the same plausible distance range; it must remain a labeled close match rather than silently
relaxing constraints. The remote scenarios allow up to 55 percent repeated
trail, except for North Fork Sauk whose measured minimum stem is 14.0 km; that
backpacking-scale lollipop allows 80 percent.
These scenario-specific limits do not change the product default or relax
constraints silently.

Little Giant Trailhead remains a default-eligible Glacier Peak selector portal
39.6 m from its scenario review coordinate and 85 m outside the legal wilderness
boundary. It reaches a cycle in the compiled topology, but the current solver
returned no closed-route candidate before exhausting the Thorough 40,000-edge
and 500,000-state limits. It remains available to users and is retained in
portal review, but it is not misrepresented as a passing exact-route scenario.

## Sources, dates, and licensing

### OSM topology and runtime evidence

Use the pinned Geofabrik Washington extract `washington-260806`, upstream
`2026-08-06T20:21:21Z`, 360,317,339 bytes, under ODbL 1.0. OSM is the sole
topology baseline and supplies access tags, trailhead and parking evidence,
buildings, and named areas. Preserve OpenStreetMap contributor attribution and
the required derived-database offer/license material for distribution.

### Elevation

Use USGS 3DEP 1/3 arc-second elevation, nominally 10 m, NAD83/NAVD88, a U.S.
public-domain source. The official National Map query was reviewed on
2026-08-10 using the exact bbox and `1 x 1 degree` extent. Pin the latest catalog
revision returned for each intersecting tile:

- `n48w121`: `689d4591d4be027ac1589940`
- `n48w122`: `689d4591d4be027ac158993e`
- `n49w121`: `689d4591d4be027ac158993a`
- `n49w122`: `689d4590d4be027ac1589938`

Use the region-unique `central-cascades-elevation` collection namespace while
allowing the immutable raw-product cache to be shared.

### Official review-only inputs

- USDA Forest Service National Wilderness Areas and administrative/ownership
  layers were reviewed on 2026-08-10 from
  `https://data.fs.usda.gov/geodata/edw/datasets.php?xmlKeyword=wilderness`.
  The clearinghouse reported a 2026-06-28 wilderness refresh. USFS data is a
  U.S. government work; retain source attribution and metadata. These layers
  review pack seams and completeness only and are not merged as topology.
- USFS National Forest System Trails and Recreation Sites are completeness and
  naming checks only. Attribute depth varies by forest; official linework must
  not be merged automatically into the graph.
- Washington DNR's Teanaway Community Forest page, management plan, recreation
  plan, and map were reviewed on 2026-08-10 at
  `https://www.dnr.wa.gov/Teanaway`. DNR material validates scope and portal
  names only. Do not redistribute or import it until a source-specific license
  review is complete.
- NPS North Cascades boundary material was reviewed only to confirm the northern
  exclusion. NPS material is a U.S. government work unless separately credited;
  it is not a runtime input.

Do not scrape live alerts or encode temporary wildfire, snow, seasonal-road, or
same-day closure conditions in this static pack. Only a durable, reviewed
restriction with source URL, review date, content hash, and exact OSM way IDs
may later become an authority removal. No such restriction is asserted in v1.

## Activation evidence

Before adding `packId` to the catalog entry, run the generic preflight and two
independent offline builds from the pinned sources. Require byte-identical
manifest, SQLite, and audit outputs; schema 6; zero audit, integrity,
provenance, coverage, and elevation-profile errors; no published road context;
reviewed portal/building/cycle distributions; and no directed-validation
rejections. Each major cluster must return an exact route for its plausible
scenario and an honestly labeled close match for its impossible scenario.

Generated packs, raw downloads, caches, collection receipts, databases, and
audit artifacts remain ignored and must never be committed.
