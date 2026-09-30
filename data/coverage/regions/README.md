# Pinned Standard mountain cores

[`catalog.json`](catalog.json) selects named GMBA Standard Basic leaf IDs from one
shared [`mountain-ranges.geojson`](../mountain-ranges.geojson) FeatureCollection.
Each leaf retains its full source extent, official ID, name and complete `Path_ID`
ancestry. The catalog's explicit `rangeIds` are the selection authority; an ancestry shorthand
must not replace them. For example, Central Cascades includes the Wenatchee
Mountains descendants, including Stuart Range (17043, ancestor 17039).

`CoverageRegion.geometry` is the union of selected Standard leaves intersected with
the base product cap and recipe support. Historical approach neighborhoods only
expand the start-nomination limit, never the core. The same full leaf can serve
different product territories; the source dataset is never permanently clipped
to the currently offered territory. Reviewed approaches remain audit anchors.
The previous Broad outlines, EPA lowland allocations, retained
historical mountain footprints and separate dissolved terrain mask are removed.
This intentionally contracts the core and does not promise the former coverage.
Aliases remain useful names; they do not assert that a new core fully replaces a
historical pilot pack.

## Source and attribution

- **GMBA Mountain Inventory v2.0, Standard Basic**, WGS84, retrieved 2026-09-29.
  [Official dataset](https://www.earthenv.org/mountains),
  [pinned archive](https://data.earthenv.org/mountains/standard/GMBA_Inventory_v2.0_standard_basic.zip),
  39,330,067 bytes, SHA-256
  `91b7a37e4331cea01fb8938d535d0fbfcec8aae4173e4b073e46e2896b74f198`.
  [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Derived by leaf selection
  and coordinate quantization, then clipped by the region loader; no endorsement
  implied. Cite Snethlage et al.
  (2022), [GMBA Mountain Inventory v2](https://doi.org/10.48601/earthenv-t9k2-1407)
  and [A hierarchical inventory of the world's mountains for global comparative
  mountain science](https://doi.org/10.1038/s41597-022-01256-y).
- The shared FeatureCollection pins the archive and shapefile byte lengths and
  SHA-256 hashes, citations, authoring parameters and measured precision effect.
  Pack provenance uses `gmba-standard-v2` with the entire parsed FeatureCollection's
  content hash. Its exported `source.dataset` includes both citations and the
  modification credit. `region-boundary-<id>` separately hashes the leaf selection and
  base cap input; `region-approaches-<id>` hashes the audit anchors and their radii.
  Core provenance is independent of approach registration neighborhoods.

## Product scope and selected leaves

Washington uses one shared start limit:
[`washington-start-coverage.geojson`](../../fixtures/coverage/washington-start-coverage.geojson),
intersected with the recipe's
[`washington-us-limit.geojson`](../washington-us-limit.geojson). The first fixture
preserves the state product scope, derived from Census 2025, historical OSM/USFS
footprints and approach neighborhoods. It is a cap on eligible start nomination,
not an instruction to include all its lowlands. Census and USFS material is public
domain; OSM-derived scope retains ODbL 1.0 attribution. The US limit follows the
International Boundary Commission source pinned in that file. The loader clips
selected full leaves to this scope. Route-support buffers may
extend into Oregon or Idaho; eligible Washington starts remain within the cap.

California keeps the four original `data/regions/<id>/boundary.geojson` files
unchanged. Their historical reviewed approach neighborhoods remain part of each
start-limit cap (32-vertex spherical circles, original radii), preserving the
exact former effective-footprint hashes. Each core is the selected Standard
leaves intersected with the original base boundary, without approach neighborhoods.
A shared Diablo Range leaf does not extend East Bay or Henry Coe into one
another's full footprint; no Bay region expands into
the North Bay. Each California entry currently supplies its original file through
`startLimitPath`; entries without this field use the catalog's shared
`startLimitPath`. The loader has no state-name or fixed-region special cases.
A per-region cap retains its historical approach neighborhoods through the shared
`entranceNeighborhood` calculation; the statewide cap already includes them.

### Washington hiking districts

Washington uses the eleven region names offered by WTA's
[Trailblazer app](https://www.wta.org/our-work/about/trailblazer-mobile-app) and
[Hiking Guide](https://www.wta.org/go-outside/hikes), reviewed 2026-09-29. These
are independently downloadable hiking districts with explicit whole-leaf
assignments, not copied WTA boundary polygons or imported WTA hike records.
WTA's names and representative trailhead classifications inform the organization;
the pinned GMBA leaves, product cap and connected-approach policy remain the
coverage authority. The catalog lists Washington in alphabetical district order;
the four California entries retain their exact former definitions.

| Download ID / name | Standard leaves | Reviewed anchors | Assignment from the former catalog |
| --- | ---: | ---: | --- |
| `central-cascades` / Central Cascades | 12 | 16 | Chelan, Entiat, Stevens Pass, Wild Sky, Chiwaukum and Wenatchee/Stuart leaves retained from Central Cascades |
| `central-washington` / Central Washington | 10 | 0 | Columbia Basin except Columbia Hills; West Manastash–Umtanum and Mission–Naneum from Central Cascades |
| `eastern-washington` / Eastern Washington | 15 | 0 | Northeast Washington, Spokane–Palouse and Northern Blue Mountains |
| `issaquah-alps` / Issaquah Alps | 1 | 0 | Issaquah Alps from Central Cascades |
| `mount-rainier-area` / Mount Rainier Area | 10 | 8 | Rainier–Goat Rocks except Goat Rocks |
| `north-cascades` / North Cascades | 39 | 17 | Former North Cascades plus thirteen Glacier Peak/Mountain Loop leaves from Central Cascades |
| `olympic-peninsula` / Olympic Peninsula | 20 | 9 | Former Olympic Peninsula selection unchanged |
| `puget-sound-and-islands` / Puget Sound and Islands | 4 | 0 | San Juan Islands plus Seattle–Everett, Capitol Hills and Kitsap Peninsula from the former two Puget groups |
| `snoqualmie-region` / Snoqualmie Region | 6 | 3 | Chikamin–Keechelus, Kachess, North–Middle Forks Snoqualmie, Snoqualmie Pass North, Cedar River–South Snoqualmie Pass and Teanaway from Central Cascades |
| `south-cascades` / South Cascades | 3 | 9 | Goat Rocks, Mount Adams and Mount Saint Helens |
| `southwest-washington` / Southwest Washington | 3 | 2 | Willapa Hills, Columbia Gorge North and Columbia Hills |
| `santa-cruz-mountains` | 1 | 3 | California entry unchanged |
| `southern-east-bay` | 1 | 5 | California entry unchanged |
| `monterey-carmel` | 2 | 10 | California entry unchanged |
| `henry-coe` | 1 | 5 | California entry unchanged |

The thirteen leaves moved into North Cascades are `16956`, `16957`, `16958`,
`16960`, `16975`, `16976`, `16977`, `16978`, `16979`, `16980`, `16981`, `16982`
and `19110`. Every one of the former 123 Washington leaves has exactly one
download-district owner. No leaf or terrain geometry is added, removed or cut
to obtain these districts. All 64 Washington reviewed approach records retain
their exact IDs, coordinates, basis, URLs and radii, assigned once to their
core's district. Indian Heaven's Lemei anchor remains a South Cascades approach
outside the core; an audit anchor never grants admission.

Whole mountain leaves cross access districts, so this grouping cannot reproduce
every WTA trailhead classification. For example, WTA assigns
[Mount Daniel](https://www.wta.org/go-hiking/hikes/mount-daniel) and
[Lake Ingalls](https://www.wta.org/go-hiking/hikes/lake-ingalls) to Snoqualmie,
while the whole Mount Daniel and Stuart leaves belong to Central Cascades here.
[Blanca Lake](https://www.wta.org/go-hiking/hikes/blanca-lake) is Central Cascades
in WTA but lies in the Monte Cristo leaf assigned to North Cascades here.
White River, Phelps Creek and Trinity audit coordinates remain in Central-owned
Wenatchee Ridge/North Entiat leaves even though neighboring Glacier Peak leaves
move north. This explicit proxy avoids invented trail-scale cuts or duplicated
leaf ownership; it is not an assertion that WTA uses GMBA boundaries.

Representative WTA checks also place
[Mountain Loop approaches](https://www.wta.org/go-hiking/hikes/image-lake-via-miners-ridge)
in North Cascades,
[White River](https://www.wta.org/go-hiking/hikes/white-river) in Central Cascades,
[Goat Rocks](https://www.wta.org/go-hiking/hikes/goat-lake-goat-rocks) and
[Indian Heaven](https://www.wta.org/go-hiking/hikes/indian-heaven) in South Cascades,
and [Columbia Hills / Washington Gorge](https://www.wta.org/go-hiking/hikes/she-who-watches)
in Southwest Washington. No WTA text, maps or trail geometry are redistributed.

Aliases describe destinations within a district, not independent narrower
filters or promises that every named destination has an eligible entrance.
Retired download IDs are not aliases or replacement guarantees. The Washington
recipe's historical `reviewedRegionIds` intentionally retain the old `data/regions`
IDs: they locate pinned restrictions and official-trail audit inputs, rather than
defining the new selectable districts. The GMBA inventory, recipes, statewide cap,
eligibility constants and California footprints are unchanged by this regrouping.

The dataset contains 127 distinct leaves: 123 Washington and four California.
Washington selections redistribute the actual named leaf selection from the
previous catalog, restricted to leaves present in Standard and intersecting the
scope. Standard has no record for Whidbey Island Group (17156), Highline-West
Seattle (17034), or Frenchman Hills (16221). Gulf Islands (17153), Christina Range
(16157), Bonnington Range (16184) and Southern Blue Mountains (nn) (19566) have no
positive-area Standard intersection with the Washington scope. These seven IDs
are omitted explicitly, without a Broad substitute.

## Reviewed starting-location gaps

An unavailable starting location can be recorded in a region's
`unavailableApproaches` list without changing its original audit anchor. Each
entry must identify that anchor, the exact recipe source ID and SHA-256, a review
date and a complete human-readable reason. Runtime preparation verifies the pin
against the actual source input. A different snapshot requires a fresh review;
an undeclared missing reviewed start still blocks publication.

South Cascades records two gaps in Washington `washington-260801`
(`sha256:3bea264079e184675aac7d8ab104bff5339b9e3656a36c084f96f616271a0e4e`):

- June Lake Trailhead, parking `way/439071688`: the parking polygon has no mapped
  road or trail node contacts. June Lake Trail meets a service road at
  `node/1601936297`, but that entrance has no mapped trailhead or gate evidence.
- Blue Lake ORV Trailhead, parking `way/716832243`: the parking polygon has no
  mapped road or trail node contacts, and the nearby Valley Trail has no shared
  node with the local access road.

These findings come from the closed, verified normalized source snapshot. The
declarations permit publication with explicit release limitations displayed in
Coverage. They add no connectors or starting locations and do not change
boundaries or eligibility. If a qualifying mapped start exists, it takes
precedence over the declaration and remains available.

## Reproduction and validation

1. Verify the official archive hash and read its root Standard Basic shapefile;
   ignore `__MACOSX` sidecars. The source contains 6,717 records. Read leaf IDs
   from `GMBA_V2_ID`, names from `MapName` and ancestor IDs from `Path_ID`.
2. Select the 127 distinct leaf IDs listed in the catalog and retain each complete
   source geometry, including every polygon part and hole beyond current product
   caps. California's selection contains every Standard leaf with positive-area
   intersection with one of its effective caps. Territory intersection happens
   uniformly in the loader after leaf union, using the base cap and recipe support.
   Adding a region can reuse an existing full leaf ID; extend this pinned dataset
   only when additional leaves are needed.
3. Require valid source and quantized geometries with GEOS. This derivation used
   pyshp 3.1.6, Shapely 2.1.2/GEOS 3.13.1 and pyproj 3.8.0/PROJ 9.8.1. No repairs,
   terrain buffers, simplification or minimum-area filter were needed. Apply
   `set_precision` with `valid_output` at a 1e-8-degree grid, normalize, and orient
   exterior rings counterclockwise and holes clockwise. Keep one MultiPolygon
   Feature per leaf with only `id`, `name` and `ancestry` leaf properties.
4. Check the quantized geometries remain valid. All 186 polygon parts, eight holes
   and 24,947 coordinates survive precision reduction. In a WGS84 Lambert azimuthal
   equal-area projection centered at 43°N, 120°W, the full source union is
   140,063,734,871.7768 m². Its symmetric difference from the quantized union is
   2,399.6691400110726 m² (0.0000017132694213872574%). This is coordinate precision,
   not a claim of survey accuracy. Product cap edges are applied once by the loader.
5. Run the offline region tests. They plan all 15 cores against recipe source
   coverage and country exclusions, check source pins and mountain controls,
   exclude Arlington and Mount Vernon from Central, preserve exact California
   caps, and prevent starts from expanding to Oregon, Idaho, Canada or North Bay.
   A separate test reuses the full Northern Blue Mountains leaf for an Oregon cap
   while the Washington core excludes the same Oregon point. A California anchor
   outside the base cap changes nomination scope but cannot seed a new core island
   or change the core source pin. These tests do not prove that any particular
   approach has a qualifying trail connection.

Standard can omit low foothills, valley approaches and worthwhile low-relief hiking
areas. A reviewed point outside the core is not automatically a failed start: the
runtime may nominate an approach within its cap and require an actual hiking
connection to the core. Conversely, an audit anchor is not an access override.
The pinned state cap also excludes the very northern US Chilliwack approach used
as a route-buffer control; its route-support inclusion is not start eligibility.
These geometries establish neither current access nor route quality. Build cost
and real start retention require separate real-data validation. Raw archives and
temporary authoring tools are not committed.
