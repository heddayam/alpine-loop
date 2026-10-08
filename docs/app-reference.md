# Alpine Loop reference

A local desktop app for finding loops and lollipops from mapped trails. Choose
one or more prepared mountain regions, set distance, elevation gain, stem and road limits,
and submit a search job. Browse stable results after discovery finishes.
Every shown route meets the requested constraints; unfinished jobs show their
stage, within-region progress and completed regions. Discovery tries a bounded
set of alternatives; it can miss qualifying hikes.

## Mountain sections

Preparation uses the exact GMBA v2 standard mountain outline intersected with
the supported state outline. A small mountain region stays whole. Only an
oversized region is divided: use genuine through-freeways first, then the fewest
additional major numbered highways needed. A highway may terminate at another
selected divider; no continuation is invented. Oversized pieces without a valid
cut remain explicitly unavailable.

Applied dividers are hard hike boundaries, including bridges and underpasses.
Each resulting section is compiled independently before graph construction and
stored as three complete files: starts, topology, and measured route geometry.
There are no replicated geographic cells or cross-section graph joins. Search
loads one section at a time, considering every eligible start across the
selected sections. Missing or unprepared coverage is disclosed.

Search regions and prepared data sections share the same identity and exact
footprint. Search and Settings group areas by state, with a mountain-range heading
only when that range contains multiple sections. Familiar section names and
grouping come from the catalog; exact boundaries remain visible on the map and
in Settings. Select regions from
the dropdown, or choose **Draw** beside it under **Search area** and click around an area on the map.
Finish with the first point, the Finish button or Enter; Undo removes the last
point and Cancel or Escape keeps the previous selection. Drawing automatically
selects every overlapping prepared section and considers every eligible starting
point inside or on the boundary. Hikes may extend outside the drawn boundary;
the prepared highway partitions still apply. Crossed or unsupported boundaries
are rejected; a valid area with no eligible starts completes with no results.
The boundary is saved with the job and restored by View results or Copy settings.
**Redraw** replaces the polygon; the adjacent clear button removes the
starting-point restriction and returns to the full selected regions. Panning and zooming
only change the view. Drawing uses available prepared coverage and does not
prepare new trail data. Unknown
pedestrian access is included by default, and can be excluded.
Explicit prohibitions are respected.
Road and parking starts respect mapped car-access restrictions separately from
walking permission. A vehicle-closed track can remain walkable without creating
a start at its trail junction. Mapped road contacts
do not certify legal parking or current road conditions.

## Search jobs and results

The Jobs dialog shows saved requests, FIFO queue positions, stages, current region,
a progress bar for completed discovery steps, completed regions and
elapsed time. Closing it leaves jobs running. Jobs
use bounded discovery effort without a mileage or displayed-result cap. A
completed empty search means no qualifying hikes were found by that search.
Every job uses the full discovery plan, with one submission and one completed
result set. Searches can miss valid hikes; every shown route meets the submitted
limits. The [bounded-discovery review](../benchmarks/bounded-discovery-review.json) records
current correctness and real-data measurements; the
[previous review](../benchmarks/completed-jobs-review.json) retains the exhaustive
solver's unfinished jobs and memory failures.
Completed jobs become ready in the app without changing your screen.

History and completed geometry live in `.local-data/jobs` (inside the Docker volume
for container launches). Reloading restores
jobs; completed views have stable `?job=ID` URLs. Restarting interrupts the job
that was running and continues queued jobs. Cancellation, interruption and failure
discard unfinished results while keeping settings to copy into a new submission.
Constraints and completed results are immutable. Opening saved results populates
the search bar with their settings; edit them to submit another job. The Jobs
dialog can also copy a retained request. Delete terminal jobs with confirmation to reclaim their
saved storage; history is otherwise retained.

Distinct main circuits are proposed by deterministic weighted shortest-path
forests and short local trail alternatives. A small set of sensible reversible
connections evaluates every eligible start separately from the main circuit.
Similar main loops share a displayed hike when their common physical trails cover
at least 60% of the longer main loop in the same cyclic order, including roads.
Displayed representatives stay fixed; hidden discoveries cannot join two otherwise
distinct hikes. Only one preferred qualifying walk is saved per displayed hike.
Loop variations, alternative starts and reverse directions are discarded.

