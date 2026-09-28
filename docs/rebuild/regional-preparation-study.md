# Named regional preparation: design and cost study

2026-09-28; code baseline `33dd23e`. This is a study, not an implemented
replacement or a completed real-data acceptance gate. The active implementation
is still described by [network-design.md](network-design.md).

## Recommendation and decision status

Use recognizable places for build and download selection. Prepare only the
trail graph needed to support the promised starts and route distance, and store
paths between decisions rather than every OSM shape vertex as a graph node.
Reuse source bytes and physical-segment measurements across builds. Connected
components and biconnected blocks remain internal analysis tools.

The lowest-complexity candidate is **independent compact regional artifacts**.
It deliberately accepts some overlap duplication. Shared internal storage is
the alternative if measured duplication remains too expensive; it must not be
chosen merely because the current unpruned representation is large. Renaming
the present boxes, or adding a fourth region registry, would not solve this.

The user specified about **10 minutes for a first useful regional build**, such
as Glacier Peak. This is a target, not a demonstrated runtime. Report end-to-end
time, acquisition time and processing time separately; a warm cache does not
establish cold-build performance. Download granularity (smaller wilderness-sized
areas versus fewer forest-sized areas) is still an open user preference.

The user subsequently confirmed that named areas select trailheads including
approaches (not a requirement that each hike enter the legal wilderness), and
that initial coverage is US-only with the international border shown as a hard
limit. Those decisions are settled; their implementation is not yet complete.

Do not claim this design is final until the unresolved coverage semantics and
the bounded acceptance measurements below have been settled. Research can prove
some reductions safe; it cannot establish an unmeasured regional runtime.

## What the existing evidence says

The user's successful retry, recorded in `.cache/build/status.json`, took
473.98 seconds. It reused work from an earlier interrupted attempt.

| Observation | Evidence / consequence |
| --- | --- |
| Source verification and normalized-cache reuse | 4.42 seconds |
| Opaque preparation interval | 435.44 seconds; metrics, portals, topology and export are not separately timed |
| Subsequent audit/publication interval | 34.05 seconds |
| Prepared physical segments | 406,472 in the completed area receipt |
| Published graph | 625,381,376 bytes installed; 201,645,036 bytes compressed |
| Shared source-cache allocated size | About 6.73 GiB, including previous work; not this region's marginal download |
| Peak successful-build RAM / temporary disk | Not recorded reliably; cannot claim measured headroom |

The advertised start core was about 32 square miles, but its rectangular route
support was about 3,200 square miles. Neither acreage nor the number of catalog
entries predicts work well: trail density, shape-node count, DEM products and
cache state matter.

Specific avoidable costs in the current code:

- `lib/coverage/runtime.ts` reconstructs and hashes staging before looking for
  an artifact receipt. An unchanged build still does considerable work.
- Each missing batch of at most 500 segments launches Python. At 406,472
  segments, an entirely uncached build can require roughly 813 such batches.
  `tools/dem/sample_dem.py` opens every product in the accumulating canonical
  collection and samples coordinates individually.
- `lib/coverage/elevation.ts` acquires products covering the geographic envelope,
  including places with no retained trail samples. Required products should
  follow actual sample ownership after graph pruning.
- Portal analysis repeats inclusive connectivity work and recompiles fixed SQL
  statements. Edge selection is repeated before graph publication.
- `lib/data/prepared-release.ts` audits the new graph, then decompresses and
  audits every catalog artifact again. Publishing N equal-sized areas one at
  a time entails about N(N+1)/2 catalog-artifact audits, besides export audits.
- `lib/coverage/preparation.ts` stops the resource guard without persisting its
  collected measurements. A successful exit does not establish peak usage.

These observations identify work to eliminate; they do not identify how much of
the 435 seconds each operation consumed.

### Bounded measurement of the finished artifact

An isolated read-only copy of published object
`c7e10c5c94f11b90a6fba5ec93595f60c79420118bb9d68c4f22c90df85aae2f`
was inspected after confirming the build had completed and only the app container
was running. No source/cache/live WAL database was opened. The approximately
625 MB temporary copy was removed afterward.

