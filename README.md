# Alpine Loop

A fresh implementation of constraint-based hiking loops. This branch is an
unfinished real-data slice; the acceptance requirements are in `docs/goal.json`.

The old application is preserved at `archive/before-product-rewrite-2026-09-30`.
It is not an active build or a compatibility target.

With Node.js 24 or newer, launch the local app with:

```sh
npm start
```

The launcher installs locked dependencies when needed and builds the app. This
development checkout currently uses the ignored `.local-data/network` directory;
`ALPINE_DATA` can point a development instance at another snapshot. Open
http://127.0.0.1:3000; set `PORT=3011` if another app uses that port. This development
slice currently requires the prepared files on this machine. The download installer
is implemented and tested, but its internal release descriptor remains unset
until prepared data is approved for publication. A fresh checkout without data
fails clearly; automatic first-run delivery is not yet complete. Hosting is deferred.

The working flow is map area → distance/gain/repetition → distinct hike choices
→ route inspection and optional starting-point choice → GPX. Reopening the browser restores the latest search while
the server lives. Restarting the server intentionally expires it.

On desktop, the search form gives way to route choices beside the map. Hovering
or focusing a choice highlights its route; selecting it fits the map and opens
details. Editing restores the original search area. Panning while inspecting
results never changes the submitted query.

## Why this first implementation

- A small Node server keeps search alive after the page closes. Browser-only work
  cannot satisfy that lifetime. A worker keeps route computation off the HTTP thread.
- A versioned network is stored in geographic files. The map selects starts;
  files share physical trail identities and keep crossing sections whole.
  Search loads only a conservative surrounding network for its requested hike
  length. Drawings load separately when a route is inspected. Snapshot IDs and
  file hashes prevent mixing versions; missing topology fails visibly.
- The current search keeps route summaries and section references in a disposable
  SQLite file through Node’s built-in module. This replaces growing object maps
  so longer searches can retain alternatives without keeping them all in RAM.
  The file is closed when the search is replaced or the server shuts down. There
  is no saved-job history, migration system, database setup or restart recovery.
- Vite builds a static React interface. There is no server-rendered page requirement
  to justify Next.js here. React owns the asynchronous form/results state; this
  choice can still be replaced if it increases total complexity.
- Leaflet handles raster maps, area selection and route lines. In the same client
  build it reduced main JavaScript from 306 kB gzip with MapLibre to 109 kB and
  removed the separate map worker. No vector-style or WebGL requirement earned that cost.

The server keeps one current search and continues until exploration finishes or
you stop it. There is no application time or result-count cutoff. Results are
hiking choices, not every permutation through parking paths and roads. Small
trail variations are combined when both the full trail path and the loop overlap
by at least 95%, and each connected difference is at most 500 meters. Fixed
representatives prevent a chain of gradually changing routes from merging distinct
hikes. This is a disclosed similarity heuristic, not a scenic-equivalence claim.

Open a hike directly to inspect its route or choose another qualifying starting
point. Each start retains a qualifying connection, preferring mapped access,
less road walking, then shorter distance. Connector permutations do not create
separate hikes. Different trail approaches and substantial branches remain choices.
Only independently qualifying directions can be switched or exported. Previously
opened routes remain stable when search discovers a better connection.

Road connections have adjustable limits on both total miles and percentage of
the hike. The initial defaults are 1 mile and 10%. Both count every road section
walked, including the return along a lollipop stem. Mapped vehicle tracks and
explicit sidewalks count as connections. Walking permission does not turn a
road into a hiking trail. Route details show the measured road contribution.
Unknown access stays labeled; mapped access is not proof of legal parking or
current trail conditions.

Choosing a named area outlines its exact rectangle. Panning or zooming preserves
that rectangle until you choose “Use map view” or draw another area. The rectangle
is a selection aid, not an official park boundary. It selects starting places;
hikes may extend beyond it. Incomplete prepared coverage is disclosed separately
from unfinished exploration.

## Evidence and remaining work

The installed Cascades snapshot has 222,175 physical sections and 11,649 starts
in 73.86 MB of runtime files. Preparation took about 222 seconds and peaked at
3.06 GB in the Python compiler process; native children were not included in
that peak. Stage measurements put the main memory peak in topology construction, before
elevation sampling. Partitioned output does not establish bounded statewide preparation.
The [compiler notes](tools/prepare/README.md) describe pinned OSM/DEM sources,
access policy, topology, elevation and the storage contract.

An audit of the earlier 2,056-option Rainier search exposed three product defects:
an expanded map selection, duplicate hikes from different starts, and road-heavy
walks passing the trail requirement. See `benchmarks/route-quality-review.json`.
The implemented corrections must still be judged against useful real hiking
choices; large result counts are not a quality certificate. A separate corrected
snapshot also restores two distinct parking contacts that preparation had
suppressed. Every prior start is unchanged, and the original Little Si witness
now passes exact HTTP/GPX recovery; see `benchmarks/prepared-witnesses.json`.
That corrected snapshot is now installed locally. The previous stopped search
was preserved as an ignored review artifact, and its unchanged query was replayed.