The chosen start prefers an explicit mapped trailhead, then parking, then road
contact; ties prefer certain access, less road walking, less repetition, shorter
distance and stable IDs. Every eligible start is still evaluated. Details show
that walk's exact metrics, elevation profile and GPX. All constraints stay visible
in the compact top bar. One collapsible left dock identifies the saved regions,
route count and request above the comparison list, with distance, Elev. Gain and stem
sorting and an underlined Asc/Desc control. Selecting a hike jumps to its full route with nearby terrain visible;
selecting its row again closes the details. Stem is the one-way approach walked again
on the return, limited by absolute distance. Stem steppers change by 1 mi; elevation
gain changes by 500 ft. Settings offers a locally remembered imperial/metric choice
for search, results and profiles; metric steps are 1 km and 100 m. Changing units
preserves the exact submitted limits. Typed values remain unrestricted within valid
limits. The profile uses the dock's width,
with elevation labels inside the plot and pointer/keyboard tracking on the route.
The map shows all result locations as compact hollow circles and numbered cluster
circles. Counts use 28 px circles with 13 px semibold numbers; larger counts get
enough room to remain circular. The active trailhead fills charcoal at the same size; the route uses a
single burnt-orange line. No outer selection ring or route outline is added.
From zoom 9, muted paths show the other saved hikes in the area at 95% opacity.
Strokes grow from 2 to 3 px as you zoom in. Shared physical trail sections draw
once, keeping overlapping hikes from darkening the map. Hover or click a path to
inspect a route; orange identifies the hovered or selected walk. Only geometry
around the current view is sent, and a surrounding window avoids requests on short pans.
Clicking a cluster or shared start opens its
hike list and jumps to the extent of every associated walk, with nearby terrain
visible. Route and group framing share the same camera behavior and use no
animation. **In view** filters by the current map viewport and **All** keeps the
complete search. Continuous scrolling mounts only visible rows. Editing the top
bar shows a subtle Settings changed status while saved results retain their original request. Searches
from an older catalog retain their named regions and saved geometry; choose current
regions explicitly before submitting a new job. Search submission opens Jobs;
closing it leaves work running.
History is retained until manual deletion and browsed in pages of 50 jobs.

The search worker targets 40% of one core using measured CPU time and cooperative
waits. It has a 256 MiB old-generation heap limit, and a backend RSS watchdog stops
unfinished work above 768 MiB. These are resource safeguards, not strict operating
system caps: native allocation and garbage collection can briefly exceed a target.
Geometry is streamed one physical trail at a time and stored once per used trail;
map tiles and hover drawings have bounded caches. The
[local resource review](../benchmarks/local-resource-improvements.json) records achieved
usage and limitations. Existing completed files remain unchanged; deleting an old
job reclaims its previously saved alternatives.

For the same start and ordered trail itinerary, avoidable longer road substitutions
are removed before minimum distance and elevation gain are applied. A shorter legal road
alternative must meet all other limits and offer no worse access certainty.
Road connections required for legal access or other constraints remain eligible.
Completed geometry is stored once per used physical trail and survives source
replacement or removal.

Road limits count every road, vehicle track and sidewalk connection walked,
including a lollipop's return. Defaults are one mile and 10% of the hike; both
are adjustable. A mapped walking permission does not turn a vehicle road into
a hiking trail. Elevation gain is a DEM estimate without noise suppression;
small missing-data areas at the Canadian border use explicitly recorded
Copernicus surface-height supplements.

## Native development

With Node.js 24 or newer installed:

```sh
npm start
```

Open the printed local URL. Launch installs dependencies, builds the app and
obtains prepared data automatically. It reuses the build until source,
configuration, dependencies or required outputs change. Native data and jobs
live in `.local-data`; Docker keeps its own separate local volume.

## Preparation and verification

The maintainer [preparation guide](../tools/prepare/README.md) describes the pinned
sources, partition planner, atomic section publication and source audits. The
[benchmark guide](../benchmarks/README.md) retains 24 frozen Washington requests,
independent evidence and reproducible real-data measurements. Generated data,
sources and caches stay outside Git. Historical implementations remain in archive
tags and are not compatibility targets.

```sh
npm run verify
npm run size
```

Automated checks use offline fixtures: an independent exhaustive route oracle,
actual compiled-worker/API/GPX flows, section identity isolation, and download
integrity/cancellation/reuse. Python preparation checks use tiny committed source
recipes and synthetic DEMs; their commands are in the preparation guide.
Real-data timing and capacity measurements are separate from the offline suite.

The map uses MapLibre for continuous zoom and pan. Its implementation stays in
one client module; Vite builds the pinned worker directly from the dependency.
The map code loads separately so the form and saved jobs can render first.
The basemap uses [Maptoolkit Hiking](https://www.maptoolkit.org/hiking), with
vector trails, contours and shaded relief. Labels use MapMaker's "Blured" preset
(Averia Serif Libre), applied when the provider style loads without a copied
style file or another font service. No account or API key is needed;
the community service requires a visible logo and copyright line, uses fair-use
rate limits, and excludes offline basemap downloads and printed map exports.
An experimental USFS/NLCD 2025 tree-canopy overlay fills forest-coverage gaps;
add `&canopy=off` to a saved-job URL to compare without it.
Region selection draws only the selected boundaries, and hike selection updates
existing marker styling. The
[renderer review](../benchmarks/map-renderer-review.json) records the source and
compressed-build cost and browser verification.
