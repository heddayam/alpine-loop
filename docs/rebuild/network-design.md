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

## Smallest implementation

- Inventory the pinned source before applying the requested geographic selector.
  Respect source coverage, explicit exclusions and access restrictions. Preserve
  source-node identity and distinct parallel physical trails. Geography selects
  entire networks; it does not create preparation seams.
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

## Implemented builder boundary

Connectivity is rediscovered from pinned source records. Normal planning follows
contact between provider coverage polygons to choose source extracts; only exact
eligible source-node identities create trail connections. Complete member ways
remain available as compiler context when exclusions cut off some segments.

Preparation receipts depend on network membership, sorted context records,
source provenance, relevant verified DEM products, metadata and algorithm versions.
A cache hit verifies its immutable file and skips metric sampling and topology.
Catalog activation audits every object sequentially, with disk-backed identity
collision checks; it does not rerun topology. A source change may merge networks
and invalidate their artifacts. Expanding selection within the same pinned source
snapshot cannot merge them. No dynamic merger service or persistent key registry
is necessary.

Only final catalog activation is atomic. Completed network receipts survive an
interrupted build; failed work leaves the previous catalog active. Empty selections
are explicit no-ops. Per-network scratch databases and transient named-area
extracts are cleaned up. Source/metric caches are retained. The user later authorized deleting existing
geographic installations; saved route results and settings remain intact.
Independent official-source proximity comparisons remain diagnostic and never
claim exact installed-feature membership from a network envelope.

## Established work informing decisions

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

[Bazel's cache design](https://bazel.build/remote/caching) separates input-dependent
action reuse from content-addressed output storage. Apply that established pattern
locally: network preparation identity covers actual dependencies; catalog growth
alone is not an input change. No Bazel service or remote-cache dependency is added.

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
