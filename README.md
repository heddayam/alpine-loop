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

The first slice reads the ignored `.local-data/rewrite/fresh-north-bend` dataset. Open
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
- The fresh North Bend graph and drawings total about 2 MB compressed. Loading
  these immutable files directly needs no query engine, database server or
  migrations. This is a choice for the measured slice, not a statewide format.
- Current searches stay in memory. No job database, migrations or restart recovery
  are needed for the confirmed experience.
- Vite builds a static React interface. There is no server-rendered page requirement
  to justify Next.js here. React owns the asynchronous form/results state; this
  choice can still be replaced if it increases total complexity.
- Leaflet handles raster maps, area selection and route lines. In the same client
  build it reduced main JavaScript from 306 kB gzip with MapLibre to 109 kB and
  removed the separate map worker. No vector-style or WebGL requirement earned that cost.

The server keeps one current search. A search continues until exploration
finishes or the user stops it; there is no application time or expansion cutoff.
Up to ten distinct choices per start are kept, with no global results cap.
Similar variations are omitted. Results are paged and drawings load when needed;
published choices stay stable while someone inspects or exports them.
The solver shares its graph indexes and retains each start's current path.
Per-start graph-sized distance tables were deleted after the broader data
experiment exposed an 11.56 GiB startup allocation. Slower exhaustive traversal
is acceptable; the remaining memory use still needs measurement on every
acceptance case.
Longer searches are acceptable; timing benchmarks are descriptive, not a reason
to truncate exploration or add complexity. The interface currently targets desktop.

## Evidence and remaining work

The immediate delivery target is one complete North Bend experience. The
[fresh compiler](tools/prepare/README.md) reads pinned OSM and elevation sources
without mountain qualification, a mileage-derived buffer or a runtime database.
It records finite coverage and unresolved access explicitly. An independent
review of actual entrances is still finding source-interpretation issues; the
small slice must pass before coverage expands.

`benchmarks/` freezes 24 requests across three Washington areas and checks
independent source witnesses. Existing results use the inherited pilot, with
its historical omissions. Fresh-source witness recovery, complete long-hike
validation, automatic setup and full-app resource measurements remain unfinished.

The recorded engine observation recovered specific independent witnesses in
10 of 14 proven requests. The other four were still searching and had found other
exact routes. Seventeen of 24 requests finished within the observation window;
seven remained unfinished. These are descriptive measurements on the pilot,
not coverage or speed guarantees. They also predate removal of the per-start
distance optimization, so are not current-engine timings.
See `benchmarks/README.md` for reproduction.

```sh
npm run verify
npm run size
```

The offline tests cover an independent tiny-graph oracle, real compiled-worker/API/GPX
integration, cancellation and source conversion. They make no network requests.