| Graph-only probe | Result |
| --- | --- |
| Original graph | 409,705 nodes; 406,472 physical edges; 807,797 directed edges |
| Conservative seeds | All 4,009 nodes inside `[-121.6,47.75,-121.5,47.85]` |
| Within 25 undirected trail miles of seeds | 11,647 nodes; 11,664 physical edges |
| Physical edges retained | **2.87%**; 97.13% can be omitted for this start core |
| Retained access nodes | 65; these include support-area starts, not only core starts |
| Potential removable shape nodes | 10,957 after preliminary degree/access/flag checks |
| Probe time | 4.924 s: 1.533 s decompression, 3.137 s graph reads, 0.254 s analysis/counting |
| Probe peak process RSS | 137.5 MiB |

Reproduction method (`finished-artifact-network-bound-v1`): decompress the named
object into fresh scratch; check declared raw size and DELETE journal mode; open
with `mode=ro&immutable=1`. Read integer-indexed nodes and one physical edge with
its minimum directed length. Construct compact CSR adjacency, seed every core
node, and run undirected multi-source Dijkstra to 40,233.6 metres. Count edges
with both endpoints inside the bound. The additional
`d(u)+length(edge)+d(v)<=80,467.2` test retained the same 11,664 edges here.

Potential contractions were non-access degree-two nodes whose two incident links
each have two directed traversals and matching access/flags. Subtracting them
would leave roughly 690 nodes/707 edges, **before** ring anchors and complete
metadata/direction checks. These are not valid final graph counts or a measured
compressed artifact size. Full geometry and elevation samples still occupy space.

This probe strongly favors early graph-distance pruning. It uses the finished
artifact's lengths, not a production pre-elevation implementation, and does not
measure Glacier Peak, required DEM tiles, a cold build or route equivalence.

## Alternatives and their full costs

| Design | Build and update cost | Storage and runtime cost | User consequence |
| --- | --- | --- | --- |
| Complete connected networks or BCC downloads | Potentially huge components; source changes can join or split them | Uneven, unbounded units; approaches still needed | A PCT connection can make a local request depend on distant data |
| One entire Cascades graph | Simple coherent analysis, but every first build waits for the whole collection | Least overlap within that graph; large first download and replacement | Weak fit for a ten-minute first useful region |
| Independent compact named regions | Local pruning/topology/export; shared segment metrics; unchanged regions reusable | Overlap duplicated; whole artifact replaced when changed; simple reader/retention | Direct named selection and independently usable downloads |
| Shared canonical graph pieces with named download views | Can reuse base pieces; must separate region-dependent facts and stabilize seams/identities | Least overlap; more dependency, generation, audit and cleanup machinery | Names can remain simple, but shared/removal sizes must be explained accurately |
| Exact legal polygons stitched as needed | Cheap-looking individual pieces; completeness requires automatic neighbors | Without neighbors, boundary loops disappear; with them this becomes the shared-pieces design | Either an unexpected extra download or incomplete hiking support |

Independent regions are the provisional recommendation because they retain the
working installer and one-graph-per-start search model. If two compact adjoining
regions still duplicate an unacceptable fraction of device storage or build
time, settle shared storage **before** rolling out the catalog. Do not implement
both production paths as a hedge.

