# Mountain preparation

This maintainer pipeline creates complete, independent mountain sections. Hikers
download prepared files through the application; they never process OSM, acquire
DEMs, install Python, or configure a source catalog.

GMBA Mountain Inventory v2.0 **standard, 300 selected ranges** supplies the outer
mountain footprint. A named inventory ID is intersected with the published
Census state outline, transformed into WGS84. The GMBA polygon is not simplified,
and no custom terrain classifier or per-hike mountain-core test is added.

## Run

Requires Osmium CLI, Python 3.12+, and the pinned packages in `pyproject.toml`.

```sh
uv run --project tools/prepare python tools/prepare/build.py plan \
  --source-root .cache --output .local-data/cascades-plan.json

uv run --project tools/prepare python tools/prepare/build.py build \
  --source-root .cache --plan .local-data/cascades-plan.json \
  --output .local-data/mountains
```

The default builds every ready section. Use `--section mountain-ID-FROM-PLAN`
to compile a small real slice first; other sections remain visibly unprepared.

`sources.json` pins the GMBA inventory, Washington OSM snapshot, Census state
outline, USGS 3DEP products, and explicit border elevation supplements by HTTPS
URL and full SHA-256. Missing
sources download into the cache atomically; changed or incomplete downloads fail
verification. Planning needs only the first three sources. Building verifies and
loads the pinned elevation products intersecting each requested section.
Uncovered or masked samples in both primary and supplemental products fail the
entire build; no zero elevations or silent partial graphs are emitted.

To add a range, select its `regionId`, supported `state`, source pins, and name in
a source manifest and pass `--manifest`. Omit `candidateRefs` to discover numbered
major road corridors automatically. For the Cascades it restricts discovery to
the five reviewed candidates: I-90, US-2, SR-20, SR-410 and US-12. The committed
DEM pins cover the Washington Cascades footprint, including the southern,
eastern and international-border tiles. Ten border samples lack valid 3DEP
pixels; three explicitly pinned Copernicus GLO-30 tiles supply these gaps only.
Valid primary pixels are never replaced. Copernicus is a coarser surface model;
vegetation and vertical-datum differences can affect climb at source transitions.
The app discloses this, and every section audit counts supplemental samples.
Other ranges require their own verified
intersecting products. The current source manifest is not a promise of
complete statewide prepared coverage.

## Size and highway policy

A native Osmium pass embeds source node locations. Planning streams candidate
consecutive source segments into a temporary SQLite spatial index. Counts use
exact prepared polygon intersections and do not construct statewide trail
topology. A source segment counts once per source way, regardless of admitted
walking direction; duplicate source ways and unresolved node barriers make the
count conservative. Road connectors are included, and compression into
degree-two corridors has not occurred.

The default limit is **700,000 candidate source segments**, adjustable with
`--max-segments`. This conservative capacity policy is measured against real Cascades compilation
and whole-app memory. It is a proxy, not a guarantee of search duration or memory
for arbitrary future data; new sources should be measured before publication.

- A region under the limit remains whole, even when major highways are present.
- Only actual, source-connected numbered mainlines of motorway/trunk/primary
  roads are candidates; ramps are excluded. Road relations preserve numbered
  membership when an individual way lacks its reference.
- Interstates have first priority. They cut only a currently oversized section.
  Other major numbered roads are then chosen by exact subset enumeration to
  minimize the number needed. A road can become a genuine divider when another
  selected highway supplies its end boundary; applicability is retried.
- A cut must actually split the current polygon. Missing road links are never
  extended or snapped across gaps. One real connected carriageway represents a
  divided road, preventing median sliver downloads.
- Disconnected GMBA patches remain grouped as logical sides of the divider.
  Cuts preserve the complete polygon union and disjoint interiors, including
  holes. Sections still over the limit are explicitly unresolved.
- More than twelve candidate lower-tier through corridors require an explicit
  candidate selection, rather than an unbounded combinatorial planning run.

## Compilation and hard boundaries

Only one planned section's source context and topology are retained at a time,
before elevation processing. Exact polygon clipping catches sparse segments
whose original vertices both lie outside, and cannot bridge holes or separated
mountain patches. Original OSM node identities join trails; coordinate proximity
never invents a connection. Duplicate source node pairs retain conservative
permissions and roles, including at clipped boundaries.

Selected highways are **hard hiking boundaries at every grade**. Crossing
bridges and tunnels are clipped geometrically, and the selected highway has no
walking edges even if OSM grants foot access. Generated frontier nodes never
become starts. Real mapped starts on a divider remain independently selectable
on each side, with section-local graph identities that cannot reconnect sides.

The existing pedestrian access rules remain: specific foot permissions override
generic access; explicit prohibitions are excluded; uncertainty is retained and
labeled. Motorways, motorway links and `motorroad=yes` need affirmative
pedestrian-specific permission in each admitted direction. Vehicle one-way tags
do not invent walking restrictions. Tracks and explicit sidewalks/crossings are
road connectors, independently of their names or foot permissions. Mapped
parking and trailhead contacts use shared source nodes; no nearest-trail
connection is invented.

Road-contact starts resolve car access in the order `motorcar`, `motor_vehicle`,
`vehicle`, `access`, including directional restrictions. An explicit vehicle
prohibition cannot be overridden by `foot=yes`. Non-current roads cannot supply
arrival evidence. Parking POIs must admit both walking and car arrival; unknown
arrival remains unknown. Independent eligible roads or parking at the same node
can still establish a start. Named trailheads retain their mapped source evidence.
Vehicle-closed roads remain in the walking graph when foot access allows them;
any approach walked along them counts against the route's road/distance limits.
This is mapped arrival evidence, without a driving reachability or parking service.

DEMs are sampled bilinearly at every retained vertex and at intervals of at most
25 m. All positive/negative changes contribute to gain/loss without suppression.
The same complete sampled profile is retained in drawing/GPX geometry. Missing
pixels are never replaced by nearest-pixel extrapolation or flat terrain.

## Output and evidence

`catalog.json` follows `src/data-format.ts`. Each built section declares its exact
boundary, source count, start count, and three complete gzip files:

- `sections/<section.id>/graph.json.gz`: section-local nodes, directed edges,
  starts, and physical trail/connector names and roles.
- `sections/<section.id>/starts.json.gz`: start facts and coordinates, permitting
  start selection without loading graph topology.
- `sections/<section.id>/geometry.json.gz`: full measured corridor geometry,
  indexed exactly like that section's graph.

Every file declares compressed/decoded sizes and SHA-256. IDs incorporate pinned
sources, compiler/policy evidence, and exact section geometry. JSON and gzip
outputs are deterministic. There are no replicated geographic cells, cross
section graph joins, or old format adapters.

The final directory is published only after every requested section succeeds.
The catalog includes truthful unavailable polygons/reasons for unbuilt or
unresolved sections; these have no fictional download files.
`provenance.json` records the plan, counts, elapsed time, and process RSS high-water
marks, plus Python/geospatial library versions. `--audit` additionally retains compressed source lineage and unmatched POIs.

Offline checks use small generated source inventories, native Osmium, and a
synthetic planar DEM; they make no network requests:

```sh
uv run --project tools/prepare python tests/data/fresh_compile.py
uv run --project tools/prepare python tests/data/partitions.py
```

To produce a downloadable release, pass `--base-url https://your-data-host/release/`
to `build`, then publish its catalog and `sections/` directory together. Pin the
catalog URL and SHA-256 in `scripts/data-release.json`; launch fetches that small
catalog and the app downloads complete sections on request. Local builds omit
the URL and use their complete files directly. Public publication is pending.
