# Alpine Loop implementation plan

The [system design revision](system-design.md) records the current design and
its acceptance evidence. [Status](status.md) is the execution resume point.

## Product

Alpine Loop generates closed hiking routes from installed trail data. It is not
a catalog of known hikes. Users choose an area, physical route constraints,
acceptable repetition, and whether unknown access is included.

An area can be drawn, named, or based on typical driving time. Named regions
may refine a driving area. A drawn boundary overrides those choices. These
filters select eligible starting points; they never clip hiking routes. Exact
installed coverage is the hard route boundary. Failed filters never silently
broaden the area.

- Quick search returns up to the requested number of alternatives across the
  eligible data. The count ranges from 1 through 20 and defaults to 10.
- Full search attempts every eligible trailhead and retains up to ten exact
  routes per start, or one close match if no exact route was found there.
  One request creates one saved job regardless of internal data partitions.
- Exact and clearly labeled close matches remain separate. A completed Full
  search means every eligible start was attempted, not that every possible
  closed walk was enumerated. Computation limits remain visible.

Routes contain a physical trail cycle and finish at their starting point.
Simple loop, lollipop, figure-eight, chained-loop, and complex-closed describe
results. The search preserves direction, access restrictions, metric accuracy,
repetition limits, and topology. Unknown access is included by default.
Search removes minor side loops and retraced spurs before checking constraints;
it does not pad a hike with tiny excursions to meet its distance target. The
relative size rule preserves intentionally short hikes and substantial chains.

## Workspace

A persistent map shares the workspace with one panel for Plan, Results, and
selected-route details. Mobile switches between the panel and the full map
without remounting either. The visual language remains compact, neutral, and
utilitarian. Route count is directly available beside the search actions.

One editable form supplies both search actions. The viewed result has its own
area and criteria snapshot; editing the form does not change the meaning of
saved results. Search, opening saved work, and paging share one cancellation
scope and reject stale completion. Closing a pending saved view cancels it.

The map renders coverage, the active filter, eligible starts, and the loaded
result page. Viewport queries own trail data updates. Hover and selection have
one explicit path. Generated route geometry changes only with the route
collection; emphasis uses filters, and segment geometry changes with its owner.
Native count markers represent actual route starts. Clicking a marker filters
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

The Jobs dialog lists saved work, progress, cancellation, and deletion. Opening
completed or cancelled work loads its exact-first result page. Cancellation
retains partial results; deletion removes the job and its results. Settings
have one validated value and one ordered persistence path. Incomplete numeric
input stays local to the form.

## Application boundaries

The app uses local Next.js, React, MapLibre, Zod, and SQLite.

- `GET /api/search/catalog` provides named regions, installed coverage, and the
  initial map view. No installed coverage means data is unavailable.
- `POST /api/search` accepts one area, route criteria, and the global count.
  The application resolves driving time, selects data, executes bounded work,
  namespaces identities, and combines results.
- `GET /api/map?bbox=...` supplies viewport access points and trails.
- `/api/route-jobs` and its detail, cancel, delete, and results operations retain
  version-2 jobs. Public records contain intent and area, not internal plans.

The route engine accepts prepared starts, criteria, graph context, and budget.
A dedicated local process owns graph-reader lifetime so CPU work cannot block
app status or cancellation. Quick and Full share execution primitives. Full
preserves the union of Quick and Thorough candidates because the heuristic is
not monotonic in its budget.

Provider submission, polling, deadlines, and cancellation stay inside driving
area resolution. Completed contours are cached for 30 minutes. Credentials
remain server-only. Runtime never requests trail or elevation data remotely.

## Local data and preparation

Schema 6 is the supported graph representation. Pack selection, storage paths,
version pinning, and provider jobs are backend details. Saved result geometry
remains readable independently of graph-format support.

Preparation converts pinned sources into normalized records. The artifact
builder computes metrics and feasibility, writes SQLite, audits the artifact,
and activates it only after acceptance. Failed builds leave the previous
artifact and current pointer intact. Downloads are immutable and cached.

Jobs persist in ignored `.local-data/runtime/route-jobs.sqlite`. The immutable
internal plan pins contributing data versions. One FIFO coordinator resumes
interrupted work from its first unfinished start while the pinned data remains
available. Old saved geometry stays viewable when data changes. Cancellation and
deletion take precedence over late worker completion.

Generated packs, source downloads, caches, secrets, and local databases stay out
of Git. Automated tests use committed inputs and production storage without
network access. Verification covers changed invariants, existing behavior,
current-data comparisons, builds, and desktop/mobile map interaction according
to the [runbook](agent-runbook.md).
