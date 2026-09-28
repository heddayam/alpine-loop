# Loops, lollipops, and complete trail networks

Accepted user revision, 2026-09-28. Implementation and acceptance are tracked in
[status](status.md). Replaces arbitrary closed-walk search and geographic units
of preparation. Keep local Next.js, MapLibre, SQLite, Full search, and developer
builds with prepared downloads.

## Product

A generated hike is one node-simple physical cycle, optionally reached by one
node-simple stem retraced in reverse. Stem and cycle share only their attachment.
No figure-eights, chained loops, extra retraced branches or multiply traversed
cycles, even among close matches. Numerical constraint relaxation remains explicit.
A zero-repeat request accepts simple loops only. Saved older results remain readable.

The user selects complete connected networks on the map and reviews their full
extent and download/installed size before installation. Source-boundary limitations
remain visible. Search areas continue to filter starting points only.

The app exposes trail downloads: map selection, full extent, download/device size,
installed state and the actions relevant to that state. With no selection, show
one map-selection hint instead of zero-size summaries and disabled buttons.
Network IDs, graph statistics and build controls stay in developer tooling.

## Smallest implementation

- Discover every network in the explicitly pinned source set.
  Respect source coverage, explicit exclusions and access restrictions. Preserve
  source-node identity and distinct parallel physical trails. Inspect the saved
  network catalog and choose IDs before preparation. No geographic build selector
  or implicit hike recipe remains.
- Prepare, analyze, audit and export each selected network independently. Reuse
  existing verified source and metric primitives; remove the tiled build loop.
  Keep immutable network artifacts separate from catalog identity so adding an
  unrelated network does not rewrite old bytes or rerun its topology analysis.
- Retain bridge approaches and shared junctions. Biconnected blocks contain simple
  cycles, but may remain large. Do not enumerate all cycles at build time, invent
  connectors across source gaps, or add dynamic connectivity maintenance.
- Contract corridors while preserving direction and original trails. Use one
  bounded loop/lollipop search with authoritative route-shape validation. Keep
  cancellation, exact/close separation, grade/elevation rules and diversity.
- Continue atomic installation, worker isolation, pinned running jobs and saved
  result retention. The user chose to delete old geographic data and start fresh;
  saved route results remain separate from installed graph data.

## Distance-budget proposal — not yet implemented

The request limit is 40 miles. For the proposed local preparation model, exact
closed routes need complete mapped coverage within 20 miles of eligible starts.
The existing solver explores up to 125% of requested maximum distance for labeled
close matches: at the request cap, 50 miles of exploration requires a conservative
25-mile geographic buffer. Every point of a closed route of length L lies within
L/2 straight-line distance of its start, since both outgoing and returning paths
must span that distance. Source completeness and conservative extraction still
need verification; the buffer alone cannot repair missing source data.

This records the preparation implication of the new limit, not an implemented
replacement for the statewide discovery builder described below.

## Implemented builder boundary

Discovery persists connectivity once per verified source/restriction fingerprint.
The source recipe explicitly lists provider extracts and their supported bounds;
only exact eligible source-node identities create trail connections. Complete
member ways remain available as compiler context when exclusions cut off segments.
The immutable discovery catalog and disk inventory are reused by explicit-ID
builds. Discovery performs no DEM acquisition, edge metrics, route topology,
named-area preparation, independent-reference downloads or release publication.

Source normalization is filter-first. Osmium selects a conservative superset of
all hiking classifications (including tracks, ambiguous footways and permitted
road connectors), with complete referenced nodes. Global contextual-footway
promotion precedes connectivity. SQLite retains normalized trail ways; temporary
node/reference joins and non-trail rows are discarded. No statewide building,
road-context, excluded-feature inventory or raw-batch checkpoint store remains.

Preparation extracts context only for selected network envelopes, buffering each
component by 0.01 degree as in the context queries. Building multipolygon members
are completed before normalization. Context-local footway classification cannot
replace the global trail classification. Per-source/per-envelope context stores
are verified and reused, then closed before the next network. Unsupported
building diagnostics apply to that selected context, not the whole state.

