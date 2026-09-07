# Further simplification assessment

Assessed 2026-09-06 against `f361643` on `codex/system-design`.
Assessment only: no application, test, schema, installed-pack, or saved-job
changes. The completed regional-builder consolidation remains closed.

## Ranked recommendation

Start with **direct feasibility on the original graph**. The user explicitly
allows behavior changes when justified. This stronger design removes obsolete
chain construction and fixes a reproduced minimum-approach defect; old artifact
readability remains required. Map route updates are the next substantial
design opportunity, especially for performance. Results/style cleanup is smaller
and straightforward. Do not pursue a solver rewrite for a line-count target.

Estimates are net physical lines after replacement code, not sizes of files
that could be moved. Positive removals below mean fewer lines; test additions
are stated explicitly. No implementation savings have yet been realized.

| Rank | Candidate | Application reduction | Test/helper change | Confidence |
| --- | --- | ---: | ---: | --- |
| 1 | Original-graph feasibility, corrected cycle approaches, compact types | 280–380 fewer | 70–140 added | Medium on deletion scope; correctness/quality comparison required |
| 2 | One owner for route geometry, focus updates, and result pins | 40–120 fewer | 40–100 added | Low on size; high on repeated-update evidence |
| 3 | One result-card renderer, unused styles, shared copy feedback | 85–130 fewer | 20–50 added | Medium; copy feedback requires race/lifetime tests |
| 4 | Small solver/graph cleanup; retain algorithms | 3 directly; up to about 65 conditional | No deletion established; up to 30 added | High for three lines, low for queue consolidation |

The clipboard estimate is counted only in rank 3, even though several callers
are in the map. Do not sum speculative upper bounds into a commitment. The first
recommendation alone would remove approximately **140–310 combined lines** after
new tests, about **0.5–1.1%** of the measured codebase. The conservative option,
preserving every old encoded value, remains 205–255 fewer application lines
with 20–60 added test lines. There is no evidence here for another 50% reduction,
even allowing worthwhile behavior changes. Many tests already use
meaningful interfaces; deleting them would reduce assurance rather than design
complexity. A smaller test suite is not a warranted outcome for this wave.

## Measurement and scope

The supplied counts reproduce exactly on this checkout:

| Area | Application | Tests/helpers |
| --- | ---: | ---: |
| Data processing and compilation | 7,820 | 3,689 |
| Interface and styling | 4,264 | 1,413 |
| Route generation | 2,261 | 990 |
| Graph storage and queries | 1,180 | 428 |
| Background jobs | 792 | 758 |
| Geographic filtering | 903 | 489 |
| Server coordination | 709 | 322 |
| Other | 1,535 | 1,249 |
| Total | **19,464** | **9,338** |

Method: inspect the 242 tracked `.ts`, `.tsx`, `.mjs`, `.css`, and `.py` files
under `app`, `components`, `lib`, `scripts`, `tests`, and `tools`; count physical
lines including comments and whitespace. Classify `.test.*`, `.spec.*`, all
`tests/`, `test-helpers.ts`, and `__fixtures__/` as tests/helpers. The latter
helper classification accounts for 169 lines that a filename-only test count
would mistakenly call application code. All `app` and `components` files are
in the supplied interface/styling bucket; the other named buckets correspond
to their `lib` directories. Everything else is Other. Fixture adapters used by
pack bootstrap remain application code under this convention.

Documentation, JSON fixtures, generated packs, downloads, dependencies, and
databases are excluded. Moving TypeScript fixtures into uncounted JSON merely
to improve this number would not establish a reduction. New frozen JSON
compatibility expectations must be reported separately when implemented.

The review followed the local codebase-design skill, DEEPENING, and parallel
DESIGN-IT-TWICE process. Three isolated reviewers assessed data, results, and
solver code while the integrator inspected the map, then independently designed
three different interfaces for compact feasibility. Their work was read-only;
there were no delegated implementation commits to integrate.

## 1. Build only the feasibility data that is used

### Current interface and obligations

`buildClosedRouteTopology` in `lib/data/topology-compiler.ts:562` accepts
normalized nodes, compiled directed edges, access points, and build/version
metadata. Production compilation calls it at `lib/data/compiler.ts:446`;
production-storage fixtures call it at `lib/graph/test-helpers.ts:55`.
`writePackDatabase` consumes its result at `lib/data/sqlite-writer.ts:283`.
The entry point is already small and useful. Its oversized returned types and
discarded implementation are the problem, not the function's name.

Its interface includes these facts, beyond its type signature:

- Inputs are not reordered in place. Node and directed-edge IDs use
  `localeCompare`; physical IDs use default sort; numeric keys start at one.
  Duplicate IDs, missing endpoints, inconsistent physical endpoints, and
  inconsistent forward/reverse geometries throw (`topology-compiler.ts:572`).