Shared storage is established practice, not inherently wrong: [Valhalla's graph
tiles](https://valhalla.github.io/valhalla/) support bounded reads, regional
extracts and updates. However, our component rankings, cycle hints, local portal
decisions and contraction boundaries cannot be deduplicated just by matching OSM
way IDs. A shared design needs canonical records plus explicitly scoped derived
facts and one coherent generation. Content-addressing alone is insufficient.

Replacing our loop engine with a point-to-point engine would not eliminate the
simple-cycle, lollipop, repetition, elevation and diversity requirements.
[OSRM's preparation tools](https://project-osrm.org/docs/v26.4.0/tools) are useful
references for separating graph preparation from costing, not a drop-in loop
generator or evidence that contraction hierarchies solve this search.

## Proposed build pipeline and correctness obligations

```text
Pinned named place + explicit eligible-start footprint + pinned sources
  -> conservative source extraction
  -> walking/access policy and inexpensive segment lengths
  -> distance-bounded graph pruning
  -> access candidates and necessary local context
  -> reused or batched elevation/segment measurements
  -> compact junction graph, preserving starts and attributes
  -> topology, reconciliation and one semantic artifact audit
  -> immutable compressed artifact + atomic catalog publication
```

### Distance pruning before expensive work

Let L = 50 miles, the existing exploration limit for close matches when the
requested maximum is 40 miles. For any vertex on a closed route of length at
most L, either the prefix from the start or the reversed suffix has length at
most L/2. Therefore its distance from that start in the underlying **undirected**
graph is at most 25 miles. Ignoring one-way restrictions only lowers distances;
the final route search still enforces them.

Seed all potentially eligible source trail nodes in the start footprint. Use
nonnegative segment lengths that are conservative lower bounds on published
lengths. Multi-source Dijkstra with a 25-mile cutoff gives a safe overestimate of
the relevant graph. Retain edges whose endpoints survive. A further necessary
condition is `d(u) + lowerBoundLength(u,v) + d(v) <= 50 miles`. Different nearest
seeds can retain unnecessary edges, but cannot eliminate a supported route.

Current portals snap to existing source nodes. If start attachment ever becomes
interpolated, seed both endpoints of every intersecting source segment or split
at attachment points first. Seeding only named trailheads would be unsafe.
Use a conservative numeric tolerance at the cutoff. A directed forward-only
25-mile cutoff is unsafe for an asymmetric loop.

Seeds are an overestimate for this distance calculation, not permanent routing
endpoints. Only actual admissible access candidates, junctions and semantic
transitions need survive later contraction. Do not retain every seed as a
potential user-selectable trailhead.

This is an application-specific preservation argument using established
[multi-source Dijkstra](https://networkx.org/documentation/stable/reference/algorithms/generated/networkx.algorithms.shortest_paths.weighted.multi_source_dijkstra.html).
With a binary heap it takes O((V+E) log V) time and O(V+E) graph storage; a distance
limit bounds extent, not density. No claim of constant memory or exhaustive loop
enumeration follows from the 40-mile product cap.

The geographic envelope remains a conservative acquisition bound. Start polygons
never clip hikes. Complex official polygons introduce point-in-polygon cost;
apply spatial/bounds filtering and avoid scanning every polygon vertex for every
trail segment. Do not silently simplify a start boundary inward. Keeping a
conservative rectangular acquisition envelope initially is acceptable if the
subsequent graph reduction makes actual work small.

### Persist the compact graph

Preserve junctions, every potential start, and changes in access, direction,
source feature or observations. Contract only unambiguous chains between those
points. Retain original shape coordinates and elevation profiles. Length,
gain and loss aggregate; maximum elevation takes the maximum. Recompute grade
windows across joins: a maximum of short-segment grades misses cross-join
100-metre windows. Do not resample or change elevation smoothing as an incidental
consequence of contraction.

Preserve parallel paths, rings, directionality and physical trail identity for
stem/repetition accounting. Never connect nearby coordinates. Rings need stable
anchors; starts on rings must survive. Keeping metadata transitions as endpoints
avoids a second reconstruction table. Existing schema 7 can represent polyline
edges, but every reader/audit assumption must be checked before deciding that no
format revision is necessary. Compiler identity must change in either case.

Access evidence, nearby-building counts and start discovery must survive the
reduction. Current connectivity and reachable-trail-length fields affect start
ranking, not access eligibility; Full still attempts all eligible starts. Do not
retain expensive whole-envelope component counts just to preserve those rankings.
Document the new ranking scope and keep no-cycle pruning correct for the
supported distance bound.

[GraphHopper's tower/pillar representation](https://github.com/graphhopper/graphhopper/blob/master/docs/core/low-level-api.md)
separates routing junctions from shape vertices. [OSMnx simplification](https://osmnx.readthedocs.io/en/stable/user-reference.html#osmnx.simplification.simplify_graph)
also retains geometry and configurable attribute boundaries. Its ring-removal
default and proximity-based intersection consolidation are unsuitable here.
These references support the representation, not a transferable speedup figure.

Biconnected blocks remain useful for locating simple physical cycles; lollipop
stems can cross articulation points and bridges. Direction and access need
separate checks. [NetworkX's cycle documentation](https://networkx.org/documentation/stable/reference/algorithms/generated/networkx.algorithms.cycles.simple_cycles.html)
distinguishes directed SCC and undirected BCC preprocessing. We should not
enumerate every loop at build time.

### Reuse, elevation and bounded resources

Look up the prior action receipt from cheap declared inputs (named footprint,
source pins, restrictions and algorithm versions), then validate its recorded
actual DEM dependency set before reusing it. First-build DEM dependencies are
not all known until pruning/sample planning; the metadata-only plan must say so.
The final action identity binds those dependencies too. Keep output byte hashes
separate. A label change should update catalog metadata without forcing
elevation/topology work. Boundary, source, access or algorithm changes may
legitimately invalidate dependent work. [Bazel's action-cache/CAS distinction](https://bazel.build/remote/caching)
is the relevant practice; no Bazel or remote service is required.

Keep physical-segment measurement caching below corridor construction, so a new
junction need not resample unchanged geometry. The current `wayId:segmentIndex`
cache key loses reuse when an inserted source node shifts subsequent ordinals;
measurement identity should use geometry plus DEM and metric/sampler versions,
independent of the source segment's ordinal. Resolve only DEM products owning
actual retained samples. Use a build-scoped sampler with bounded requests,
lazy relevant-product opening and bounded raster caching; group samples by tile
and locality while restoring output order. Always close/reap it on success,
failure or cancellation. [Rasterio](https://rasterio.readthedocs.io/en/stable/topics/windowed-rw.html)
documents that even one-pixel requests read whole raster blocks.

Persist stage counts, timings, cache hits, input bytes, measured process/cgroup
memory and temporary disk. Admit a graph to compact in-memory analysis only after
its counts fit an explicit budget. Retain the 4 GiB, no-swap Docker build limit;
do not add unbounded parallel regional workers. Reuse finite prepared SQL
statements and remove redundant connectivity/selection passes.

One semantic audit can be reused for immutable bytes under an explicit audit
version, while transport hashes and catalog structure remain verified. A receipt
must bind the exact content and validation contract; it cannot excuse corruption.
An explicit full inspection command remains available. Unchanged neighboring
artifacts should not need decompression and graph analysis at every publication.

## Named places, trailheads and boundaries

Use one catalog, with stable IDs, human names, aliases, pinned boundary provenance,
eligible-start footprint, source recipe and limitations. Migrate current registry,
search-region and historical pack-folder indirection into it where they describe
the same place. Separate records may reference the same boundary; do not maintain
several authoritative copies.

Use the same named area including approaches in the builder, download preview
and Plan selector. Installing that area and then applying a legal-wilderness-only
filter under the same label would silently exclude the approaches again.

[USFS Forest Common Names](https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_ForestCommonNames_01/MapServer/2)
is specifically intended for public forest names and extents. The separate
[USFS Wilderness layer](https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_Wilderness_01/MapServer/0)
provides the wilderness boundaries, within its agency scope. Pin selected
features and their provenance; normal builds and app requests should not depend
on a live agency query. Forest and wilderness names overlap and do not form a
strict one-parent hierarchy. Forest coverage alone also misses national parks,
state land and other useful hiking areas.

| Candidate | Authoritative feature ID | Approximate acres | Relevant consequence |
| --- | --- | --- | --- |
| Mt. Baker–Snoqualmie National Forest | Common Names 90 | 2,025,554 | Reaches Canadian border |
| Okanogan–Wenatchee National Forest | Common Names 61 | 3,857,267 | Reaches Canadian border |
| Glacier Peak Wilderness | Wilderness 207 | 566,328 | Interior candidate; approach coverage still needs review |
| Pasayten Wilderness | Wilderness 445 | 531,325 | Reaches Canadian border |

Only attributes/extents were queried for this study, not full boundary datasets.
The acreages above do not predict graph size or build time.

Two product choices were explicitly resolved with the user:

1. **Approaches.** Legal wilderness polygons exclude some real access trailheads.
   The current 500-metre named-region tolerance is not a completeness guarantee.
   An explicitly named “Glacier Peak area — wilderness and access trailheads” can
   use a reviewed start footprint, preserving existing start-filter semantics.
   That carries editorial/onboarding maintenance. A graph-distance rule can
   select starts serving a wilderness, but still allows loops that never visit
   it. Requiring the hike to enter the wilderness is a different product rule.
   The user chose the trailhead/approach meaning. Keep the actual eligible-start
   footprint visible and document the editorial review needed to include useful
   approaches; do not promise every approach without evidence.
2. **Outer source coverage.** Washington-only data cannot guarantee all 50-mile
   closed routes from starts beside Canada. The user chose a US-only product
   with the international border displayed as a hard limit. The named planner
   must explicitly exclude that unsupported jurisdiction, then require complete
   provider support for the remaining intended footprint. Interior provider
   holes and uncovered neighboring US states must still fail. This guarantee is
   for routes wholly within supported US coverage, not all cross-border loops;
   the current planner needs an intentional update to implement it.

For independent overlapping regions, replace artifact-hash ordering with stable
semantic start ownership. Installation of a neighbor should not arbitrarily
retarget an existing start because its artifact filename sorts earlier. Saved
jobs remain pinned to their exact installation.

## Developer and user interfaces

Proposed commands, **not yet available**:

```sh
npm run data -- regions
npm run data -- plan glacier-peak
npm run data -- build glacier-peak
npm run data -- status --watch
```

The catalog resolves pins and geometry. Remove public bbox/network-ID selection.
`plan` shows the named footprint, supported route limit, source gaps, cached and
missing input bytes and any relevant previous measurements. Unknown output size
or ETA stays unknown. Do not make a supposedly instant plan secretly normalize
the region; distinguish metadata inspection from an explicit measured probe.

Build output reports understandable stages and real counts, then a clear final
summary with elapsed time, output sizes and where to install. Cancellation must
stop child processes, preserve valid reusable work and remove disposable scratch.
Cold, resumed, identical and neighboring builds must be distinguishable.

The app offers **Download trails**, a searchable named list, map highlighting,
download size, additional device space and state. Selecting a name previews its
actual supported start footprint; one short explanation says surrounding routing
trails are included. Preserve Download, pause/resume/cancel, Update and Remove.
Show regional gaps or incomplete coverage at the selection that causes them.
Graph IDs, components, recipes and build controls stay out of the app.

The existing map-only click workflow is insufficient for overlapping named areas.
[OsmAnd's download interface](https://osmand.net/docs/user/start-with/download-maps/)
is a reference for name-based regional selection and map highlighting; its many
map types and settings are not needed here. A forest label need not imply another
duplicate artifact if it merely groups already offered regions, but partial
forest availability must not be labeled complete.

## Expense ledger

| Operation | Expected work / cost | Required visible behavior |
| --- | --- | --- |
| First build, empty cache | Source and DEM acquisition; extraction; new metrics; compact topology; export | Input download bytes separate from processing; ten-minute target measured end to end |
| First build, cached sources | No unnecessary acquisition; new retained metrics and graph work | Never present this as a cold-build benchmark |
| Identical rebuild | Validate pinned inputs/immutable outputs; early artifact reuse | No elevation, topology, staging replay or output rewrite |
| Neighboring region | New local context; only missing segment metrics; local topology/export | Report metric reuse and duplicated graph/output bytes honestly |
| Source update | Changed inputs invalidate dependent work; unchanged metrics can survive | Coherent publication; no accidental mixing of incompatible generations |
| Interrupted retry | Reuse completed verified inputs/metrics/artifacts; restart disposable incomplete stages | No orphan children or growing abandoned scratch; explicit recovery summary |
| First install | Compressed bytes, decompression, verification and final SQLite | Show transfer size, installed size and peak additional free-space requirement |
| Overlapping second install | Independent graphs duplicate overlap; only identical whole artifacts deduplicate | Show actual additional bytes, not unique mapped trail acreage |
| Update | New artifact beside old until atomic switch; saved jobs can retain old files | Explain retained historical space; do not promise immediate reclamation |
| Remove | Drop active references; collect only unreferenced artifacts | Saved routes remain readable; retained job data is accounted for |
| Full search | Bounded graph loading plus constrained cycle search per eligible start | Every eligible start attempted; exact/close/truncated results remain distinct |

Local route generation adds no paid routing API call per hike. Existing optional
place search and drive-time filtering use ArcGIS. Its current Location Platform
pricing lists service areas at 5,000 free then $50/1,000, and temporary geocodes
at 20,000 free then $0.50/1,000; ArcGIS Online uses a different credit model.
Actual charges depend on the configured account and returned results, not just
button clicks. This redesign should add no provider request to a local hiking
search. [ArcGIS pricing](https://location.arcgis.com/pricing/)

[USGS elevation downloads are free](https://www.usgs.gov/faqs/what-types-elevation-datasets-are-available-what-formats-do-they-come-and-where-can-i-download),
but bandwidth, disk and time are not. Transfer alone has a lower bound of
`8 * newBytes / linkBitsPerSecond`; 4 decimal GB takes about 320 seconds at an
ideal 100 Mbps before protocol overhead or processing. The existing cache size
must not be presented as every new region's download size.

Retain 10-metre elevation initially. Coarser elevation saves bytes but changes
gain/grade quality and needs a separate comparison. USGS distributes COGs, and
[GDAL supports HTTP range reads](https://gdal.org/en/stable/user/virtual_file_systems.html),
so block acquisition is a credible alternative if cold input cost fails the
target. It introduces version pinning, block completeness, integrity and offline
cache obligations. Do not silently replace verified whole-product inputs with
unversioned remote samples. Local source and metric caches need an explicit
retention policy; retaining every obsolete version forever is not free.

Public hosting is not part of the local application. If artifacts are later
distributed, monthly transfer is approximately download count times new bytes,
plus retained release storage and hosting charges. No provider/budget has been
chosen, so a dollar hosting forecast would be invented. Preserve source/license
metadata and the existing publication review requirement.

## Acceptance before implementation is called settled

Use a small number of targeted experiments, not repeated full builds:

1. **Completed:** inspect the already finished artifact in isolation. Results
   above show substantial reduction potential, but do not prove compact byte
   size or regional cold runtime.
2. Establish one named region's real start footprint and representative access
   points on its approaches. Review source/DEM support before downloading.
3. Exercise offline fixtures for boundary-crossing loops, long stems, one-way
   asymmetry, access changes, pure rings, parallel trails, grade across corridor
   joins, provider gaps and stable overlapping ownership. Compare expanded
   route geometry and metrics, not only compact edge IDs.
4. Run one instrumented user-invoked build of that useful region. Record cold
   bytes, processing phases, peak memory/disk, segments before/after pruning,
   published corridors, compressed/raw sizes, valid starts and useful Full
   results. A warm input cache is explicitly a separate measurement.
5. Measure an unchanged rebuild and one neighboring region without recomputing
   valid metrics. Project the intended named collection's overlap from those
   measured artifacts. Reject independent storage if its costs fail the chosen
   device/download budget; that numeric budget is not yet agreed and must be
   established from the first compact artifacts. Reject shared storage if its
   engineering cost has no demonstrated payoff.

Failure of the ten-minute target should first be attributed to acquisition,
sampling, graph preparation or export. Do not respond by inventing smaller
arbitrary boxes. Do not declare success by omitting approach starts, changing
elevation quality, dropping cross-boundary routes or suppressing difficult starts.

## Replacement and simplification obligations

The implementation should replace the bbox-only CLI and generic unnamed download
entries, consolidate duplicated region definitions, remove repeated connectivity
and edge-selection work, and replace per-batch Python startup. Compact publication
should replace per-shape-node graph storage on the active path. Reuse the existing
installer, immutable artifacts, saved-job pinning and exact/close search rules.

Do not introduce a network-merger registry, dynamic-connectivity service, cloud
database, global normalized Washington store, multiple production storage modes,
or duplicate old/new builders. Keep historical source under the archive tags.
Delete superseded implementation and tests when replacements are integrated;
record production/test/doc line counts separately. Fewer lines are useful evidence
of simplification, not a substitute for preserved behavior and measured costs.

The remaining user preference is download granularity. The approach/start
meaning and US-only border policy are settled; actual approach footprints still
need regional review. Unmeasured costs include
compact artifact sizes, cold first-region runtime, adjoining overlap, and update
retention. Those are explicit remaining work, not reasons to promise another
rewrite is already proven final.
