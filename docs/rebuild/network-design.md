# Loops, lollipops, and named regional preparation

Accepted user revision, 2026-09-28. This replaces statewide connected-network
discovery and storage. [Status](status.md) records implementation evidence and
remaining real-data acceptance. Keep local Next.js, MapLibre, SQLite, Full search,
developer builds and prepared downloads.

## Product

A generated hike is one node-simple physical cycle, optionally reached by one
node-simple stem retraced in reverse. Stem and cycle share only their attachment.
No figure-eights, chained loops, extra retraced branches or multiply traversed
cycles, even among close matches. Numerical relaxation remains explicit. A
zero-repeat request accepts simple loops only. Saved older results remain readable.

Users select areas containing eligible starts and review their download size.
The download also contains surrounding trails: selected/search areas never clip
hikes. The UI exposes extent, size, installed state and relevant download actions;
no graph IDs, topology statistics or developer build controls are needed.

## Distance bound

Requested hikes are limited to 40 miles. The existing search explores up to 125%
of the requested maximum for clearly labeled close matches: at the cap, 50 miles.
Every point on a closed walk of length L is at most L/2 straight-line distance
from its start, because both paths between that point and the start have to cover
that distance. This holds for loops, lollipops and directed edges.

Preparation therefore covers every eligible start plus a conservative 25-mile
buffer. A bounding rectangle over that buffer is deliberately larger than the
minimum circle. Latitude/longitude expansion uses a conservative radius and the
furthest reachable latitude. Unsupported polar/antimeridian buffers fail.
The planner rejects missing provider coverage anywhere in this required envelope
before data processing. Explicit reviewed exclusions are hard boundaries within
it. Source coverage is a configured guarantee of extent, not proof that OSM has
mapped every trail correctly.

The distance cap, close-match multiplier and preparation buffer share constants.
Changing any of them requires rebuilding affected data and rerunning the boundary
fixtures. This bound establishes geographic sufficiency, not exhaustive route
enumeration or a bound on trail density and search complexity.

## Local pipeline

`data regions` lists the pinned catalog. `data plan central-cascades` previews the
named trailhead footprint and routing support; `data build central-cascades` builds it.
Named download groups cover the complete declared territory. Washington follows
GMBA mountain ranges and foothills, completed by named surrounding areas. California
preserves the four existing footprints. Historical mountain footprints and reviewed
approaches remain included. Names, provenance and approach review belong to the
catalog; each area loads one static boundary file. There is no runtime county
registry, spatial clustering or boundary-generation step. Broad range outlines
organize downloads; a separate pinned GMBA Standard input identifies mountain
terrain without a new relief/elevation analysis pipeline.

After normalization, the shared access discovery finds actual start candidates
inside the start footprint and counts building centroids through a spatial index.
Evidence belongs to actual mapped entrance nodes; parking nominates one hiking
contact on its own feature, with a mapped road/track contact. There is no nearby-road
test, disconnected trail snap or borrowing names/confidence from arbitrary signs
within 250 m. Unmarked street-to-trail entrances remain candidates. A marked hiking
approach may connect along at most 250 m of actual hiking paths to a track entrance.