- Known accepts public trails; inclusive also accepts unknown trails. Context
  roads are excluded. Feasibility needs both a physical cycle and legal directed
  connectivity (`:231–264`). A forward/reverse pair on one physical edge is not
  a hiking cycle.
- Access attachments, metadata/direction changes, bridges and articulations
  determine retained nodes. Chain order assigns numeric identities. Inclusive
  chain IDs start after the **uncompacted known chain count** (`:266–342`,
  `:605–606`). Unmapped legal directed edges still throw (`:376`).
- Reverse Dijkstra chooses the same portal and minimum stem, with deterministic
  equal-distance behavior; invalid connector reconstruction throws (`:436–510`).
- Output order is known then inclusive. Profile hashes exclude build time but
  include the existing empty-array fields and access identities (`:177–219`).

Distinguish live pruning from historical identities. `safeFeasibility` at
`lib/solver/reachable-graph-closed-route-solver.ts:97` uses cycle reachability,
nonnull network, and minimum stem. Its `groupKey` at `:112` combines profile,
network, portal, and connector hash, but only feeds diagnostic sets/counts at
`:485`, `:514`, and `:598–600`. Search iterates `feasible.entries()` and divides
budgets by remaining starts (`:423–450`). Group identity does NOT schedule,
deduplicate, or allocate search. An early review inference to that effect was
incorrect. Identity-only changes need versioning but should leave deterministic
route output unchanged when feasibility and stem facts are unchanged.

### Evidence of unnecessary work

`buildProfile` calculates full decision-edge metrics/member records, block
reports, block links, per-node reports, network summaries, and a full hash.
Immediately afterward `compactFallbackProfile` (`:203–219`, called at `:608`)
zeros the primitive counts and replaces those arrays, including connector edge
arrays, with empty arrays. The writer persists only profile headers and access
feasibility. The persisted audit explicitly rejects rows in the eight primitive
tables (`lib/data/audit/sqlite-pack-audit.ts:470`).

Some chain work feeds surviving connector hashes; the report objects built
around it do not. Exact old hash preservation requires that chain work. Allowing
new, versioned identities removes that obligation because runtime uses the
identities only diagnostically. Physical cycle detection and directed minimum
stems still earn their code; plain SCC membership alone is not sufficient.

### Three independently explored interfaces

The initial three parallel designs below explored exact old-value compatibility.
Their interface tradeoffs remain useful with the broader behavioral allowance.

**A. A slim returned domain value.** `compileFeasibility` accepts graph and
versions and returns compact facts; `encodeSchema6Feasibility` exposes concrete
storage encoding. Callers no longer
see arrays for decision graphs that can never be present. Schema-6 zero counts
and empty hash fields are encoded inside the implementation/storage conversion.
This has the clearest output interface. Its cost is teaching compiler summaries,
the writer, and fixture callers the new shape; moving format knowledge into
several serializers would cancel the improvement. Its designer estimated
220–310 fewer application lines and 30–90 added test lines, with lower confidence
than the conservative ledger because encoding/caller costs are not prototyped.

**B. Ordered record emission.** A compiler emits identity records and known/
inclusive feasibility records to a consumer. SQLite and a collecting test
consumer are possible adapters. This can avoid a large accumulated result and
support alternative consumers, but callers must understand ordering, failures
after partial output, and transaction ownership. Core graph analysis still needs
global data. For today's callers, that additional protocol does not remove the
discarded work more effectively than a returned result. Do not introduce it now.
Its estimated protocol/integration overhead is 35–75 application lines; its own
net estimate was 115–225 fewer application lines plus additional tests. These
alternative estimates overlap the same deletions and must not be added together.

**C. Keep the current call; construct compact records directly.** The public
`buildClosedRouteTopology` call and schema stay unchanged. Its private profile
calculation returns `{ persisted, chainCount }`. Only `chainCount` offsets the
next profile; the persisted decision count stays zero. One exact edge-to-chain
map replaces rich decision records, and the compact profile is hashed once.
This concentrates the change and keeps publication and fixture callers simple.
Its remaining weakness is the obsolete rich TypeScript result types.

**Conservative fallback: C, with A's narrow types.** Keep the existing entry point and
wire shape. Declare impossible primitive arrays as empty tuples and their counts
as zero; remove rich record declarations. Adjust the compiler's audit projection
to state its guaranteed zero cycle-block count instead of filtering an array
that is always empty. Do not add a new public wrapper, a generic pipeline, or
another graph representation. This gains locality while keeping the useful
existing interface. The writer and independent reader keep their current jobs.

Current and proposed production caller (intentionally the same):

```ts
const closedRouteTopology = buildClosedRouteTopology(
  graph.nodes, graph.edges, graph.accessPoints, versions,
);
writePackDatabase(databasePath, { ...contents, closedRouteTopology });
```

The conservative implementation changes materially:

