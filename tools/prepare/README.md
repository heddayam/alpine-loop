# Fresh source compiler

This is an offline maintainer tool. Users install its prepared gzip files; they
do not need Osmium, Python, raw OSM, DEM tiles, or a database.

The initial source footprint is the explicit rectangle
`[-121.9, 47.4, -121.6, 47.62]` around North Bend. This small slice is intended to prove
the complete data/application path before coverage expands; it is not complete
Washington coverage. No mountain inventory, start-to-mountain
qualification, hiking-distance maximum, road-arrival proof, or reachability
buffer is used. Map selection later filters starts inside this finite graph.

## Reproduce

Requires Osmium CLI and Python 3.12+ with Rasterio 1.4.3. `sources.json` pins the
existing raw Washington OSM snapshot and its one intersecting USGS 3DEP raster
by URL and full SHA-256. `--source-root` resolves their relative file paths. All inputs are
hashed before processing; missing or changed sources fail the build. No source
download or legacy database access occurs.

```sh
python tests/data/fresh_compile.py
python tools/prepare/build.py --source-root /path/to/alpine-loop/.cache --output /path/to/alpine-loop/.local-data/rewrite/fresh-north-bend
```

The output directory must be new. Osmium filters source-wide ways and embeds
their node coordinates. Python streams those ways, retaining only geometries
intersecting the footprint and their access context. This catches sparse
segments crossing the rectangle even when every original node lies outside;
a conventional node-in-box extract would miss those. No statewide Python
node dictionary or statewide runtime graph is constructed.

Temporary Osmium intermediate files are removed, and
the final directory appears only after all elevations and outputs are ready.
The fixture runs the actual Osmium → OPL → topology → bilinear DEM → graph
pipeline on a tiny offline source and a synthetic planar raster.

## Source decisions

- Linear `path`, `footway`, `bridleway`, `steps`, `track`, `pedestrian` and
  `cycleway` ways are candidates. `area=yes` perimeters and ways explicitly
  tagged disused, abandoned, construction or proposed are excluded.
- Other roads provide entrance context. Only roads belonging to a mapped
  hiking/foot route relation become hiking connectors. Road membership alone
  never overrides a foot-access prohibition.
- More-specific pedestrian and directional permissions override generic access.
  Explicit prohibitions and purpose/private access are excluded. Missing or
  unresolved conditional permission remains unknown; a default prohibition
  remains excluded when its conditional exception cannot be evaluated.
- `oneway:foot` and directional foot permissions constrain traversal. Generic
  vehicle one-way tags do not forbid walking back on roads; ambiguous pedestrian
  way direction is marked uncertain. Explicit barrier foot prohibitions block
  passage. Parking-object restrictions do not invent crossing restrictions.
- Mapped trailheads/parking connect only through shared routable OSM nodes.
  Shared road/trail nodes provide uncertain entrances, not certified parking.
  Unconnected or restricted POIs remain in the audit. No nearest-path connector
  is invented, and ordinary road geometry vertices do not become starts.

Source node identities join paths. Duplicate consecutive source-node segments
are one physical segment, with conservative permission combination and all
source references retained. Ways are clipped only at the declared source
rectangle, preserving interior vertices; generated boundary endpoints are
frontiers and never starts. Degree-two corridors are collapsed, retaining
junctions, starts, barriers, permission transitions and an anchor on isolated
rings. No source geometry is simplified.

## Elevation and output

Coordinates are transformed into the raster CRS and sampled from the four
surrounding pixel centers with bilinear weights. Samples include every retained
source/boundary vertex plus intervals no longer than 25 m. Any missing or masked
sample fails compilation. Gain and loss sum positive/negative sample changes;
there is no per-delta suppression or smoothing threshold. These are DEM
estimates: noise can inflate gain, and accuracy/current conditions are not
certified. All sampled elevations stay in the drawing/GPX geometry, so it
represents the same profile used for gain.

`graph.json.gz` is the existing `TrailGraph` contract. `geometry.json.gz` stores
each physical corridor once; reverse edges reference it in reverse order.
`source-index.json.gz`, `audit.json.gz` and `provenance.json` retain original OSM
lineage, frontiers, unmatched POIs, source hashes/URLs, source decisions and
compiler identity. They are preparation evidence, not runtime dependencies.
Graph topology and geometry remain separate because search needs only the
small node/edge facts, while inspection requests geometry on demand. No runtime
storage subsystem or compatibility adapter is required.

## Measured North Bend build

The pinned sources produced 6,203 routing nodes, 6,772 physical corridors,
13,544 directed edges and 1,826 starts. Eleven starts have explicit public
permission; 1,815 remain uncertain. The audit records 85 boundary frontiers and
225 unresolved mapped access POIs. All 81,604 distinct DEM samples were valid;
the geometry contains 88,945 points including shared corridor endpoints.

| File | Compressed bytes | JSON bytes |
| --- | ---: | ---: |
| `graph.json.gz` | 436,842 | 2,085,015 |
| `geometry.json.gz` | 1,638,646 | 4,617,973 |
| `source-index.json.gz` (audit only) | 991,793 | 9,723,885 |
| `audit.json.gz` (audit only) | 32,349 | 272,145 |

An independent check recomputed haversine distances and positive/negative
profile changes for every exported edge, checked geometry endpoints against
routing nodes, unique physical corridor/direction pairs, finite coordinates,
coverage bounds, non-frontier starts and output hashes. The offline fixture
also checks a gradual climb that would disappear under per-delta suppression.
The maintainer build took 39.82 seconds with 260,341,760 bytes peak compiler RSS
on the reference Mac; these are descriptive preparation measurements, not app
resource or search-completion claims.

For example, corridor `osm-corridor:715ba6e78c7e270c0a620fed` on Rattlesnake Ledge
Trail measures 2,816.58 m, with 328.48 m gain and 15.43 m reverse-direction gain
from 182 samples. Discarding rises below 1 m would report only 309.50 m gain.
Corridor `osm-corridor:bafe1802e20f38f0f72add1e` on Snoqualmie Valley Trail
measures 1,477.36 m and gains 3.92 m in its stored direction; every individual
rise is below 1 m. These are individual corridors, not complete named hikes,
and illustrate the measurement definition rather than certify DEM accuracy.

The earlier, broader Cascades experiment remains an ignored research artifact
with its own source manifest in provenance. It is not the delivered footprint.