`benchmarks/queries.json` freezes 24 requests across three Washington areas.
The current [HTTP measurement harness](benchmarks/README.md) records resolved
road settings, incomplete exploration, memory and cancellation. The latest run
on the corrected snapshot had no failures: four completed, nineteen were still
searching after thirty seconds, and one exhausted the available graph with a
coverage warning. Peak measured process RSS was 580 MB, excluding the browser;
all Stops returned within 3.6 ms. Every reconnect preserved the query and search.
See `benchmarks/results/depth-traversal-network-30s.json`. These observations do
not establish complete discovery or memory use during arbitrarily long searches.

Independent source replay checks each historical witness against current data
and constraints. Seven qualify; seven fail current road, elevation or access
requirements. For example, the fixed Middle Fork witness remains in the network,
but its 1.88 miles of roads/tracks exceed both road defaults. That is a constraint
exclusion, not missing topology. `benchmarks/network-review.json` and
`benchmarks/prepared-witnesses.json` record the source and storage evidence.

The earlier depth-first traversal missed the fixed Stevens-long and Paradise-short
witnesses, and directly similar representatives, during five-minute observations.
The replacement explores progressively longer outward paths at each start,
so a deep branch does not monopolize that start. This changes traversal order,
not accepted routes or completion rules, and adds eight production lines.
Independent exhaustive tiny-graph checks still pass. The current engine also
prunes a prefix when even a conservative return trip would exceed its distance,
climb or road allowance. Optional bound arrays stay within 32 MiB; broader
queries use weaker shared bounds or skip the optimization, preserving exploration.
The complete North Bend comparison keeps the identical 752 directed routes while
reducing examined edges from 6.50 million to 2.26 million. First-route improvements
on the Pratt example were modest. Ordering and depth-count experiments were
rejected because they did not improve that observation.

On the corrected snapshot, all seven independently qualifying original walks
were recovered exactly from their original starts: six within sixty seconds,
and the long Sunrise example in a separate 214-second observation. These
engine checks stopped after recovery; they do not prove complete enumeration.
Engine recovery happens before the app's presentation layer. Earlier HTTP/GPX
checks recovered similar Paradise and Stevens routes
from alternate starts, not those exact original walks. See
`benchmarks/results/discovery-review.json` for limits and pinned evidence.

The earlier implementation retained every graph-path option. A user's actual
Pratt–Denny search exposed why that was wrong: 1,137 options shared 11.8 miles of
trail, with small detours and road permutations multiplying the count. Independent
reconstruction of every saved route reduces those results to four hike choices
and twenty hike/starting-point combinations. The Franklin Falls, Annette-area and
Talapus alternatives remain distinct. Replaying different observed reverse-arrival
orders preserves the same choices; all 36 final directional geometry/GPX checks
match the independently reconstructed routes. This is a stopped-search replay,
not proof of complete enumeration. See `benchmarks/route-quality-review.json`.

The following retention observations predate that correction and demonstrate
storage behavior, not acceptable result quality. The grouped app's completed
North Bend check preserves all 376 reversal-paired
options in 112 groups, matching all 752 directed walks in the separate enumeration audit.
The original Little Si start and both Cedar Falls approaches are available;
their six directional detail/GPX exports match independently reconstructed data.
The old filter hid a Cedar Falls approach more than a mile longer. Separate
thirty-second whole-app observations retained 5,115 options for Paradise-day
at 304 MB peak RSS and loaded Pass-long at 580 MB; neither search completed.
Stops returned within 3 ms. These are bounded observations, not unlimited-duration
memory guarantees or an endorsement of every generated option's hiking quality.

A longer Paradise-day run exposed growing result retention: 67,199 options after
five minutes used 914 MB peak RSS. Disposable disk storage and removal of the
worker’s duplicate option history retained 133,411 options after ten minutes at
277 MB, with Stop returning in 19 ms. At five minutes the new version had 62,085
options, so throughput was not identical. One disk sample was 608 MB at 412 seconds;
it was not a peak measurement. Both searches remained unfinished. Final integrated
checks still preserve every North Bend option and the six independent GPX examples.
The long observation precedes subsequent small lifecycle and grouping-roundoff
fixes; exact code hashes and limitations are in the discovery review. Temporary
storage grows with results; this is not an unlimited-duration memory guarantee.

An earlier five-second installed-area observation, using the previous traversal,
attempted all 11,647 starts and fully
explored 2,059. It peaked at about 758 MB of RSS including the server, worker and
HTTP measurement client; browser memory was excluded. Stop returned in 11 ms.
The window included loading and 3.5 seconds of solver time, not completion.
Statewide preparation, broader fresh source validation, and automatic first-run
data acquisition remain unfinished.
Timing measurements are descriptive. Longer searches are acceptable.

```sh
npm run verify
npm run size
```

The offline tests cover an independent tiny-graph oracle, real compiled-worker/API/GPX
integration, cancellation and source conversion. They make no network requests.