```ts
// Current: compute reports and a hash that will immediately be discarded.
const known = buildProfile("known", /* inputs */, 0);
const inclusive = buildProfile("inclusive", /* inputs */, known.decisionEdgeCount);
const profiles = [compactFallbackProfile(known), compactFallbackProfile(inclusive)];

// Proposed private interface: return only persisted data plus the needed offset.
type ProfileWork = { persisted: TopologyProfileBuild; chainCount: number };
const known = buildProfile("known", /* inputs */, 0);
const inclusive = buildProfile("inclusive", /* inputs */, known.chainCount);
const profiles = [known.persisted, inclusive.persisted];
```

Illustrative snippets abbreviate arguments; they are design examples, not a
patch. In this fallback, preserve candidate ordering and mapping coverage checks
before producing the same connector hashes. Never use the persisted zero count
as the offset. The stronger recommendation below deletes that dependency.

### Recommended behavior improvement: original-graph cycle approaches

A reproduced counterexample justifies changing the calculation. Let `s` be the
start, `s ↔ t` a 100 m stem, and `t ↔ u ↔ v ↔ t` a real physical triangle.
Every physical edge is 100 m. The current compiler returns a 100 m minimum stem.
Add one-way edges `s → x`, `x → y`, and `s → y`, with no return from x/y.
The usable loop still begins at t, but the current compiler now returns zero:

| Existing production compiler input | Known minimum stem | Inclusive minimum stem |
| --- | ---: | ---: |
| Stem plus bidirectional loop | 100 m | 100 m |
| Same graph plus one-way dead-end triangle | **0 m** | **0 m** |

Both report `canReachCycle: true`, correctly. This experiment called the existing
`buildClosedRouteTopology` directly using six normalized fixture nodes, public
access, paired reversed geometries, and assigned 100 m edge lengths; no packs
were written. The proposed compiler has not been implemented or benchmarked.

Cause: the current implementation finds undirected cycle blocks globally, then
accepts their nodes as portals if their directed strongly connected component
(SCC: a set of nodes that can all reach one another) contains any physical cycle.
The one-way triangle and the usable cycle are different cycles. Start s is
incorrectly treated as already on the usable one. This weakens early pruning;
it does not demonstrate invalid generated routes passing the final validator.

Keep one computational entry point, with no new public staging protocol:

```ts
// Compiler caller retains the same operation and compact storage interface.
const topology = buildClosedRouteTopology(nodes, edges, starts, versions);

// Proposed private implementation, independently for known and inclusive:
const legal = legalTrailDirections(graph, profile);
const scc = directedComponents(legal);
const cycleNodes = physicalCycleNodesWithinComponents(legal, scc);
const approaches = shortestDirectedApproaches(legal, scc, cycleNodes);
return compactProfile(approaches, originalGraphIdentities, versions);
```

These names illustrate private responsibilities, not mandatory additional
helpers. The implementation should:

1. Use only legal trail directions for each access profile. Inside each SCC,
   form the physical undirected multigraph; exclude edges crossing SCCs.
2. Find physical bridges with an iterative traversal. A node on a nonbridge
   physical edge is cycle-bearing. Preserve parallel physical edges and
   self-loops; two directions of one physical edge remain just one edge.
   Leaf stripping is insufficient: it retains the bridge between two loops.
3. Run reverse shortest paths from cycle-bearing nodes, restricted to the same
   SCC. Return directed minimum stem and explicit unreachable nulls.
4. Use actual graph node keys for attachments/portals, the smallest node key
   for a stable SCC/network label, and a versioned hash of ordered original
   directed stable-edge IDs for the connector. Remove decision-node retention,
   compressed-chain orientation/sorting/mapping, and the known/inclusive offset.
5. Return only compact profiles and existing physical identities. Keep the
   historical SQL columns/empty primitive tables; do not recreate rich reports.

This combines A's truthful result types with C's simple caller, while changing
the computation where there is a demonstrated reason. Deleting the module would
put physical identity, legality, cycle-approach and encoding knowledge back into
compiler/fixture callers. Deleting its obsolete chain machinery would make that
machinery disappear entirely. The stream interface still adds little value.

Expected intentional changes: new attachment/network/portal identities and
connector/profile hashes, possible diagnostic group counts, and corrected
minimum stems. Changed pruning can change attempted starts and routes found
within finite budgets. An identity-only control must keep route results equal;
the corrected-pruning variant must show sound exclusion and acceptable route
quality. Faster builds and better budget use are hypotheses, not measured wins.

The additional deletion includes approximately 75 lines of retention/chain
construction (`topology-compiler.ts:266–340`), 21 of weak-component numbering
(`:28–48`), and related metadata/mapping/offset work, offset by SCC cycle-node
extraction, canonical identities, and compatibility/version handling. Allow
**280–380 total application lines fewer**, including compact-type savings once.
Allow **70–140 net test/helper lines added** for a small independent graph oracle,
this regression, identity controls, and version/reader checks. These are
provisional; the versioning and oracle implementation can change the net size.

