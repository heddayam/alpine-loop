# Alpine Loop

A local desktop app for finding loops and lollipops from mapped trails. Choose
one or more prepared mountain regions, set distance, climb, repeated-trail and road limits,
and submit a search job. Browse stable results after discovery finishes.
Every shown route meets the requested constraints; unfinished jobs show their
stage, within-region progress and completed regions. Discovery tries a bounded
set of alternatives; it can miss qualifying hikes.

## Run

Requires Node.js 24 or newer:

```sh
npm start
```

Open the printed local URL. Launch installs dependencies and builds the app.
It obtains the published mountain catalog automatically; missing trail sections
are downloaded when you choose **Download and search**. Panning never downloads
anything. The same region list selects searches and offers individual downloads. Downloads show
actual size and progress, support cancellation, and reuse verified files.

This development checkout uses `.local-data/mountains`. Public prepared-data
publication is still pending; the catalog release descriptor remains unset.
Hikers never need Python, Osmium, raw OSM, elevation products, or API keys.

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
footprint. Select regions from the list or click their map polygons. Every
eligible start in those regions is considered; panning and zooming only change the
view. There are no separate named rectangles or custom drawing scopes. Unknown
pedestrian access is included and labeled by default, and can be excluded.
Explicit prohibitions are respected.
Road and parking starts respect mapped car-access restrictions separately from
walking permission. A vehicle-closed track can remain walkable without creating
a start at its trail junction. Unknown access is labeled; mapped road contacts
do not certify legal parking or current road conditions.

## Search jobs and results

The Jobs dialog shows saved requests, FIFO queue positions, stages, current region,
a progress bar for completed discovery steps, completed regions and
elapsed time. Closing it leaves jobs running. Jobs
use bounded discovery effort without a mileage or displayed-result cap. A
completed empty search means no qualifying hikes were found by that search.
Every job uses the full discovery plan, with one submission and one completed
result set. Searches can miss valid hikes; every shown route meets the submitted
limits. The [bounded-discovery review](benchmarks/bounded-discovery-review.json) records
current correctness and real-data measurements; the
[previous review](benchmarks/completed-jobs-review.json) retains the exhaustive
solver's unfinished jobs and memory failures.
Completed jobs become ready in the app without changing your screen.

History and completed geometry live in `.local-data/jobs`. Reloading restores
jobs; completed views have stable `?job=ID` URLs. Restarting interrupts the job
that was running and continues queued jobs. Cancellation, interruption and failure
discard unfinished results while keeping settings to copy into a new submission.
Constraints and completed results are immutable. Copy settings to submit another
job. Delete terminal jobs with confirmation to reclaim their
saved storage; history is otherwise retained.

Distinct main circuits are proposed by deterministic weighted shortest-path
forests and short local trail alternatives. A small set of sensible reversible
connections evaluates every eligible start separately from the main circuit.
Minor variants share a family only when their common physical core trail is at
least 85% of their combined core footprint, the common cyclic order agrees, and
no connected difference exceeds one kilometer. Approaches and directions do not
create additional hikes. A qualifying minor variation is retained when needed to
meet the limits; there is no variation selector.

Details retain qualifying starts and directions. The displayed start prefers an
explicit mapped trailhead, then parking, then road contact; ties prefer certain
access, less road walking, less repetition, shorter distance and stable IDs.
Available directions each have their own exact metrics and GPX. Sorted paging
never changes the job, and the map includes all result locations regardless of
the visible page. Coincident locations offer a hike chooser.

For the same start and ordered trail itinerary, avoidable longer road substitutions
are removed before minimum distance and climb are applied. A shorter legal road
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

## Preparation and verification

The maintainer [preparation guide](tools/prepare/README.md) describes the pinned
sources, partition planner, atomic section publication and source audits. The
[benchmark guide](benchmarks/README.md) retains 24 frozen Washington requests,
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
