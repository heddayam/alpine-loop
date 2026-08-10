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

| Search region | OSM object | Verified object version and timestamp |
| --- | --- | --- |
| Glacier Peak Wilderness | `relation/6115914` | version 14, `2025-02-03T23:34:11Z` |
| Alpine Lakes Wilderness | `relation/6112652` | version 19, `2025-02-03T23:34:11Z` |
| Teanaway Community Forest | `relation/6437099` | version 17, `2023-08-04T01:35:02Z` |

The whole pack is also required. Publication of each selector still requires
at least one in-coverage derived portal that reaches cycle-bearing topology.
Napeequa/Chiwawa, Icicle/Enchantments, Snoqualmie, and Cle Elum remain scenario
clusters only: do not publish selectors for them until a stable named OSM
polygon is verified in a future pinned snapshot and passes portal/cycle checks.

## Representative scenario anchors

`scenarios.json` covers eight required clusters: Little Giant/High Pass,
Chiwawa/Spider Meadow, west Glacier Peak, Stevens Pass, Icicle/Enchantments,
Snoqualmie/Alpine Lakes, Cle Elum, and Teanaway. Coordinates are OSM trailhead
or trail-system review anchors, not independently created starts. Each must
resolve to a generic derived portal within 500 m before activation. Every
cluster has a broad plausible exact request and a deliberately impossible
gain request that must remain a labeled close match rather than silently
relaxing constraints.

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