### Compatibility and rollout for changed behavior

Keep SQLite schema 6 and all installed data unchanged. For new profiles, use an
explicit new topology format/algorithm identity; extend the reader's currently
format-1-only check (`sqlite-closed-route-feasibility-repository.ts:323`) to
support both named encodings and retain independent validation. A new profile
format number documents that legacy `*DecisionNodeId` columns now encode actual
source-node keys. This is a profile-format revision, not a SQL schema migration.
Do not weaken unknown-format rejection or require old artifacts to be rewritten.

**A manifest algorithm string alone will not invalidate the build cache.**
`regionalDataVersion` hashes compiler/adapter/metric versions at
`lib/data/regional-builder.ts:97–111`; the topology algorithm string is assigned
separately at `:149`. Include the new shared topology identity in the existing
hashed version inputs and seed, or bump every affected regional compiler version.
Use one explicit choice and test all five definitions. Existing build reuse
happens before computation (`compiler.ts:315`, `:407`); different semantics must
never reuse an old dataVersion. This is a focused version-input change to the
completed builder, not a redesign of its preparation/publication flow.

Old saved geometry remains readable. Unfinished jobs also need their pinned old
artifact files, not merely reader compatibility. Publication currently prunes
old pack directories (`compiler.ts:352`), so a future activation must retain
versions referenced by unfinished jobs or wait for those jobs to finish before
activating/pruning. Prototype into scratch output; no installed-pack rebuild or
activation is part of this assessment. Any required retention work has separate
scope and is not included in the compiler reduction estimate.

### Conservative deletion ledger, dependencies, and checks

| Existing scope | Physical lines reworked/removed | Necessary replacement |
| --- | ---: | --- |
| Extrema helper and two-edge report traversal (`:11–20`, `:153–169`) | 27 | Keep bridge/articulation/block discovery |
| Rich hash projection and compact-after-full conversion (`:189–219`) | 27 in selected blocks | Direct compact hash input |
| Rich decision objects (`:341–375`) | 35 | Approximately 5–10 identity-map lines |
| Block/link reports (`:378–434`) | 57 | None |
| Node/network reports (`:512–553`) | 42 | None |
| Full profile finalization (`:554–559`) | 6 | Compact finalization plus private chain count |
| Rich declarations (`lib/data/types.ts:100–176`, selected blocks) | 67 | Empty-array types and compact records |

The selected blocks total 261 current lines, before collateral dead imports and
declarations. Subtract replacement types, compact hash construction and identity
mapping: approximately **205–255 net application lines**. Keeping all existing
types and callers literally unchanged instead yields approximately **160–190**.
The estimates are alternatives, not additive. No SQL table/schema deletion is
included. Frozen compatibility cases likely add **20–60 net test/helper lines**.

Graph computation, hashing, sorting and access rules are **in-process**: no
adapter is needed. SQLite and files are **local-substitutable**, already tested
using production SQLite in disposable directories. Their seam stays internal to
storage/publication. Source downloads are **true external** and elevation/file
sampling is local, but both stay upstream behind their existing production and
fixture adapters. This computation has no **remote but owned** dependency.

Deletion test: removing the retained module would put key assignment, physical
validation, feasibility and hashing back into compiler and fixture callers.
Removing the discarded reports makes their complexity disappear everywhere.
This is a real deletion, not a large-file split.

Keep the topology interface tests for parallel edges, shared articulations,
directed-illegal cycles, exact stems, known/inclusive differences, permutation
invariance, and the 4,000-node bridge forest. Remove the five-line extrema test
only when all extrema work disappears; cover a large cyclic graph through the
retained interface instead. Freeze complete old compact results, including keys
and hashes, for self-loops, equal-distance portals, multiple shared/distinct
stems, metadata and direction transitions, disconnected nodes, and an inclusive
case with multiple known chains. Use the old commit as a temporary oracle;
do not retain a second compiler implementation as a permanent test helper.

Do not combine independent persisted checks into compiler validation. Intended
graph coverage rejection (`compiler.ts:115`) and reopened SQLite geometry
coverage checks (`sqlite-pack-audit.ts:510`) detect different failures. Keep
source/manifest equality, elevation spacing, foreign keys, spatial rows, empty
primitive tables, and runtime hash reconstruction from actual access rows
(`sqlite-closed-route-feasibility-repository.ts:268`). The standalone audit's
stored-hash/count checks are not equivalent to runtime row-content rehashing.
Sharing a future canonical format serializer is separate from trusting compiler
objects in an artifact audit; do not broaden this first change to audit cleanup.

