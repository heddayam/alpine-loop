# Alpine Loop

A fresh implementation of constraint-based hiking loops. This branch is an
unfinished real-data slice; the acceptance requirements are in `docs/goal.json`.

The old application is preserved at `archive/before-product-rewrite-2026-09-30`.
It is not an active build or a compatibility target.

Development currently uses Node.js 24:

```sh
npm ci
npm run build
npm start
```

The app reads its installed snapshot from the ignored `.local-data/network` directory;
`ALPINE_DATA` can point a development instance at another snapshot. Open
http://127.0.0.1:3000; set `PORT=3011` if another app uses that port. This development
slice currently requires the prepared files on this machine. Automatic first-run
data acquisition remains unfinished. Hosting is deferred at the user's request.

The working flow is map area → distance/gain/repetition → progressive exact routes
→ route inspection → GPX. Reopening the browser restores the latest search while
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
- Current searches stay in memory. No job database, migrations or restart recovery
  are needed for the confirmed experience.
- Vite builds a static React interface. There is no server-rendered page requirement
  to justify Next.js here. React owns the asynchronous form/results state; this
  choice can still be replaced if it increases total complexity.
- Leaflet handles raster maps, area selection and route lines. In the same client
  build it reduced main JavaScript from 306 kB gzip with MapLibre to 109 kB and
  removed the separate map worker. No vector-style or WebGL requirement earned that cost.

The server keeps one current search. It continues until exploration finishes or
you stop it; there is no application time or result-count cutoff. Similar routes
are grouped across all starting places: both the overall physical path and the
loop must overlap by at least 85%. One stable representative stays available;
substantially different loops and approaches remain separate. Results are paged,
and geometry loads when needed. This similarity rule is a product heuristic,
not a universal definition of a distinct hike.

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

The installed Cascades snapshot has 222,173 physical sections and 11,647 starts
in 73.86 MB of runtime files. Preparation took about 198 seconds and peaked at
3.31 GB in the Python compiler process; native children were not included in
that peak. Partitioned output does not establish bounded statewide preparation.
The [compiler notes](tools/prepare/README.md) describe pinned OSM/DEM sources,
access policy, topology, elevation and the storage contract.

An audit of the earlier 2,056-option Rainier search exposed three product defects:
an expanded map selection, duplicate hikes from different starts, and road-heavy
walks passing the trail requirement. See `benchmarks/route-quality-review.json`.
The implemented corrections must still be judged against useful real hiking
choices; large result counts are not a quality certificate.

`benchmarks/queries.json` freezes 24 requests across three Washington areas.
The current [HTTP measurement harness](benchmarks/README.md) records resolved
road settings, incomplete exploration, memory and cancellation. The current 24-case
run had no failures: 7 completed, 16 were still searching after 30 seconds, and
1 was limited by prepared coverage. Peak measured process RSS was 569 MB,
excluding the browser; all Stops returned within 5.7 ms. Independent
source replay keeps the Little Si and Paradise witnesses eligible under the road
defaults. The fixed Middle Fork witness remains in the network, but its 1.88 miles
of roads/tracks exceed both defaults. That is a constraint exclusion, not missing
topology. `benchmarks/network-review.json` records the source and storage evidence.

A five-second installed-area observation attempted all 11,647 starts and fully
explored 2,059. It peaked at about 758 MB of RSS including the server, worker and
HTTP measurement client; browser memory was excluded. Stop returned in 11 ms.
The window included loading and 3.5 seconds of solver time, not completion. Statewide preparation, broader fresh
source validation, and automatic first-run data acquisition remain unfinished.
Timing measurements are descriptive. Longer searches are acceptable.

```sh
npm run verify
npm run size
```

The offline tests cover an independent tiny-graph oracle, real compiled-worker/API/GPX
integration, cancellation and source conversion. They make no network requests.
