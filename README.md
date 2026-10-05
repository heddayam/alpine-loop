# Alpine Loop

A local desktop app for finding loops and lollipops from mapped trails. Choose
one or more prepared mountain regions, set distance, climb, repeated-trail and road limits,
and compare results as exploration continues. Every shown route meets the
requested constraints; unfinished work stays visible.

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
loads one section at a time, while searching every eligible start across the
selected sections. Missing or unprepared coverage is disclosed.

Search regions and prepared data sections share the same identity and exact
footprint. Select regions from the list or click their map polygons. Every
eligible start in those regions is explored; panning and zooming only change the
view. There are no separate named rectangles or custom drawing scopes. Unknown
pedestrian access is included and labeled by default, and can be excluded.
Explicit prohibitions are respected.
Road and parking starts respect mapped car-access restrictions separately from
walking permission. A vehicle-closed track can remain walkable without creating
a start at its trail junction. Unknown access is labeled; mapped road contacts
do not certify legal parking or current road conditions.

## Routes and progress

Search explores eligible starts without a time or result cap. You can stop and
keep the choices found so far. Reloading reconnects while the server lives;
server restart recovery is outside the product scope.

Small trail variations are grouped when the full trail path and loop each
overlap by at least 95%, with no connected difference longer than 500 meters.
Each qualifying original start remains available in the hike details. Preferred
connections use mapped access, then less road walking and shorter distance.
Only independently qualifying directions can be switched or exported as GPX.

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