Performance opportunity: fewer discarded objects, array copies, JSON summaries,
block-link combinations, and hashes. SCC, chain assignment, and Dijkstra remain.
No speedup number is established. Measure stage time and peak RSS in separate
processes on identical bridge forests, large cycles, articulation-linked cycles,
parallel edges, and many starts. Require complete output/hash equality; then
measure full fixture publication separately, since other build stages may
dominate. Existing installed packs need no mutation or schema migration.

## 2. Give route display one owner inside the map

The current `HikeMap` has 1,368 lines. Its only production caller is
`components/builder/HikeBuilder.tsx:397`; the public props at
`components/map/HikeMap.tsx:12` pass coverage/display, area geometries, routes,
route/segment focus, unknown-access preference, and callbacks. The builder
chooses draft versus saved-result snapshots; keep that ownership there.

The internal interface is more expensive: initial load creates sources/layers
from refs, separate React effects update those same sources, event handlers read
callback refs, marker code owns DOM lifetime, and camera framing follows its own
effect. Initial route construction at `:729–759` calls route partitioning three
times; later updates at `:1043–1059` rebuild all six route-related sources when
any route or segment hover/selection changes. `routeFeaturePartitions` at `:302`
copies the same geometries into all/alternate/selected/hover collections.

The recommended module is a **route overlay**, not a general map framework.
Its interface can be `attachRouteOverlay(map, events)`, `update(routes, focus)`,
and `dispose()`. It owns route/segment source definitions and update decisions,
hit priority, numbered pins, and route framing. Map construction, viewport
queries, drawing, and copy menus remain in the existing map owner initially.
Keep the external HikeMap props unchanged; do not move map-specific concepts
into HikeBuilder just to shorten HikeMap.

Current internal callers (both load and update know the rendering structure):

```ts
const partitions = routeFeaturePartitions(routes, selectedId, hoveredId);
map.getSource("generated-routes-hit").setData(partitions.all);
map.getSource("generated-route-alternates").setData(partitions.alternates);
// Four more route/segment source updates, plus separate marker/framing effects.
```

Proposed internal caller:

```ts
overlay.update(routes, {
  selectedRouteId, hoveredRouteId, selectedSegmentId, hoveredSegmentId,
});
// The same update path receives latest committed props after map load.
```

Use one route source for hit/alternate/selected/hover layers and one selected
route's segment source for hit/focus layers. Preserve layer stacking and hit
widths; update filters for focus. Upload routes when the route collection
changes and segments when the selected route or its geometry changes. A hover
transition should perform **zero route geometry setData calls**. A module that
simply moves the six current setData calls behind `update` fails this proposal.

Current repeated payload construction was reproduced using exported production
helpers with 20 synthetic routes, 2,000 coordinates each, and 10 selected-route
segments of 200 coordinates each:

| Change | Source payloads | Coordinate occurrences | Serialized JSON bytes |
| --- | ---: | ---: | ---: |
| Hover an alternate route | 6 | 84,000 | 2,017,105 |
| Hover one selected-route segment | 6 | 82,200 | 1,971,432 |

These were minimal helper inputs for payload measurement, not contract-validated
solver results. This counts prepared payloads and sums `JSON.stringify` byte lengths. It is not
a browser benchmark, network traffic, or a measured speedup. The installed
MapLibre source confirms setData schedules a worker update. Filter updates
still cost rendering work; measure actual worker updates, allocations and frame
latency with an offline browser hover trace before claiming responsiveness gains.

The estimate is deliberately smaller than the file: reworking the 101 lines of
route feature construction/source setup/update into approximately 55–75 lines
saves about 26–46; consolidating duplicated ref/update/marker setup offers
roughly another 30–90, offset by approximately 15–30 lines of lifecycle glue.
Allow **40–120 application lines net**, excluding clipboard work. A whole-map
controller rewrite has no demonstrated larger deletion and could add code.
Expect **40–100 additional test lines** to replace narrow expression assertions
and cover previously untested update/lifecycle behavior. A prototype may show
no combined line reduction; accept it only for measured performance and reduced
coordination, not for moving code into another file.

Preserved interface obligations and risks:

- Sources/layers exist before updates or event queries; latest committed props
  survive asynchronous load; callbacks and form edits never reconstruct the map.
  Disposal removes listeners/markers, including React Strict Mode replay.
- Selection is orange, alternates green; hover changes weight, not selected
  color. Segment hit targets take priority over route hits; underlying trail
  copy checks route/segment/access-point hits before acting (`:802–965`).
- Pins suppress duplicate generic access dots, use the first route coordinate,
  and anchor clusters to a real member. Zoom 11 reveals numbering; nearby
  overview grouping uses the existing 22 px radius. Preserve accessible DOM
  pins because no glyph endpoint is configured (`:1061–1147`).
