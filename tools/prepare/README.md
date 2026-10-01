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
a conventional node-in-box extract would miss those. Retained ways, nodes,
corridors and elevation sample coordinates are materialized for the whole
footprint. Memory grows with that footprint: partitioning the result does not
make this a bounded-memory statewide compiler.

Temporary Osmium intermediate files are removed, and
the final directory appears only after all elevations and outputs are ready.
The fixture runs the actual Osmium → OPL → topology → bilinear DEM → graph
pipeline on a tiny offline source and a synthetic planar raster.
It also exercises the CLI publication, role transitions, boundary identities,
cross-cell discovery, complete endpoint/direction copies and deterministic file
hashes. It makes no network requests.

## Source decisions

- Linear `path`, `footway`, `bridleway`, `steps`, `track`, `pedestrian` and
  `cycleway` ways are candidates. `area=yes` perimeters and ways explicitly
  tagged disused, abandoned, construction or proposed are excluded.
- Other roads provide entrance context. Only roads belonging to a mapped
  hiking/foot route relation become hiking connectors. Road membership alone
  never overrides a foot-access prohibition.
- Admitted explicit roads and `footway=sidewalk/crossing` carry the `connector`
  role. Other admitted paths carry `trail`. This is a candidate classification,
  not proof of a recreational hike. An explicit connector wins if duplicate
  source ways classify the same physical segment differently; the audit retains
  each source classification. Admission and access permissions remain separate.
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
- Naming priority does not choose access evidence. An untagged named trailhead
  retains applicable public permission from its mapped parking; restrictions
  on the node still apply.
- A parking-only boundary contact directly attached to the same named trailhead
  can be a redundant start. Suppress it only when both are consecutive vertices
  on that parking polygon and an uninterrupted, bidirectionally public source
  trail. The contact must have degree two, no barrier, no other access source,
  and the same start permission. Distinct exits and named trailheads remain.
  All trail geometry stays intact; the audit records each suppressed contact.
  There are no proximity thresholds, inferred connectors or routing shortcuts.

Source node identities join paths. Duplicate consecutive source-node segments
are one physical segment, with conservative permission combination and all
source references retained. Ways are clipped only at the declared source
rectangle, preserving interior vertices; generated boundary endpoints are
frontiers and never starts. Generated frontier identities include the exact
clipping fraction, so changing the source rectangle does not reuse an identity
for a different endpoint. Degree-two corridors are collapsed, retaining
junctions, starts, barriers, permission and role transitions, and an anchor on
isolated rings. No source geometry is simplified.

## Elevation and output

Coordinates are transformed into the raster CRS and sampled from the four
surrounding pixel centers with bilinear weights. Samples include every retained
source/boundary vertex plus intervals no longer than 25 m. Any missing or masked
sample fails compilation. Gain and loss sum positive/negative sample changes;
there is no per-delta suppression or smoothing threshold. These are DEM
estimates: noise can inflate gain, and accuracy/current conditions are not
certified. All sampled elevations stay in the drawing/GPX geometry, so it
represents the same profile used for gain.

One snapshot is compiled and compacted **before** storage partitioning. Numeric
node, edge, section and start IDs are indexes in that snapshot's original arrays;
they must never join records from different snapshots. Geographic cells are
storage addresses, not independently compiled hiking regions.

`manifest.json` follows `src/data-format.ts`: version 2, cell size 0.1 degrees,
`haversine-6371008.8` distance metric, copied dataset metadata, and each runtime
file's compressed bytes, decoded JSON bytes and SHA-256. Dataset identity hashes
the verified source manifest, Osmium version, actual compiler/policy files,
metadata and emitted file evidence. The old input label is not reused as an ID.
JSON keys/files are sorted; gzip omits filenames, timestamps and platform headers.

- `graph/<floor(lon*10)>_<floor(lat*10)>.json.gz` holds complete physical sections,
  their names/roles/directed facts and endpoint coordinates. Each section appears
  in every cell intersected by its complete geometry's bounding box. Readers
  deduplicate IDs and exact-filter bounds; no section is clipped at a cell edge.
- `starts/<cell>.json.gz` holds start facts and coordinates once, in their point's
  cell. Starting-area selection does not require loading graph or geometry.
- `geometry/<cell>.json.gz` holds each complete sampled corridor once, owned by
  the cell containing its bounding-box midpoint. Reverse traversal uses the same
  geometry in reverse. Role is also retained here for preparation inspection.

An absent file inside the advertised processed footprint is empty for this
snapshot. A declared but missing or corrupted file is an error. Outside the
footprint, coverage is unknown. The CLI builds a fresh staging directory and
renames it only after all runtime and audit files are complete.

`audit/graph.json.gz` and `audit/geometry.json.gz` preserve complete arrays for
source replay. `audit/source-index.json.gz`, `audit/audit.json.gz` and
`audit/provenance.json` retain source lineage/classification, frontiers, unmatched
POIs, verified source hashes/URLs, compiler identity and build observations.
These files are excluded from the runtime manifest. There is no old runtime
format compatibility layer.

The independent Little Si proof in `benchmarks/fresh-north-bend` describes the
earlier whole-file `fresh-north-bend-v2` build. Its counts, file sizes, identities
and timing are historical evidence, not measurements of this network writer.
The broader ignored Cascades experiment likewise is not delivered coverage.
