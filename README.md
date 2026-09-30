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

The first slice reads the ignored `.local-data/rewrite/pilot` dataset. Open
http://127.0.0.1:3000; set `PORT=3011` if another app uses that port. This development
slice requires the already-prepared pilot files. Automatic first-run data acquisition
and hosted delivery are still required before release.

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
- Immutable graph and drawing files replace traversal through SQL. The pilot is
  small enough to load directly; this does not establish the right statewide format.
- Current searches stay in memory. No job database, migrations or restart recovery
  are needed for the confirmed experience.
- Vite builds a static React interface. There is no server-rendered page requirement
  to justify Next.js here. React owns the asynchronous form/results state; this
  choice can still be replaced if it increases total complexity.
- Leaflet handles raster maps, area selection and route lines. In the same client
  build it reduced main JavaScript from 306 kB gzip with MapLibre to 109 kB and
  removed the separate map worker. No vector-style or WebGL requirement earned that cost.

The runtime currently allows two simultaneous searches and retains four recent
searches. A search continues until exploration finishes or the user stops it;
there is no application time or expansion cutoff. Similar routes at a start are
grouped by shared trail distance; up to
10 choices per start and 300 overall are shown. Display limits do not stop search.
Published choices stay stable while someone inspects or exports them. These
prototype choices require further evaluation, especially for very large areas.
Longer searches are acceptable; timing benchmarks are descriptive, not a reason
to truncate exploration or add complexity. The interface currently targets desktop.

## Evidence and remaining work

`benchmarks/` freezes 24 requests across three Washington areas and checks independent
source witnesses. The pilot retains historical source omissions, documented in the
app. It is not complete Washington coverage. A fresh data pipeline, a diverse results
shortlist, complete long-hike validation, automatic setup, full-app resource
measurements and hosted delivery remain unfinished.

The recorded engine observation recovered specific independent witnesses in
10 of 14 proven requests. The other four were still searching and had found other
exact routes. Seventeen of 24 requests finished within the observation window;
seven remained unfinished. These are descriptive measurements on the pilot,
not coverage or speed guarantees. See `benchmarks/README.md` for reproduction.

```sh
npm run verify
npm run size
```

The offline tests cover an independent tiny-graph oracle, real compiled-worker/API/GPX
integration, cancellation and source conversion. They make no network requests.
