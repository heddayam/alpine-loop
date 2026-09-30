# Alpine Loop implementation plan

The accepted [network and route revision](network-design.md) restricts generated
routes to loops/lollipops and uses locally prepared start areas with distance-derived
routing buffers. [Status](status.md) distinguishes implemented work from
pending gates. Developer builds and downloadable coverage remain the delivery
model established by [prepared coverage](prepared-coverage.md).

The [system design revision](system-design.md) records the current design and
its acceptance evidence. [Status](status.md) is the execution resume point.

## Product

Alpine Loop generates closed hiking routes from installed trail data. It is not
a catalog of known hikes. Users choose an area, physical route constraints,
acceptable repetition, and whether unknown access is included. Requested route
distance may be up to 40 miles; longer close matches remain explicitly labeled.

Coverage targets mountain hiking starts in Washington and the previously available
Bay Area/nearby California territory. One pinned GMBA Standard Basic inventory
supplies named mountain cores for fifteen download areas: eleven Washington hiking
districts following WTA's regional browsing convention and the four retained
California areas. Full named leaves approximate these districts rather than
reproducing WTA's per-hike assignments. Washington's state scope and the four
existing California footprints limit approach nomination;
these product limits never clip routes. Broad outlines, EPA residual allocation
and the separate terrain mask are removed.

A start needs a connected source-supported pedestrian entrance and a hiking
connection to its selected core within 50 walking miles. Building counts describe
the surroundings and never veto an entrance. The 50-mile association is the
existing inclusive graph-distance policy, previously documented incorrectly as
25 miles; the separate 25-mile geographic route buffer remains unchanged.
Ordinary roads and validated parking/vehicle-turnaround places establish local
arrival context. Connected service approaches and affirmative-motor track
approaches lead to hiking departures or mapped mode frontiers. Unknown/private
tracks remain walking geometry without propagating generic arrival. Connected
trip-start assertions retain their actual walking approach. Interior hiking
junctions and isolated trailhead tags cannot establish
arrival themselves. Foot passage, including actual node restrictions and direction,
is evaluated independently of car and parking certainty. Unmarked entrances remain
eligible; ordinary roads cannot establish mountain association. Preparation freezes
actual eligible entrances, adds their registration neighborhoods to the display
outline, and completes each entrance's route buffer before elevation work.
Reviewed anchors audit source topology rather than enlarging the core. Low foothills
omitted by GMBA and unmapped/disconnected trails remain explicit limitations.
See the [whole-application entry model](access-point-review.md) for the policy,
independent source evaluation and outstanding real-build acceptance.

An area can be drawn, named, or based on typical driving time. Named regions
may refine a driving area. Driving time has a minimum (default zero) and a
maximum; the band excludes starts within the minimum contour. A drawn boundary overrides those choices. These
filters select eligible starting points; they never clip hiking routes. Exact
installed coverage is the hard route boundary. Failed filters never silently
broaden the area.

- Full search attempts every eligible trailhead and retains up to ten exact
  routes per start, or one close match if no exact route was found there.
  One request creates one saved job regardless of internal data partitions.
- Prepared entrance families annotate short alternate approaches to one onward
  trail without removing any start. Results group identical physical loops from
  these entrances and retain expandable starting-point variants with their own
  geometry and constraint matches.
- Exact and clearly labeled close matches remain separate. Full search gives
  every eligible start an initial attempt, then automatically improves unfinished
  exact searches with increasing work allowances. Once exact exploration is
  exhausted, retain a useful close match from bounded fallback exploration and
  finish that start; close-only limits do not trigger deeper attempts.
  Stop keeps saved results. Attempted starts and completed exact exploration
  are separate progress measures; fixed memory
  limits remain visible. Completion does not claim every regional hike is known.
  See [route-search policy](route-search-optimization.md).

New routes are simple loops or lollipops only. A simple loop revisits no node
except its start/end. A lollipop has one node-simple stem, traversed out and
back along the same physical trails, meeting one simple loop only at its
attachment. No additional spurs, figure-eights, chained cycles, or complex
closed walks are accepted, including as close matches. Direction, access,
metrics, grade and repetition limits still apply. Unknown access is included
by default. Legacy saved route geometry and topology remain readable.

## Workspace

A persistent map shares the workspace with one panel for Plan, Results, and
selected-route details. Mobile switches between the panel and the full map
without remounting either. The visual language remains compact, neutral, and
utilitarian. Full search is the sole search action.

One editable form supplies the search intent. The viewed result has its own
area and criteria snapshot; editing the form does not change the meaning of
saved results. Search, opening saved work, and paging share one cancellation
scope and reject stale completion. Closing a pending saved view cancels it.