- New result sets frame all routes; selecting an already-visible route does not
  move the camera (`:1149`). Correct its abbreviated identity: `[A,B,C]` and
  `[A,D,C]` collide under length/first/last (`:1154`). An ordered full-ID signature
  fixes that collision at roughly neutral application size, with 10–25 test
  lines for camera outcomes. This is a source-proven collision, not a reproduced
  saved-page incident. If equal IDs can carry changed geometry, use the viewed
  result's revision; do not hash entire geometry on every hover.
- Viewport requests abort stale work, validate payloads and display failures;
  unknown access is included by default. Drawing is only an access-point
  filter, supports release outside the map and Escape, and never clips routes.
  These behaviors stay with their current owner (`:990–1022`, `:1179–1241`).

Projection, grouping and focus decisions are **in-process**. MapLibre/DOM are
**local-substitutable** with real offline browser tests; use narrowly recorded
MapLibre operations for update-count/lifetime checks without implementing a fake
rendering engine. Any small native-map adapter is internal, justified only by
the real map and recording test implementation. `/api/map` is **remote but
owned**: retain the HTTP path and existing offline fixture substitution at that
seam. USGS tiles are **true external**, replaced by committed/in-memory tile
fixtures in browser tests. Do not create a new public adapter for each layer.

Replace tests tied solely to four partition objects or exact filter expression
arrays after equivalent overlay-interface assertions exist. Retain geometry,
pin grouping/anchoring, shared-start numbering, unknown filtering, keyboard and
copy tests; do not delete distinct pure geometry and browser layout coverage.
Add a late-load/update/dispose sequence and check geometry upload counts through
the overlay interface. Deletion test: removing the overlay would spread
source/filter identity, marker and focus coordination back across load/update/
event paths. Splitting style declarations alone does not earn this result.

A further justified behavior improvement is exclusive pointer ownership while
drawing. Existing route/trail/access handlers remain active while drawing adds
its handlers, and cursor synchronization can override the crosshair. Source
shows competing ownership; selection/copy side effects during a completed drag
still need an offline browser reproduction. If confirmed, let drawing suppress
ordinary feature and DOM-marker gestures through one interaction mode. Do not
add scattered guards or count this separately from the map estimate.

## 3. Simplify presentation without unpicking workspace state

ResultsPanel is 582 lines; HikeBuilder is 409; global CSS is 832.
ResultsPanel's current interface has 17 props (`ResultsPanel.tsx:13–30`), and its
private RouteCard has 14. The same card wiring is written twice at `:500–552`;
only exact versus close input and global index offset differ.

Keep the existing ResultsPanel module and use one private card renderer:

```tsx
// Current: both maps repeat all props, card refs, segment refs and callbacks.
results.exact.map((route, index) => <RouteCard /* repeated wiring */ />);
results.nearMisses.map((route, index) => <RouteCard /* repeated wiring */ />);

// Proposed: retain the separate exact section and close-match disclosure.
results.exact.map(renderCard);
results.nearMisses.map((route, index) => renderCard(route, results.exact.length + index));
```

The external interface stays unchanged. The implementation absorbs global
numbering, ref registration and focus wiring once. Removing that shared private
implementation would put those rules back into two callers: it passes the
deletion test without requiring a new exported presentation abstraction.
Expected saving: **18–25 application lines**. Keep all 13 existing result-panel
tests; they protect distinct behaviors rather than private renderer mechanics.

Repository searches found no active non-CSS references to segmented controls
(`globals.css:159–173`, `:794`), boundary-editor/coordinate-grid (`:300–305`),
slider-field (`:381–385`, plus one compound selector), access-point-setting-grid
(`:428–446`, `:823`), or note-info/note-warn (`:120–121`). Remove those obsolete
styles only after checking computed classes; preserve MapLibre's DOM-created
pin classes. Estimate **45–55 lines**, giving **65–85** with card wiring.
CSS deletion is ordinary cleanup, not proof of a deep module.

Clipboard feedback repeats status, timers and completion handling in result
coordinates (`ResultsPanel.tsx:179–212`), map trail/access names
(`HikeMap.tsx:895–907`, `:941–953`), and map coordinates (`:1260–1274`). The
existing `components/clipboard.ts` already owns browser copy ordering; preserve
it. A small `useCopyFeedback` module can own attempt identity, expiration, reset
and unmount behavior:

```tsx
const copy = useCopyFeedback();
// Invoke synchronously on the click stack to preserve browser activation.
copy.copy({ key: route.id, text: coordinates });
// Consumer renders copy.feedback and can call copy.reset().
```

Each consumer keeps its own feedback scope. Context-menu closing stays an
explicit map concern. A reset must invalidate pending completion. Map and result
code currently have different race guards. Map coordinate-copy completion lacks
an attempt/menu guard, and opening a new menu does not clear the old expiration
timer: old work can change or close a newer menu. The proposed latest-attempt
rule intentionally fixes that source-confirmed race; reproduce it with deferred
promises/fake timers. If extra expiration callbacks erase the savings, share just the
two map-name copies. Approximately 65–80 replaced caller lines minus 35–50
implementation/integration lines supports **20–45 further application lines**;
race/failure/expiration tests likely add **20–50**. Count this only once.

