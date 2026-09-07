# Native trailhead map prototype

Completed 2026-09-07; available for comparison, not adopted into the active app.
Baseline: `bbbd77f`. Verified prototype: `ea065a0`, preserved by
`prototype/native-map-2026-09-07`.

## Change

Replace generated-route HTML markers, expanding route-number grids, custom
screen-space clustering, and their listeners/styles with native MapLibre
circles and route-count labels. One point represents a real route start,
identified by access-point ID and exact starting coordinate. No midpoint or
screen-space relocation is introduced. Native labels use local system fonts.

Clicking a start or route line scopes the results panel to that start. Choosing
a list row opens route details; Back retains the scope; All trailheads restores
the full current page. Original route numbering, exact/close classification,
request snapshots, pagination and route/segment highlighting remain intact.
New pages, searches and clearing results reset the scope. Filtering is derived
from the existing result snapshot, not stored as a second result collection.

## Measurement against baseline

| Source | Net change |
| --- | ---: |
| Map implementation | -159 lines |
| Builder, results, shared start helper | +26 lines |
| Styles | -34 lines |
| Application and styles total | **-167 lines** |
| Tests and browser checks | +24 lines |
| Combined | **-143 lines** |

Measured with `git diff --numstat bbbd77f ea065a0 -- app components tests/browser`;
documentation and generated files excluded. Generated map geometry sources
increase from two to three because the start points now live in MapLibre.
Route/segment hover and start selection still cause no geometry reuploads.
No measured wall-clock rendering speedup is claimed.

## Tradeoffs and recommendation

Recommend this direction if trailhead-first navigation fits the product.
The simplification removes custom layout responsibility rather than moving it
to another file. The overall source reduction is modest; this is a focused map
simplification, not a major simplification of the search engine or job lifecycle.

Map numbers now mean counts of currently mapped routes on the current page,
not individual route numbers or totals across every saved page. Folded close
matches are not mapped. Picking an individual route from a marker requires a
second action in the results list. Nearby circles can overlap at low zoom;
native collision handling may hide some count labels, and zooming separates
nearby starts. Exactly coincident starts with distinct IDs remain overlapped;
all routes stay accessible in the full list. Map markers are canvas features,
so keyboard route selection is provided by the existing results list.

## Verification

- Two `npm run verify` passes: 436 offline tests across 79 files, lint, types,
  and production build.
- Two `npm run test:browser` passes: all seven Chromium flows, including a
  real canvas click at a fixture trailhead, scoped counts, original numbering,
  detail/Back, clearing the scope, and no external fixture-test requests.
- Live preview of copied Sunol saved routes: count labels render, details/Back
  work, mobile full-map/panel switching works at 390×844, document width is
  390 and document scroll remains zero. Responsive override reset. No browser
  console errors observed. Live pan/zoom anchoring was not separately measured;
  geometry identity and upload behavior are covered by tests.
- No public contracts, dependencies, root configuration, solver or pack schema
  changes. Original installed packs and saved databases remain untouched.

## Preview and recovery

Local preview: http://127.0.0.1:3002, running from
`/private/tmp/alpine-native-preview`, a standalone source snapshot with copied
saved jobs and settings. It reads the original installed packs. Runtime files
and dependencies are local only and excluded from Git. Temporary worktrees and
branches are removed after preserving the tag.

To recreate, extract `prototype/native-map-2026-09-07` into a new local directory,
install dependencies, point `ALPINE_PACK_ROOT` to the installed packs, and run
Next on a free port. Preview jobs/settings are independent of the main app.