The map renders coverage, the active filter, eligible starts, and the loaded
result page. Viewport queries own trail data updates. Hover and selection have
one explicit path. Generated route geometry changes only with the route
collection; emphasis uses filters, and segment geometry changes with its owner.
Native trailhead markers use small location dots and rectangular quantity labels
("1 route", "6 routes"), distinct from circular result route numbers. Clicking
a dot or its label filters
the current results page to that trailhead; clicking a route line opens that
route. Overview results begin without a selected route. Temporary green previews
render above subdued context with crisp light casing; orange is reserved for
the route open in details. A ring identifies the trailhead filter separately.
Segments are interactive only in route details. Hover never moves the camera
or scrolls the panel; explicit selection may bring its target into view. Back
restores the last row's keyboard focus and returns to whole-route comparison.
Pointer preview temporarily takes precedence over keyboard preview; hiding the
panel or changing result context clears its transient state.
Drawing owns pointer gestures until completion, and container resizing updates
the map without reconstructing it. Results show metrics, route topology, warnings, source
confidence, elevation profiles, and segment observations.

The Jobs dialog lists saved work, progress, Stop, and deletion. Opening running
or finished work loads its exact-first result page. The active overview refreshes
as results arrive; route details keep a stable collection. Stop retains partial
results; deletion removes the job and its results. Settings
have one validated value and one ordered persistence path. Incomplete numeric
input stays local to the form.

## Application boundaries

The app uses local Next.js, React, MapLibre, Zod, and SQLite.

- `GET /api/search/catalog` provides named regions, installed coverage, and the
  initial map view. No installed coverage means data is unavailable.
- `POST /api/map` supplies viewport trails and eligible starts using the same
  foot profile, exact area predicates and prepared region membership as Full.
  An unresolved filter displays context trails without selectable starts.
- `/api/route-jobs` and its detail, cancel, delete, and results operations retain
  version-2 jobs. Public records contain intent and area, not internal plans.

The route engine accepts prepared starts, criteria, graph context, and budget.
A bounded pool of local processes owns graph-reader lifetime so CPU work cannot
block app status or cancellation. Full searches read one pinned installation and parallelize across trailheads,
retaining ordered durable checkpoints. Each start uses one solver path, increasing
state/time allowances across attempts, and fixed graph/candidate-memory limits.
Only work-limited starts repeat after every checkpoint in the pass commits.

Provider submission, polling, deadlines, and cancellation stay inside driving
area resolution. Completed contours are cached for 30 minutes. Credentials
remain server-only. Runtime never requests trail or elevation data remotely.

## Local data and preparation

Schema 7 remains the prepared graph record representation. Developers select a
pinned named mountain core and prepare its graph plus connected approaches. A 25-mile geographic buffer around every admitted start
covers closed routes up to the 50-mile close-match exploration bound; requested
hikes remain limited to 40 miles. Source gaps fail before preparation, and explicit
exclusions remain hard boundaries. Geographic search filters still select starts
only and never clip a hike.

Each local area has an independent immutable SQLite artifact. The catalog and
installation distinguish eligible start coverage from buffered routing coverage.
Prepared entrance rows establish region membership; display outlines do not.
One deterministic graph that actually admitted the requested-profile entrance
owns each start; overlapping artifacts are never joined. An admissible
graph-distance bound prunes before DEM work, and persisted corridors
retain geometry and metric profiles. Segment metric caches are reusable across
overlapping builds, while topology is local to each artifact. Ambiguous footways are possible walking links without a global
connectivity prerequisite; explicit sidewalks/crossings remain excluded and access
restrictions still apply.

Users select start areas and review download sizes. Downloads include their route
buffers, require no source processing, and activate atomically. Running and saved
jobs retain their referenced data; saved route geometry remains readable.

The [prepared coverage revision](prepared-coverage.md) defines the release,
installation, download, and migration contracts. Its acceptance gates in status
must pass before large-region feasibility or migration is declared complete.

Jobs persist in ignored `.local-data/runtime/route-jobs.sqlite`. The immutable
internal plan pins contributing data versions and the entry-policy version. Jobs
from an older entry policy keep saved geometry but unfinished execution stops;
old packs require a rebuild before their starts can enter the shared selector.
One FIFO coordinator resumes
interrupted work from its first unfinished attempt, with the same allowance,
while the pinned data remains available. Old saved geometry stays viewable when data changes. Cancellation and
deletion take precedence over late worker completion.

Generated packs, source downloads, caches, secrets, and local databases stay out
of Git. Automated tests use committed inputs and production storage without
network access. Verification covers changed invariants, existing behavior,
current-data comparisons, builds, and desktop/mobile map interaction according
to the [runbook](agent-runbook.md).