State and formatting are **in-process**; DOM focus/layout is
**local-substitutable** with jsdom plus real browser checks. Clipboard permission
behavior is **true external**, using the existing copy adapter and mocks;
timers can use the test runner's fake timers without a public clock interface.
The workspace's catalog/search/jobs/settings endpoints are **remote but owned**,
but no new transport seam is justified for this small presentation change.

Preserve exact-first numbering and keyboard wrap/Home/End, close-match
disclosure, segment hover/selection scroll behavior, named/unnamed search links,
coordinate feedback and grade rounding (`ResultsPanel.test.tsx`). Saved work
must retain its actual job/request/progress; Quick keeps its own diagnostics.
Loading/error with previous results retains that page. Map routes, card
selection, and closed close-match sections remain synchronized.

Do not extract HikeBuilder into several hooks merely for file size. `runView`
(`HikeBuilder.tsx:125–145`) already owns Quick/open/paging cancellation and rejects
stale completions. Draft form values and viewed area/criteria snapshots differ
intentionally. Full job creation has its own lifetime. Incomplete numeric text
stays local, and `usePreferences` serializes validated writes. The existing tests
protect Strict Mode, failures, cancellation, geolocation and persistence; no
substantial test deletion is established. Shared test fixtures offer at most
unproven small savings and risk coupling distinct scenarios.

Performance hypothesis: `routeHeading` (`ResultsPanel.tsx:69`) sorts all named
segments to select one longest segment. A one-pass maximum can preserve the
distance/name tie rule; profile 50 saved routes under hover before adding caches.
CSS removal and copy consolidation have no measured latency benefit.

## 4. Keep the route algorithms; investigate small duplicated mechanics

The 975-line penalized search and 611-line coordinator already present useful
interfaces. `ReachableGraphClosedRouteSolver.prepare` accepts criteria/context
and returns eligible starts plus a generate operation; the production child
prepares once (`lib/server/route-solver-child.ts:71`). Prepared criteria are
snapshotted; graph/topology readers must share pack/version and their lifetime
belongs to the child. Errors distinguish missing/outside/ineligible starts;
reader failures propagate, cancellation throws, and timeouts produce explicit
computation limits. Preparation time counts in ordinary generation while each
prepared generation gets its own timing window.

The low-level `searchPenalizedClosedRoutes(graph, start, request, options)` sorts
input deterministically and returns candidates plus limits, not authoritative
user routes. Missing starts return empty candidates. Effective budgets are the
minimum of supplied and effort caps (`lib/solver/budget.ts`); the coordinator
shares them across starts and loads coverage-constrained graphs before candidate
generation. Validation reconstructs directed geometry and applies full metrics.
Exact and close ranking remain separate. Full preserves the union of Quick
then Thorough, because higher effort is not monotonic in route quality.

Most apparent duplicate work has different meaning:

- Search's approximate metrics keep candidate exploration affordable; validation
  uses full elevation profiles and authoritative coverage/access/topology.
- Search decomposes the reachable graph; validation decomposes the chosen walk.
  Their bridges and shared stems need not match.
- The two overlap functions have different denominators: search uses the smaller
  physical distance; final selection uses candidate-relative distance. Merging
  them changes which routes survive (`penalized-closed-route-search.ts:249`,
  `reachable-graph-closed-route-solver.ts:241`).
- Lollipop construction, alternative returns, compound-loop assembly and repairs
  contribute different walks. Existing tests prove bridge-stem loops and joining
  two individually too-short cycles. Remove a phase only after measuring what
  valid routes it uniquely contributes across representative graphs/packs.

One direct deletion is established: the coordinator appends the chosen access
point into `graph.accessPoints` at `:487–489`, but penalized graph construction
uses only nodes/edges and receives the start separately. Pass `reachable.graph`
directly instead: **three application lines**, no test deletion or new module.

Two heaps duplicate push/pop mechanics (`penalized-closed-route-search.ts:118`,
`lib/graph/sqlite-repository.ts:163`). A small `PriorityQueue<T>` with push/pop/
size and a comparator could save **35–55 application lines**. It passes the
deletion test across two callers, but one current heap uses parallel numeric
arrays while the other uses string-keyed objects. Allocation and comparator
overhead may make sharing worse. Preserve numeric versus locale string tie
ordering; benchmark before accepting. No standalone redundant heap tests exist;
expect no test reduction and perhaps 15–30 additional test lines.

`getReachableGraph` also reads/parses access points (`sqlite-repository.ts:361`)
after starts are already prepared. Narrowing that internal return could avoid
work but needs a deliberate repository contract/test change. Credit only
0–10 potential additional application lines. Graph caching between rounds may
improve time but adds invalidation/memory code; it is not a reduction claim.