Public/unknown candidates with 0–9 buildings within 500 metres qualify if an
undirected walking path reaches a mapped hiking link touching GMBA Standard terrain
within 25 miles. Paths, walking-eligible tracks, bridleways, steps and
footways/pedestrian ways with trail context seed terrain distance; ambiguous walking
links and general-purpose roads cannot self-qualify. They can remain route/approach
links. Mountain tracks remain eligible because the [OSM track definition](https://wiki.openstreetmap.org/wiki/Tag:highway%3Dtrack)
includes forest, fire and recreation roads; the tag itself grants no access.
The source mask is static,
licensed and pinned in [hiking terrain](../../data/coverage/hiking-terrain.md).
Low foothills can be omitted; this is a conservative product heuristic, not proof
that every returned loop visits mountain terrain or that every useful hike is kept.

One multi-source Dijkstra pass from terrain-link endpoints removes disconnected
lowland candidates; the existing pass from surviving starts prunes nearby trails.
The two passes reuse the same fixed arrays and indexed heap. No graph traversal
per start or additional DEM acquisition is needed. The 25-mile limit follows the
closed-walk bound above, preserving long connected valley approaches instead of
requiring the entrance itself to be in mountains. Direction/access relaxation can
retain extra candidates; route search still enforces the actual graph constraints.
Candidate identities and parking nominations are frozen before pruning; final ranking
and components run once on the measured graph. Any vertex on a
closed walk of at most 50 miles must be within 25 miles of its start in that graph.
A physical edge is retained only when both endpoint distances are finite and
`d(u) + edgeLength + d(v) <= 50 miles` (with conservative numerical tolerance).
Different nearest seeds only make this bound more permissive. Direction/access
constraints are still applied in the real graph; directed outward distance alone
would incorrectly prune some legal cycles. Pruning precedes all DEM acquisition
and measurement. Full local access/building context remains available.

Only tiles owning actual retained elevation samples are resolved. Corridor
compaction preserves starts, junctions, metadata/direction boundaries and rings,
retains all geometry/profile samples, sums additive costs and recomputes grade
across joins. Biconnected components remain internal search structures. No
statewide connectivity discovery, network inventory or bbox CLI remains.

Osmium still scans the compressed provider extract. Only local trail/access/
building context enters normalization. Temporary extracts and raw joins are
removed; completed local stores are sealed and reusable. Incomplete imports
restart, and child processes are checkpointed and reaped on cancellation.

Unlabelled footways/pedestrian paths are possible walking links, as explicitly
approved by the user. They no longer require connectivity to a known trail far
away. Explicit sidewalk/crossing tags remain excluded from route edges; access,
direction, provenance and reviewed restrictions still apply. This broader policy
can include urban pedestrian links; it does not imply public access or trail quality.

Node selection plus sequential parent scans and reference completion preserve
included ways and supported building relations within the configured memory cap.
A valid budgeted route has all its vertices within the routing buffer. An extra
context margin protects edge-boundary selection. Context features crossing or
enclosing the whole extract without an inside vertex can still be absent;
building/access evidence is therefore not a completeness certificate.

Completed action receipts validate dependencies and reuse immutable graph bytes before
normalization, metrics or topology. Publication rehashes compressed transport and
reuses semantic audits; explicit inspect still scans every graph. A shared metric cache keys each physical segment's geometry,
elevation product and metric algorithm, allowing overlap reuse. Local topology
and stored graph geometry may be duplicated across overlapping areas. No global
connectivity registry, merger service or promise of zero repeated work remains.
Adding an area preserves existing artifacts; rebuilding the same start area
replaces its catalog entry. Conflicting retained source pins fail.

## Runtime boundary

Each artifact has a start geometry and a larger routing geometry. Installation
coverage and selection overlays expose eligible starts. The reader uses routing
coverage for edges; buffer-only access points are not offered as eligible starts.
For an overlapping start, stable named region IDs determine ownership of one complete local graph
and pins the whole search to it. Independent graphs are never stitched together,
so differences in local portal splitting or topology cannot create false junctions.

Retain bridge approaches and shared junctions within each graph. Biconnected blocks
and corridor contraction still accelerate simple-cycle search; they are not
installation units and need not be small. Do not enumerate every cycle at build
time or invent links across source gaps. Cancellation, exact/close separation,
constraint validation and bounded search remain authoritative.

Every artifact is independently audited before atomic catalog activation.
Failed builds leave the previous catalog active. Downloads remain atomic, running
jobs pin installations, and saved results retain their references. Independent
official-source comparisons remain diagnostic rather than additional routing edges.

## Established work informing decisions

[Osmium tags-filter](https://docs.osmcode.org/osmium/latest/osmium-tags-filter.html)
retains referenced objects by default and can read a source in multiple passes.
[Osmium extract](https://docs.osmcode.org/osmium/latest/osmium-extract.html)
provides complete-way and smart relation extraction; its node-based spatial
selection explains the context limitation above. These established native
operations avoid expanding unrelated statewide geometry into SQLite. They do
not establish a measured performance guarantee for this build.

[NetworkX's cycle implementation](https://networkx.org/documentation/stable/_modules/networkx/algorithms/cycles.html)
uses SCC preprocessing for directed cycles and biconnected decomposition for
undirected cycles. The latter establishes where simple physical cycles can lie;
it does not itself solve weighted hiking constraints or approach selection.

[Gupta and Suzumura (2021)](https://arxiv.org/abs/2105.10094) address bounded-length
cycle enumeration. [Bauernöppel and Sack (2025)](https://arxiv.org/abs/2512.08392)
identify counterexamples and propose a correction. Do not transfer hop-count
blocking rules to weighted distance/elevation without a correctness argument.
The first implementation uses path-local legality and admissible distance bounds;
budget truncation is explicit, with no claim of optimal or exhaustive search.

[Weighted Dijkstra distances](https://networkx.org/documentation/stable/reference/algorithms/generated/networkx.algorithms.shortest_paths.weighted.single_source_dijkstra_path_length.html)
provide the search's return-distance bound. Applied to reversed directed edges,
they give distance back to the start. Our correctness argument is that removing
already-used nodes cannot make that unrestricted shortest return shorter, so it
is a lower bound for every legal continuation. Trail lengths must be nonnegative.

[Bazel's cache design](https://bazel.build/remote/caching) separates input-dependent
action reuse from content-addressed output storage. Apply that pattern locally:
area preparation identity covers actual dependencies; catalog growth alone is not
an input change. No remote-cache service is added.

## Acceptance and limits

Offline regressions cover buffered extent, missing source coverage, local footway
classification, complete references, access rules, metric reuse, unchanged artifact
reuse, interruption cleanup, routes outside the start area, excluded buffer starts,
and overlapping graphs with different records. Real-source build time, peak memory,
disk usage and Full-search usefulness remain a separate acceptance gate.

A 25-mile circle alone is about 1,963 square miles; even a tiny start area is not
a tiny data build. Elevation tiles and source scans can dominate. Local topology
may still be dense and budget-limited. Measure each restored area before making
regional performance claims, using the existing pinned cache and no repeated
regional build as a test.