The geographic context extraction is node-based: a road crossing the buffer with
all nodes outside, or a building enclosing it with no vertex inside, can be
absent. This affects access/building evidence and is disclosed in the release;
it cannot truncate or join trail networks, which are discovered without this
geographic extraction. Source completeness and regional performance remain
unverified until the real-data gate. Do not equate reduced retained data with a
promised runtime or disk bound.

Completed normalized stores have one immutable-data seal; metric caches are
excluded. Incomplete imports roll back and restart from the filtered source.
The former row-range checksums, raw-record resume and legacy seal compatibility
are removed. Native subprocesses are checkpointed and reaped, and temporary
extracts are deleted on completion, cancellation and failure.

The offline HTML inspector shows full network envelopes, source trail length,
node/physical-edge counts, source-boundary limitations and undirected cycle rank.
Envelopes are not exact trail lines, and a structural cycle is not proof of a legal
hike. Prepared/download byte sizes are unknown until compilation. Inspection is
metadata-only; builds additionally verify the inventory digest and current inputs.
Unknown, duplicate, empty, stale or corrupted selections fail rather than choosing
a replacement network. The selected IDs define the next published catalog.

Preparation receipts depend on network membership, sorted context records,
source provenance, relevant verified DEM products, metadata and algorithm versions.
A cache hit verifies its immutable file and skips metric sampling and topology.
Catalog activation audits every object sequentially, with disk-backed identity
collision checks; it does not rerun topology. A source change may merge networks
and invalidate their artifacts. Expanding selection within the same pinned source
snapshot cannot merge them. No dynamic merger service or persistent key registry
is necessary.

Discovery directories and final release catalogs are activated atomically.
Completed network receipts survive an interrupted build; failed work leaves the
previous release catalog active. Empty build selections are rejected. Per-network scratch databases and transient named-area
extracts are cleaned up. Source/metric caches are retained. The user later authorized deleting existing
geographic installations; saved route results and settings remain intact.
Independent official-source proximity comparisons remain diagnostic and never
claim exact installed-feature membership from a network envelope.

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

[Connected-component semantics](https://networkx.org/documentation/stable/reference/algorithms/generated/networkx.algorithms.components.connected_components.html)
define the storage partition on the underlying eligible physical graph. The
implementation reuses disk-backed union-find to bound resident graph memory;
it does not claim the in-memory reference's linear traversal performance on disk.

[NetworkX's cycle-basis documentation](https://networkx.org/documentation/stable/reference/algorithms/generated/networkx.algorithms.cycles.cycle_basis.html)
distinguishes an independent cycle basis from all possible cycles. For a connected
physical multigraph, a spanning tree has n−1 edges, leaving m−n+1 independent
cycles. We display that rank without enumerating cycles; direction, access and
hiking constraints still determine usable routes.

[Bazel's cache design](https://bazel.build/remote/caching) separates input-dependent
action reuse from content-addressed output storage. Apply that established pattern
locally: network preparation identity covers actual dependencies; catalog growth
alone is not an input change. No Bazel service or remote-cache dependency is added.

[SQLite transaction guidance](https://www.sqlite.org/faq.html#q18) supports batching
source-inventory writes. The unpublished discovery database uses one transaction,
a bounded page cache and [disk spill](https://www.sqlite.org/pragma.html#pragma_cache_spill);
failed scratch inventories are discarded rather than exposed as reusable results.

## Evidence and acceptance

The read-only Washington census processed 3,985,803 physical source segments in
33.2 seconds after a 95.6-second local copy. It found 33,531 components, a largest
network of 3,125.5 km, and 9,305 cyclic biconnected blocks with a largest block of
1,411.4 km. Peak RSS was 1.28 GiB; the temporary 10 GB copy was deleted.
These are filtered-source facts, not proof of real-world network independence:
PCT continuity has not been traced, direction was ignored, and the source includes
tracks and may omit connecting road crossings. Generated evidence remains ignored
under `.cache/topology-census/`.

Before regional acceptance, prove strict route shape and source-identity continuity
on small offline fixtures; independent network append/reuse; merge invalidation;
full-extent preview; atomic download recovery; and preservation of saved results.
Use bounded focused tests, then integration/build/browser checks. No repeated
regional build as a test. Record production, test and documentation deletion
counts separately. Retire completed worktrees and temporary outputs promptly.
