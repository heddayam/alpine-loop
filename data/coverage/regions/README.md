# Pinned hiking-area boundaries

The twelve Washington boundary files are static download groupings. GMBA's named
ranges organize the mountain areas; EPA landscape regions allocate the remaining
lowlands and margins. Their union preserves the complete previous Washington
start footprint, including historical approach neighborhoods. These organizational
outlines are deliberately broad. The separate [GMBA Standard terrain mask](../hiking-terrain.md)
filters sparse entrance candidates through actual trail connectivity, preserving
connected valley approaches without treating all surrounding lowlands as mountain
terrain. County membership, forest ownership and internal download borders do not
grant access or clip routes. California's four download entries are unchanged.

## Sources and attribution

- **GMBA Mountain Inventory v2.0, broad basic ranges**, WGS84, reviewed
  2026-09-29. [Official dataset](https://www.earthenv.org/mountains),
  [pinned archive](https://data.earthenv.org/mountains/broad/GMBA_Inventory_v2.0_broad_basic.zip),
  42,672,594 bytes, SHA-256
  `638bae59339fb45ffe190079aa2fabdcd1d05fd00353863e9509bd7b16004ae0`.
  CC BY 4.0. Cite Snethlage et al. (2022),
  [GMBA Mountain Inventory v2](https://doi.org/10.48601/earthenv-t9k2-1407) and
  [A hierarchical inventory of the world's mountains for global comparative mountain science](https://doi.org/10.1038/s41597-022-01256-y).
  The broad inventory includes surrounding landscape and support polygons. Here
  it supplies organizational extents, not a claim that every included location is
  mountainous. Basic records are selected through their `Path_ID` ancestry.
- **EPA Washington Level III Ecoregions**, metadata date 2012-05-08, public domain.
  [Pinned archive](https://dmap-prod-oms-edc.s3.us-east-1.amazonaws.com/ORD/Ecoregions/wa/wa_eco_l3.zip),
  [metadata](https://dmap-prod-oms-edc.s3.us-east-1.amazonaws.com/ORD/Ecoregions/wa/wa_eco_l3.htm),
  1,175,130 bytes, SHA-256
  `e665f5a691b006feaf0c2d0ec8394c4e6d03de127267a21e054ae5bec4e6dae3`.
  Source NAD83 Albers coordinates were transformed to EPSG:4326 using pyshp 3.1.6
  and pyproj 3.8.0.
- **Preserved statewide obligation**:
  `data/fixtures/coverage/washington-start-coverage.geojson`, the union of the
  twelve effective Washington start footprints at commit `8e95bc3`. Its source
  is the Census 2025 statewide boundary plus retained historical OSM/USFS
  footprints and approach neighborhoods. Census and USFS sources are public
  domain; OSM-derived boundaries retain ODbL 1.0 attribution. This fixture is a
  regression baseline, not a runtime county registry. Each boundary records its
  SHA-256 and attribution. Historical mountain inputs' properties and hashes are
  also embedded in their successor boundary files.

## Range grouping

IDs below include descendants, except for the stated exclusions. Each boundary
also pins the actual selected leaf IDs, names and full ancestry, so the inputs
remain inspectable without downloading the source.

| Download ID | GMBA ancestry / leaf selection |
| --- | --- |
| `central-cascades` | 16955, 16974, 16943, 16946, 17011 except 17017, 17039; plus 17032, 17036, 17038 |
| `north-cascades` | 15510, excluding the Central selection |
| `rainier-goat-rocks` | 17022, 17020, 17031, excluding 17032, 17034, 17036, 17038 |
| `southwest-cascades` | 17019, 17021, 17030 |
| `olympic-peninsula` | 11688 |
| `willapa-hills` | 17206 |
| `northeast-washington` | 16165, 11635, 11830 |
| `blue-mountains` | 12545 |
| `spokane-palouse` | 16228, 16229, 16230, 16243 |
| `columbia-basin` | 16216, 16224 |
| `north-puget` | 17153, 17155, 17156 |
| `south-puget` | 17203, 17204, 17017, 17034 |

## Reproduction and coverage checks

1. Read the selected GMBA basic polygons and group them as above. Union the
   pre-county North, Central, Rainier, Southwest and Olympic boundary geometries
   and their unchanged reviewed approach neighborhoods into their respective
   groups. The retained inputs are identified in each file's `retainedFootprint`.
   Approach circles use the existing 32-vertex spherical calculation, 500 m by
   default and 600 m for the reviewed Heather approach. Clip every group to the
   complete statewide obligation.
2. Subtract that aggregate from the obligation. Intersect the remainder with EPA
   `US_L3CODE` polygons: 1 (Coast Range) goes to Olympic north of 47 degrees and
   Willapa south of it; 2 (Puget Lowland) goes to North Puget north of 47.6 degrees
   and South Puget south of it; 10 goes to Columbia Basin; 11 to Blue Mountains;
   15 and 77 to Northeast Washington; 3, 4 and 9 to Southwest Cascades. The last
   three residuals occur in the south. Divider lines belong to both closed
   intersections; they organize downloads and never exclude starts.
3. Assign each remaining connected part outside EPA to the nearest resulting
   group, measured from its representative point in EPSG:5070 using GEOS distance;
   break exact ties by ascending download ID. This repairs source shoreline and
   state-edge differences, not mountain classification: 1,400 parts totaling
   0.020504108813109795 square degrees. Per-file counts and areas are pinned.
4. Use a robust polygon overlay implementation during authoring (these files used
   Shapely 2.1.2/GEOS). Normalize the valid raw derived geometry with an outward
   buffer of 3e-7 degrees, mitre joins and `mitre_limit=2`, **then** topology-preserving
   valid-output `set_precision` on a shared 1e-7-degree grid. Buffering first keeps
   thin input pieces before quantization. This follows the established
   [GEOS precision-reduction approach](https://libgeos.org/doxygen/classgeos_1_1precision_1_1GeometryPrecisionReducer.html)
   for [finite-precision overlay failures](https://locationtech.github.io/jts/jts-faq.html#D3).
   It is one authoring policy for all twelve outlines, not runtime smoothing or a
   new dependency. Each boundary pins compact-JSON raw and final geometry hashes
   and the measured effect under `authoringPrecision`.
5. Require every output to pass `assertValidAreaGeometry`, and compare complete
   polygons rather than vertices or bounding boxes. All twelve outputs contain
   their raw inputs and lie within an 8e-7-degree buffer of them (less than 0.09 m
   using the conservative latitude conversion). The largest measured output-vertex
   distance from raw geometry is 7.226436178839424e-7 degrees. Final aggregate
   missing area against the statewide obligation is zero; added area is
   1.4937681813483016e-5 square degrees, distributed along the boundary. This tiny
   outward allowance is far below the source map scale and avoids false holes
   from mixed-source numerical precision. Runtime polygon union and baseline
   containment both succeed. Preserve the historical Central/pilot footprints,
   all reviewed approach neighborhoods and the four California effective-footprint
   hashes. Plan all sixteen areas offline to check source coverage and US-only
   exclusions.

Historical footprints can overlap neighboring groupings. They are deliberately
retained; the files do not claim a disjoint tessellation or legal access rights.
Source boundaries have scale and vintage limitations and do not prove every
trail is mapped. Boundary area alone does not predict build time or pack size:
those require real-data builds and depend on the buffered rectangle, trail
network and source preparation. Raw archives and temporary authoring tools are
not committed.
