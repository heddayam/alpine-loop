# Pinned GMBA hiking terrain

Prepared 2026-09-29 from the official [GMBA Mountain Inventory v2 download
page](https://www.earthenv.org/mountains), using **Standard Basic**. This is a
terrain input for evaluating hiking starts, not a new region boundary, trail
source, or access record. Adoption requires the separate real-start retention
audit; the data alone does not establish that every useful foothill approach is
retained.

## Source and attribution

The source is distributed under [Creative Commons Attribution 4.0
International](https://creativecommons.org/licenses/by/4.0/). Alpine Loop clipped,
dissolved, and quantized its coordinates as described below. Attribution and both
required citations are embedded in the GeoJSON:

- Snethlage, M. A. et al. (2022). *GMBA Mountain Inventory v2*. GMBA-EarthEnv.
  [Dataset DOI](https://doi.org/10.48601/earthenv-t9k2-1407).
- Snethlage, M. A. et al. (2022). *A hierarchical inventory of the world's
  mountains for global comparative mountain science*. Scientific Data **9**, 149.
  [Paper DOI](https://doi.org/10.1038/s41597-022-01256-y).

| Pinned input | Value |
| --- | --- |
| Archive | [GMBA_Inventory_v2.0_standard_basic.zip](https://data.earthenv.org/mountains/standard/GMBA_Inventory_v2.0_standard_basic.zip) |
| Archive bytes | 39,330,067 |
| Archive SHA-256 | `91b7a37e4331cea01fb8938d535d0fbfcec8aae4173e4b073e46e2896b74f198` |
| Shapefile | `GMBA_Inventory_v2.0_standard_basic.shp` |
| Shapefile bytes | 56,850,536 |
| Shapefile SHA-256 | `2873fc766a8255e110ca66cbf4fa9663dd30bcf733c852a1125084c31c0df436` |
| Source CRS / encoding | WGS84 longitude/latitude / UTF-8 |
| Source records | 6,717 |

`properties.source` supplies the shared pack-source fields, including both required
citations and modification credit in its dataset label so exported graphs retain
the attribution. Its review-date
timestamp is pinned to `2026-09-29T00:00:00Z`; `properties.retrievedAt` records the
actual archive retrieval time. The runtime content hash is computed from the
complete derived Feature, independently of the original archive hash.

## Derivation

Read the root-level `.shp`, `.shx`, and `.dbf` members, ignoring the archive's
`__MACOSX` sidecars. Intersect every source polygon with the union of these two
WGS84 support rectangles, in `[west, south, east, north]` order:

| Support envelope | Bounds |
| --- | --- |
| Pacific Northwest | `[-125.5, 41, -115, 49.2]` |
| California | `[-124, 35, -120, 39.5]` |

The rectangles bound this artifact's support; they do not assign ownership to
current regions or expand installed coverage. Keep every positive-area
intersection, without filtering source feature types. The 290 intersecting
source IDs are recorded in the Feature. Dissolve their intersections with GEOS
`union_all`, preserving source holes, small polygons, and included valley/support
areas. All selected source geometries and the dissolved result were valid, so
no repair was applied.

To fit the committed artifact below 1 MiB, apply GEOS `set_precision` in
`valid_output` mode on a **0.00000001-degree grid**. Normalize component/ring
ordering, then orient exterior rings counterclockwise and holes clockwise.
Serialize one compact UTF-8 GeoJSON Feature with a MultiPolygon and a trailing
newline. No geometric simplification, terrain buffer, hole filling, minimum-area
filter, or elevation/relief threshold was applied. Eight decimal places describe
serialization precision, not the source's real-world positional accuracy.

The geometry operations can be reproduced with Python 3.12, pyshp 3.1.6,
Shapely 2.1.2 / GEOS 3.13.1, and pyproj 3.8.0 / PROJ 9.8.1. These were disposable
authoring tools; the application gains no runtime dependency. After parsing the
shapefile into `source_polygons`, the geometry operation is:

```python
support = shapely.union_all([box(-125.5, 41, -115, 49.2),
                             box(-124, 35, -120, 39.5)])
clipped = [g.intersection(support) for g in source_polygons
           if g.intersects(support)]
raw = shapely.union_all(clipped)
rounded = shapely.set_precision(raw, 1e-8, mode="valid_output")
geometry = shapely.orient_polygons(shapely.normalize(rounded),
                                  exterior_cw=False)
```

## Geometry verification

The source union and final artifact both contain **276 polygons, 49 holes, and
36,007 coordinates**, including ring closures. The output is nonempty, valid,
fully inside the support rectangles, and has closed rings with GeoJSON ring
orientation. No polygon or hole disappeared during quantization.

Area differences were measured against the unsimplified clipped source union
in WGS84 Lambert azimuthal equal-area coordinates, using
`+proj=laea +lat_0=43 +lon_0=-120 +datum=WGS84 +units=m +no_defs`:

| Measurement | Result |
| --- | --- |
| Source union area | 412,026,466,206.4211 m² |
| Derived area | 412,026,466,238.7685 m² |
| Area removed by quantization | 3,881.7532 m² |
| Area added by quantization | 3,914.1005 m² |
| Symmetric difference | 7,795.8536 m², approximately 0.0000018921% |
| Measured Hausdorff distance | 0.000692 m |
| Simplification tolerance | 0 m; no simplification |
| Final GeoJSON bytes | 1,005,765 |
| Final GeoJSON SHA-256 | `fd8ddf0d04fa31adc08c6db4f6edf53ff8c43b7a1f9bf8213560a3d5649c047c` |

These are differences from the source geometry, not an accuracy assessment of
the source itself. The final coordinate change is far below the requested
approximately 20 m authoring scale.

## Interpretation limits

Standard follows GMBA's mountain delineation; Broad is a distinct, more
expansive product. The Standard inventory can omit low foothills, gentle coastal
terrain, and low-relief approaches that still support worthwhile mountain hikes.
Its source-included valleys and support polygons remain included here; we did
not impose a new definition. The regional inventory is not a trail-scale terrain
survey. See the [source's extent descriptions](https://www.earthenv.org/mountains)
and the [paper's methods](https://doi.org/10.1038/s41597-022-01256-y).

This artifact covers only the two stated rectangles, not all of California or
the world. Terrain membership establishes neither legal access nor a usable
trailhead. Exact regional coverage, explicit exclusions, mapped hiking
connections, access rules, and the building-sparsity rule remain separate.
Raw downloads and temporary geometry tooling are not committed.
