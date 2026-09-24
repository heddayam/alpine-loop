# Washington Cascades coverage audit and proposed correction

Audit date: **2026-09-24**. Status: **investigation and proposal; architecture
change not implemented**. Code inspected at `45d95bc`, including the West Cady
correction. Generated evidence is ignored under
`.cache/cascades-coverage-audit-20260924/`.

## Conclusion

West Cady was not an isolated omission. The four installed Cascades packs
cover selected hiking systems, but do not establish comprehensive Washington
Cascades coverage. Additional mapped trails are wholly outside their combined
polygons; others have approaches cut off. There is also a separate routing
limitation: a route must fit in one pack even when its entire geometry lies in
the combined coverage of several installed packs.

The earlier completion claim was too broad. Successful builds, clean integrity
audits and representative route scenarios established the quality of the
selected content, not completeness of the requested geography.

## Evidence and limits

Compared the four current committed boundaries, including Central v2, against
the independently extracted **2026-08-01 Washington OSM snapshot**, SHA-256
`3bea264079e184675aac7d8ab104bff5339b9e3656a36c084f96f616271a0e4e`.
This avoids starting the audit with an already clipped regional topology.

The following are confirmed whole OSM ways outside **every** Cascades pack.
Lengths are source-line lengths, not advertised hike distances or round trips.
The selected examples have zero inside vertices and zero segment/polygon-ring
intersections. The northern audit also checked its examples with the
repository's full-line predicate against the exterior of all pack outer rings.
These conclusions do not rely only on endpoint or vertex tests.

| Area | Example outside all four packs | OSM way | Approximate source length |
| --- | --- | --- | ---: |
| Mountain Loop | Mount Pilchuck Trail #700 | `37583693` | 4.2 km |
| Mountain Loop | Mount Pugh Trail | `178114539` | 6.8 km |
| Mountain Loop | Three Fingers–Goat Flats–Saddle Lake | `372658378` | 9.4 km |
| Kachess | Kachess Ridge Trail #1315 | `167498627` | 9.7 km |
| Entiat | North Fork Entiat Trail | `430461681` | 12.3 km |
| Snoqualmie approaches | McClellan Butte Trail | `186189742` | 6.9 km |
| Wenatchee east slope | Mission Ridge Trail | `5836851` | 18.0 km |
| Wenatchee east slope | Devils Gulch Trail | `426561498` | 18.6 km |
| Taneum | Taneum Ridge Trail | `468246429` | 19.5 km |