Algorithms and queues are **in-process**, needing no adapters. Graph/feasibility
readers are **local-substitutable**, exercised with real temporary SQLite packs.
The child process remains a local execution/lifetime seam. No new remote-owned
or true-external dependency is needed. A solver wrapper would merely move its
existing small caller protocol and fails the deletion test.

Keep low-level search tests for loops/assembly/close matches/budgets, independent
malformed-route validation tests, prepared-versus-ordinary equivalence, fair
start probing, direction, coverage holes, grades and Full's Quick baseline.
The test titled cancellation before/during graph work currently aborts before
entry; add an actual mid-search abort case before changing cancellation checks.
Fixture runner duration is not route-performance evidence. Queue or algorithm
work needs alternating old/new timings, allocations/RSS, expanded states,
time-to-first-exact, route identities/diversity and visible truncation at the
same budgets, including equal-cost and repeated-relaxation graphs.

## Verification and execution recommendation

Fresh, offline baseline checks during this assessment:

| Command | Result |
| --- | --- |
| `npm test -- components/map` | 25 tests, 3 files passed |
| `npm test -- lib/data/topology-compiler.test.ts lib/data/compiler.test.ts lib/data/audit lib/graph/sqlite-closed-route-feasibility-repository.test.ts` | 36 tests, 5 files passed |
| `npm test -- lib/solver lib/server/route-solver-process.test.ts` | 35 tests, 6 files passed |
| `npm test -- components/results components/builder` | 52 tests, 5 files passed |

Total: **148 tests across 19 files**. The separate synthetic stem experiment
above reproduced the defect using existing production code. This verifies the inspected baseline; it
does not validate proposed implementations. No full verify, browser run,
installed-pack audit, or rebuild was repeated for this documentation-only
assessment. The previous two full verification runs and five pack audits are
recorded in `regional-pack-consolidation.md` and are not claimed as fresh work.

If implementation follows, use this concrete sequence:

1. Freeze compact outputs and graph-validation behavior from `f361643`, including
   offsets/hashes for the exact-compatibility control. Capture fixture rows and
   deterministic solver responses. Compare current code, direct compact output
   with old semantics, original-path identities with unchanged physical facts,
   and SCC-local cycle approaches. These are temporary comparison variants, not
   four permanent production implementations. Keep inputs committed/offline.
2. Keep shared contracts/root configuration/lockfile with the integrator. Give
   one isolated implementer exclusive ownership of topology compiler/types and
   focused tests; the integrator owns compatibility types, dual-format reader,
   compiler summaries and version/fingerprint changes. This
   change is tightly coupled, so do not invent three parallel implementation
   tasks. Integrate one focused commit at a time on the existing integration
   branch. Other candidate implementations are separate waves.
3. The compact-only control must match old outputs exactly. The identity-only
   control must preserve deterministic route results, attempted starts and
   budgets, allowing changed identities/group diagnostics. For the corrected
   cycle calculation, classify each changed eligibility/stem fact, including
   the reproduced 100 m case. Test bidirectional trees, real one-way cycles,
   one-way tails, parallel edges, self-loops, two loops joined by a bridge,
   unknown-access differences and ties. Use an independent bounded closed-walk
   oracle on tiny graphs with an explicit finite bound; do not claim this proves
   all possible walks. Reject any pruning that removes a feasible valid route.
   Preserve independently corrupted-artifact tests. Compare fixed-budget and
   real-time Quick/Thorough/Full quality, unique routes, time-to-first-exact,
   attempts and truncation; do not interpret new group counts as better quality.
   Run focused compiler/audit/reader/solver suites and time/RSS measurements.
4. Run `npm run verify` twice and `npm run test:browser` twice, as required by
   the runbook. Live localhost checks include saved results, map zoom/pan
   anchoring, keyboard interaction, and mobile internal-panel scrolling.
5. SQL schema 6 stays; the recommended new profile encoding is explicitly
   versioned. Audit old installed packs read-only and new scratch artifacts with
   the dual-format reader; never rewrite old hashes or artifacts. Verify every
   regional fingerprint changes when only the new compiler algorithm changes,
   while normalized regional preparation remains unchanged. Do not rebuild or
   activate installed packs merely to measure the compiler. A later activation
   must retain artifacts pinned by unfinished jobs or defer until they finish;
   validate saved-geometry reads and pinned-job resume with both formats present.
6. Record actual application/test deltas and separate fixture data growth,
   timings and compatibility limits in status. Remove completed task worktrees
   and branches; audit generated files/secrets before committing.

All three temporary assessment worktrees and their branches were removed.
Unrelated user changes preserved: deleted `legacy/isochrones/README.md`,
untracked `.agents/`, and untracked `skills-lock.json`. No historical rebuild
gate was reopened, and no implementation gate was completed by this assessment.
