# Pinned Standard mountain cores

[`catalog.json`](catalog.json) selects named GMBA Standard Basic leaf IDs from one
shared [`mountain-ranges.geojson`](../mountain-ranges.geojson) FeatureCollection.
Each leaf retains its official ID, name and complete `Path_ID` ancestry. The
catalog's explicit `rangeIds` are the selection authority; an ancestry shorthand
must not replace them. For example, Central Cascades includes the Wenatchee
Mountains descendants, including Stuart Range (17043, ancestor 17039).

`CoverageRegion.geometry` is the union of the selected Standard leaves within the
product scope. Reviewed approaches remain audit anchors; they do not enlarge the
mountain core. The previous Broad outlines, EPA lowland allocations, retained
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
  [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Derived by clipping
  and coordinate quantization; no endorsement implied. Cite Snethlage et al.
  (2022), [GMBA Mountain Inventory v2](https://doi.org/10.48601/earthenv-t9k2-1407)
  and [A hierarchical inventory of the world's mountains for global comparative
  mountain science](https://doi.org/10.1038/s41597-022-01256-y).
- The shared FeatureCollection pins the archive and shapefile byte lengths and
  SHA-256 hashes, scope-input hashes, citations, authoring parameters and measured
  precision effect. Pack provenance uses `gmba-standard-v2` with the entire parsed
  FeatureCollection's content hash. `region-boundary-<id>` separately hashes the
  leaf selection and product cap; `region-approaches-<id>` hashes the audit anchors.

## Product scope and selected leaves

Washington uses one shared start limit:
[`washington-start-coverage.geojson`](../../fixtures/coverage/washington-start-coverage.geojson),
intersected with the recipe's
[`washington-us-limit.geojson`](../washington-us-limit.geojson). The first fixture
preserves the state product scope, derived from Census 2025, historical OSM/USFS
footprints and approach neighborhoods. It is a cap on eligible start nomination,
not an instruction to include all its lowlands. Census and USFS material is public
domain; OSM-derived scope retains ODbL 1.0 attribution. The US limit follows the
International Boundary Commission source pinned in that file. Washington leaves
are clipped to both scope geometries during authoring. Route-support buffers may
extend into Oregon or Idaho; eligible Washington starts remain within the cap.

California keeps the four original `data/regions/<id>/boundary.geojson` files
unchanged. Their historical reviewed approach neighborhoods remain part of each
start-limit cap (32-vertex spherical circles, original radii), preserving the
exact former effective-footprint hashes. Each core is the selected Standard
leaves intersected with its cap. A shared Diablo Range leaf does not extend East
Bay or Henry Coe into one another's full footprint; no Bay region expands into
the North Bay. California is the only catalog scope with a `boundaryPath`.

| Download ID | Selected Standard leaves |
| --- | ---: |
| `north-cascades` | 26 |
| `central-cascades` | 34 |
| `rainier-goat-rocks` | 11 |
| `southwest-cascades` | 3 |
| `olympic-peninsula` | 20 |
| `north-puget` | 1 |
| `south-puget` | 3 |
| `willapa-hills` | 1 |
| `northeast-washington` | 10 |
| `spokane-palouse` | 4 |
| `columbia-basin` | 9 |
| `blue-mountains` | 1 |
| `santa-cruz-mountains` | 1 |
| `southern-east-bay` | 1 |
| `monterey-carmel` | 2 |
| `henry-coe` | 1 |

The dataset contains 127 distinct leaves: 123 Washington and four California.
Washington selections carry forward the actual named leaf selection from the
previous catalog, restricted to leaves present in Standard and intersecting the
scope. Standard has no record for Whidbey Island Group (17156), Highline-West
Seattle (17034), or Frenchman Hills (16221). Gulf Islands (17153), Christina Range
(16157), Bonnington Range (16184) and Southern Blue Mountains (nn) (19566) have no
positive-area Standard intersection with the Washington scope. These seven IDs
are omitted explicitly, without a Broad substitute.

## Reproduction and validation

1. Verify the official archive hash and read its root Standard Basic shapefile;
   ignore `__MACOSX` sidecars. The source contains 6,717 records. Read leaf IDs
   from `GMBA_V2_ID`, names from `MapName` and ancestor IDs from `Path_ID`.
2. Select Washington leaf IDs listed in the catalog, intersect each source
   geometry with the pinned state/US scope, and retain all positive-area polygon
   parts and holes. California selects every Standard leaf with positive-area
   intersection with an effective cap; clip shared California leaves to the union
   of those caps. The loader intersects them with each individual cap.
3. Require valid source and overlay geometries with GEOS. This derivation used
   pyshp 3.1.6, Shapely 2.1.2/GEOS 3.13.1 and pyproj 3.8.0/PROJ 9.8.1. No repairs,
   terrain buffers, simplification or minimum-area filter were needed. Apply
   `set_precision` with `valid_output` at a 1e-8-degree grid, normalize, and orient
   exterior rings counterclockwise and holes clockwise. Keep one MultiPolygon
   Feature per leaf with only `id`, `name` and `ancestry` leaf properties.
4. Check the quantized geometries remain valid. All 180 polygon parts, 11 holes
   and 21,967 coordinates survive precision reduction. In a WGS84 Lambert azimuthal
   equal-area projection centered at 43°N, 120°W, the source clipped union is
   100,169,780,983.73431 m². Its symmetric difference from the quantized union is
   1,477.127103473976 m² (0.000001474623473234741%). This is coordinate precision,
   not a claim of survey accuracy. Do not re-overlay the quantized Washington
   leaves with unrounded cap edges at runtime: that can create numerical slivers.
5. Run the offline region tests. They plan all 16 cores against recipe source
   coverage and country exclusions, check source pins and mountain controls,
   exclude Arlington and Mount Vernon from Central, preserve exact California
   caps, and prevent starts from expanding to Oregon, Idaho, Canada or North Bay.
   They do not prove that any particular approach has a qualifying trail connection.

Standard can omit low foothills, valley approaches and worthwhile low-relief hiking
areas. A reviewed point outside the core is not automatically a failed start: the
runtime may nominate an approach within its cap and require an actual hiking
connection to the core. Conversely, an audit anchor is not an access override.
The pinned state cap also excludes the very northern US Chilliwack approach used
as a route-buffer control; its route-support inclusion is not start eligibility.
These geometries establish neither current access nor route quality. Build cost
and real start retention require separate real-data validation. Raw archives and
temporary authoring tools are not committed.