Independent USFS review maps describe the
[Mountain Loop systems](https://www.fs.usda.gov/Internet/FSE_DOCUMENTS/fseprd530006.pdf),
[Cle Elum/Kachess systems](https://www.fs.usda.gov/Internet/FSE_DOCUMENTS/fseprd557612.pdf),
[Entiat systems](https://www.fs.usda.gov/Internet/FSE_DOCUMENTS/fseprd583796.pdf),
and [Mission Ridge/Devils Gulch system](https://www.fs.usda.gov/Internet/FSE_DOCUMENTS/stelprdb5313092.pdf).
These support geographic review, not current conditions or permission claims.

Partial omissions also occur on Stafford Creek (`5924233`), Iron Bear
(`375193691`), Lost Creek Ridge (`372783759`), Heather Lake (`380176708`),
and Duncan Hill (`594034342`). These are not simply empty land between packs.
Exact retained mileage and resulting portal/cycle loss require a compiled
graph comparison; vertex ratios are not mileage percentages.

The southern audit also confirms entire North/South Fork Taneum and Domerie
Peak ways outside coverage, using zero inside vertices and zero segment/ring
intersections. Mission Ridge and Devils Gulch have shared mapped junctions;
so do the screened Taneum/Cle Elum Ridge trails. These are omitted connected
systems, although this audit has not proved their closed-route eligibility.
Washington-side Gorge
trails were explicitly deferred by the original planning brief, and Yakama
Reservation coverage was explicitly excluded. Such exclusions must be shown
as scope decisions, not silently counted as accidental gaps or automatically
included.

This is a confirmed set of counterexamples, **not an exhaustive missing-trail
inventory or a percentage of all Cascades trails**. The project has no
independent, machine-readable definition of that denominator. The initial
screens include named ways and broad geographic windows; unnamed trails,
source omissions, restrictions, and loop eligibility require separate review.
A missing out-and-back trail does not by itself prove that a valid closed
route was lost. Presence in OSM does not establish current passability.

## Why West Cady disappeared

1. **The scope was narrowed while drawing the packs.** Central v1 used Glacier
   Peak, Alpine Lakes and Teanaway outlines plus selected approaches. Wild Sky
   and Henry M. Jackson were absent. West Cady was also south of North's
   coverage. Its three mapped trail ways were present in the pinned source;
   none of their 746 vertices was in the original Central polygon.
2. **Extraction made the omission invisible downstream.**
   `lib/data/osm/pipeline.ts:79` extracts using the pack polygon before
   normalization. Entirely omitted systems never enter its regional audit.
   `lib/data/compiler.ts:180` then rejects individual segments leaving that
   same polygon. This correctly enforces the chosen boundary, but cannot
   establish that the chosen boundary is sufficient.
3. **Acceptance checked containment, not completeness.**
   `lib/data/audit/sqlite-pack-audit.ts:524` checks that persisted edges remain
   inside coverage. Scenarios exercise a curated selection of included
   systems. Neither compares the release with an independent family-wide
   source inventory. Deterministic builds can reproduce an omission exactly.
4. **There was a second, independent trailhead defect.** Merely adding West
   Cady's geometry still produced no nearby start. The source access junction
   joins a `highway=track` and a path; the old portal rule required a
   street/service-road contact. The v4 derivation adds the exact marked
   track/path-junction case. The installed Central pack has been rebuilt with
   it; the other three current packs predate that change.
5. **There was no family-level owner or release gate for negative space.**
   Parallel per-pack execution followed the existing checklist. It did not
   establish a common list of systems that must be covered or explicitly
   excluded. This is a planning and integration failure; additional workers
   or build repetitions would not fix it.

The high-level regional expansion roadmap also still describes the newer
packs as unactivated, despite the registry and activation evidence. That
stale summary is a secondary documentation problem, not the cause of the
geographic omissions.

### Additional candidate access gaps

A bounded screen of the three older packs found 37 marked OSM trailhead nodes
at track/non-track trail junctions with nonrestrictive way tags. All 37 nodes
exist in the published graphs, but only one is itself a published portal.

| Installed pack | Screened junctions | No published portal within 250 m |
| --- | ---: | ---: |
| North | 21 | 12 |
| Rainier–Goat Rocks | 8 | 7 |
| Southwest | 8 | 4 |
| Total | 37 | 23 |

Examples are Cedar Falls (`node/50047578`, nearest portal 1.20 km), Willow
Tree (`node/4441534245`, 1.61 km), and Observation Peak (`node/50474871`,
2.25 km). This is a source-tag/junction/proximity screen, not a replay of
all v4 derivation rules or proof of eligible cycles. It demonstrates why a
family-wide portal audit is needed; it does not promise that rebuilding
creates 23 usable starts. See the ignored `portals/audit.py` and per-pack JSON
results for the exact source/database inputs and measurements.

## Why overlap alone is insufficient

`lib/server/search.ts:23` opens a solver with one pack and that pack's exact
coverage. Quick searches combine independently generated results; Full
searches also resolve each start to one pack (`:124`).
`lib/search/routes.ts` merges/deduplicates finished routes, not trail graphs.

Consequently, if a cycle needs an edge exclusive to pack A and an edge
exclusive to pack B, neither solver can find it. A map showing their combined
coverage can conceal that limitation. This is established from the code; this
audit does not claim a measured count of otherwise-valid lost seam cycles.

The charters already document split PCT geometry at the Rainier/Southwest
seam. That is evidence of an internal cut, not by itself proof of a missing
closed hike. Increasing overlaps can rescue selected routes, but requires a
formal bound to guarantee all supported routes. The current criteria cap is
30 miles; a graph-distance halo could be designed around a rigorously defined
search horizon, including close-match behavior. No such invariant is
implemented today.

## Recommended design

### 1. Define and audit coverage independently of packaging

Create a versioned Washington Cascades coverage specification: a broad,
continuous geographic review envelope, a registry of intended hiking
systems/approaches, and explicit exclusions with reasons. Review the entire
Washington source before narrowing it. Include a fringe review outside the
envelope so an overly narrow envelope cannot validate itself.

Do not derive the intended scope from the union of today's four polygons.
That would preserve the omissions by definition. Resolve foothills, eastern
systems, and the Washington Gorge explicitly. Keep scope and access separate:
unknown access remains included by default; restrictive evidence stays
restrictive; an administrative polygon does not grant access.

Use pinned OSM as the topology baseline, with independent USFS/NPS/DNR and
state trail inventories as omission checks. For example, the
[USFS trail service](https://apps.fs.usda.gov/ArcX/rest/services/EDW/EDW_TrailNFSPublishWithDataStatus_01/MapServer)
includes trail-data availability as well as published trails. Pin reviewed
snapshots before making them build inputs. Official disagreement should create
a review item, not an automatically invented connector.

### 2. Expose one continuous Cascades graph to routing

**First implementation to benchmark: one rebuilt Washington Cascades routing
dataset**, with North, Central, Rainier–Goat Rocks and Southwest retained as
named start-selection regions. Recompile from canonical source topology;
concatenating the four existing SQLite files would retain holes, duplicate
edges and inconsistent derived state.

The exact installed coverage remains the hard geometry limit. Search regions
still select starts only. No connections may be invented between disconnected
components. Olympics can remain a separate routing dataset; its mountain and
beach coverage should receive the same inventory-based acceptance process.

Keep ingestion, coverage classification, graph compilation, and graph reading
behind a small shared interface. The solver should receive a coherent graph
snapshot and exact installed coverage without knowing which physical files
hold its edges.

Do not assume a monolithic build will meet memory targets. Today's four
SQLite files total about **1.19 GiB**, including overlap, before filling gaps;
disk size is not a RAM estimate. Benchmark cold build/audit, peak memory,
eligible-start discovery, Quick and Full searches against the existing
constrained-memory target before activation.

If profiling rules out one physical dataset, use storage partitions behind a
unified graph reader. Require common source/compiler versions, globally
consistent source-node and physical-edge identities, reconciled access and
elevation, deduplicated portals, graph-wide connectivity/cycle derivation,
and atomic snapshot/dependency installation. Missing partitions must be
reported as incomplete coverage. Do not silently fall back to independent
per-partition solving.

### 3. Make unexplained loss a release blocker

Produce a machine-readable ledger with one disposition for every expected
source segment and reviewed trailhead:

- included in the published graph;
- intentionally outside scope, with a reviewed reason;
- retained but restricted under the access model;
- missing/ambiguous source topology;
- failed compilation/elevation or unresolved access-point derivation.

Distinguish geographic inclusion, source support, retained graph connectivity,
valid start derivation, reachable cycles and solver results. A no-cycle start
must not be misreported as missing geography. Proximity to an unrelated
trailhead is not evidence of a usable approach.

Gate releases on **zero unreviewed omissions**, not a high aggregate coverage
percentage. An exception must carry provenance, rationale, review ownership
and affected systems; source refreshes must reopen changed exceptions. Report
covered length, exclusions and unresolved length separately and by subregion.
The gate must compare against independent expected input, not just whatever
the compiler happened to emit.

Add offline regression fixtures for an entire omitted system, a cut approach,
the marked track/path trailhead case, and a loop spanning a storage seam.
Compare partitioned and unpartitioned reachable topology on fixtures. Retain
the real West Cady checkpoint, add other confirmed omissions after scope
review, and test exterior-edge behavior. A connected graph still does not
guarantee a budgeted heuristic solver enumerates every possible route; report
search truncation separately.

## Suggested execution gates

1. **Coverage specification and audit tool.** Classify the omissions above,
   enumerate all source segments in the independent scope plus its fringe,
   and commit a reviewed exception ledger. Do not call the family complete
   while intended scope is unresolved.
2. **Continuous graph prototype.** Build from the same pinned source with
   consistent v4 portal derivation; compare expected source/graph/portal
   inventories and benchmark resources. Decide physical storage from the
   measurements.
3. **Routing integration.** Preserve existing area/access/closed-route
   semantics, demonstrate seam traversal without synthetic connectors, and
   pass existing plus new regression scenarios.
4. **Release.** Repeat deterministic offline builds and required application
   checks, migrate selectors/install pointers atomically, show actual
   coverage limitations, and update the roadmap/status together.

No new pack builds or runtime changes were made for this investigation. The
report proposes replacing the four-pack routing assumption; it does not
silently amend the accepted architecture or mark a new implementation gate
complete.
