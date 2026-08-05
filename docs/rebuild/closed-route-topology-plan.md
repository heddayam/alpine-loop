# Closed-route topology redesign: implementation and execution plan

## 0. Fresh-session entry point

This document is the authoritative plan for Gate 5. It supersedes the route-shape
and solver-design portions of `implementation-plan.md` for this gate only. Gate
4 remains the releasable baseline until the coordinated Gate 5 cutover is
complete.

A fresh primary agent must:

1. Read `AGENTS.md`, `docs/rebuild/implementation-plan.md`,
   `docs/rebuild/agent-runbook.md`, `docs/rebuild/data-sources.md`,
   `docs/rebuild/status.md`, and this document completely.
2. Start at the unchecked Gate 5 entry in `docs/rebuild/status.md`.
3. Run `git status --short --branch`, `npm ci`, `npm run verify`, and
   `npm run test:browser` before changing production code.
4. Preserve the completed Gate 4 behavior until the V3 API, schema-3 fixture
   pack, solver, and UI are ready for one coordinated cutover.
5. Treat `scripts/research/closed-route-topology-poc.ts` as evidence and a
   benchmark harness, not as production architecture.

The primary agent is the integrator. It owns shared contracts, root
configuration, the lockfile, migration sequencing, real-pack rebuild, final
benchmarks, documentation, and branch/worktree cleanup.

## 1. Decision and product outcome

The active route product becomes a generator of **trailhead-rooted closed hiking
routes**. Loop and lollipop remain useful descriptions of results, but they are
not separate search lanes.

The fundamental route object is a legal directed closed walk whose physical
trail multigraph contains at least one cycle:

- cycle-bearing edges provide non-repeated route sections;
- bridges and unavoidable connectors may be traversed outward and back;
- a simple loop has no repeated physical trail;
- a lollipop has a repeated stem leading to a cycle;
- a figure-eight contains multiple cycles sharing an articulation;
- chained loops contain multiple cycle blocks joined by connectors;
- a closed walk with no cycle is a pure out-and-back and is not returned.

The user controls acceptable repetition rather than choosing a separate loop or
lollipop algorithm. The solver generates closed candidates once, validates them
against legal directed pack edges, and classifies topology afterward.

Out-and-back and point-to-point routes are removed from the active V3 product.
Point-to-point shortest paths remain internal primitives for stems, alternative
returns, disjoint paths, and local repair. Gate 4 remains available through Git
history; do not retain dormant user-facing V2 branches in the final active UI.

## 2. Proof-of-concept evidence and limits

The read-only POC ran against schema-2 pack
`scm-a339bce45af76f29` using the 6–10 mile / 1,500–2,500 foot request.

### Full-pack topology result

| Measurement | Result |
| --- | ---: |
| Eligible public/unknown access points | 2,293 |
| Access points able to reach a cycle | 1,875 |
| Access points unable to reach any cycle | 418 |
| Distinct nearest cycle-network portals | 353 |
| Traversable physical edges | 369,830 |
| Bridges | 133,669 (36.1%) |
| Cycle-bearing 2-edge components | 1,295 |
| Traversable nodes with degree other than two | 41,791 |

The graph computation took about 70 ms after extraction. Cold SQLite/text-ID
loading took roughly 2.4 seconds and dominated the experiment. Therefore the
topology index and compressed decision graph belong in the pack compiler, not
in the request path.

The 1,875 viable access points mapping to 353 cycle-network owners is a 5.3x
reduction among viable starts and a 6.5x reduction relative to all eligible
starts. This supports shared network work, but does not authorize deleting
individual trailheads: every access point must still be evaluated with its
exact connector and access metadata.

### Unified closed-lane result

Five explicit mountain starts were tested under the same 10,000-edge,
100,000-state, 2,000-candidate, three-second global budget.

| Measurement | Separate loop/lollipop lanes | Unified closed lane |
| --- | ---: | ---: |
| Combined wall time | 7.92 s | 5.93 s |
| 80%-overlap-diverse exact routes | 6 | 6 |
| Wall-time change | — | 25.1% lower |

The unified lane preserved exact-route yield and avoided internal generation
truncation in those runs. All reachable graphs still hit the 10,000-edge cap,
so the POC validates unification and topology preprocessing, not the final
candidate-generation architecture.

A final confirmation run produced 8.16 seconds versus 6.13 seconds (24.9%
lower) and the same six diverse exact routes. Treat wall time as a measured
range, not a deterministic assertion; the topology counts and result yield are
the stable checks.

Reproduce the retained experiment against the installed Gate 4 pack with:

```sh
node --import tsx scripts/research/closed-route-topology-poc.ts \
  --database=.local-data/packs/santa-cruz-mountains/scm-a339bce45af76f29/pack.sqlite \
  --manifest=.local-data/packs/santa-cruz-mountains/scm-a339bce45af76f29/manifest.json
```

The harness prints one JSON document. Save that output outside Git with the
Gate 5 benchmark evidence; timing varies by machine, but topology counts and
the six exact-route baseline must remain stable.

### What remains unproven

- The POC did not yet implement persisted vertex-biconnected blocks.
- It did not generate and reuse cycle primitives across a full network cohort.
- It did not prove higher recall than a long-running oracle.
- Its undirected topology is a candidate superset; final traversal must remain
  direction-aware.
- Its in-memory text maps are intentionally unoptimized and are not an
  acceptable production runtime representation.

Gate 5 must retain explicit falsification checkpoints. Do not complete a full
rewrite merely because preprocessing statistics look promising.

## 3. Active V3 contract

Perform a coordinated local cutover. After the UI, API, fixture packs, and
scenario suites use V3, reject V2 at the route-generation endpoint. There is no
external compatibility requirement for this local reboot.

```ts
type ClosedRouteTopologyPreferenceV3 = {
  // Percentage of total route distance traversed beyond the first use of each
  // undirected physical edge. Integer 0..100; default 35.
  maximumRepeatedTrailPct: number;

  // Optional additional cap on the one-way length of a shared access stem.
  // Omitted means repetition percentage alone controls the stem.
  maximumSharedStemMiles?: number;

  // When false, accept only one-cycle routes. When true, figure-eights,
  // chained loops, and other valid multi-cycle closed routes are allowed.
  allowMultiCycle: boolean;
};

type GenerateClosedRoutesRequestV3 = {
  version: 3;
  packId: string;
  accessFilter:
    | { mode: "drawn-area"; bbox: [number, number, number, number] }
    | { mode: "named-region"; regionId: string }
    | { mode: "drive-time"; reachabilityId: string; regionId?: string };
  startAccessPointId?: string;
  routeFamily: "closed";
  closedRoute: ClosedRouteTopologyPreferenceV3;
  distanceMiles: { min: number; max: number }; // max <= 30
  elevationGainFeet?: Range;
  maximumElevationFeet?: Range;
  steepestSustainedGradePct?: Range;
  includeUncertainAccess: boolean;
  searchEffort: "quick" | "thorough";
  limit: number; // 1..20, client default 10
};
```

Defaults:

- `routeFamily: "closed"`;
- `maximumRepeatedTrailPct: 35`;
- `maximumSharedStemMiles` omitted;
- `allowMultiCycle: true`;
- `searchEffort: "thorough"`;
- route count 10;
- unknown access included.

Effort budgets live in one server-side table, not in client-supplied raw
numbers:

| Effort | Deadline | Purpose |
| --- | ---: | --- |
| Quick | 3 seconds | Fast first exact/diverse results with heuristic caps |
| Thorough | 15 seconds | Probe every feasible attachment group, widen labels and repairs |

Both efforts are deterministic for the same pack, request, and budget. A future
asynchronous exhaustive mode is deferred until the topology-first engine has a
measured recall oracle. Do not label either synchronous mode exhaustive.

### Response topology

Every route contains:

```ts
type ClosedRouteTopologyV3 = {
  kind:
    | "simple-loop"
    | "lollipop"
    | "figure-eight"
    | "chained-loops"
    | "complex-closed";
  cycleCount: number;
  cycleBlockCount: number;
  repeatedTrailDistanceMeters: number;
  repeatedTrailFraction: number;
  sharedStemDistanceMeters: number;
  connectorCount: number;
};
```

Repeated-trail distance is the sum, over each undirected physical edge, of
distance traversed after its first traversal. The fraction is that value divided
by total route distance. This is the exact value constrained by
`maximumRepeatedTrailPct`; it is not inferred from the result label.

Use one stable post-validation classification policy:

- `simple-loop`: exactly one cycle and zero repeated physical-trail distance;
- `lollipop`: exactly one cycle, positive repeated distance, and every repeated
  edge is part of the access connector/bridge chain to that cycle;
- `figure-eight`: multiple cycle-bearing blocks meet at articulation points
  without a positive-length connector between those blocks;
- `chained-loops`: multiple cycle-bearing blocks are joined by one or more
  positive-length connector paths;
- `complex-closed`: valid closed cyclic topology not covered above.

Classification is structural; it never changes when the user moves the
repetition control. A user's maximum repetition is an independent 0–100% hard
constraint. For example, 0% admits only routes with no repeated physical edge,
while a chained route that must retrace a connector is admitted only when that
connector fits under the selected percentage.

`kind` is derived from validated route geometry and physical-edge traversal. It
is not a generation promise. The response retains exact and labeled near-miss
sections. Pure out-and-backs and zero-cycle candidates are rejected, not shown
as near misses.

V3 has one start access point and no independent finish. Remove the V2 route
`shape`, end-access-point, point-to-point finish-filter, and `{start, end}`
filter-match fields from the active response. The returned start has already
passed the access filter, and reconstruction proves the route closes at that
same access point. Constraint violations add stable `repeated-trail` and
`shared-stem` codes so near misses can explain those failures without relabeling
the route topology.

Extend diagnostics with:

```ts
type ClosedRouteDiagnosticsV3 = {
  eligibleAccessPointCount: number;
  noCycleAccessPointCount: number;
  feasibleAccessPointCount: number;
  attachmentGroupCount: number;
  probedAttachmentGroupCount: number;
  deeplySearchedAttachmentGroupCount: number;
  loadedTopologyNetworkCount: number;
  cycleBlockCount: number;
  cyclePrimitiveCount: number;
  composedCandidateCount: number;
  repairedCandidateCount: number;
  directedValidationRejectionCount: number;
  expandedAssemblyStates: number;
  timeToFirstExactMs?: number;
  hardTruncationReasons: string[];
  nonBudgetShortfallReasons: string[];
};
```

Diagnostics must distinguish safe pruning from heuristic deferral. A quick
search that did not deeply search every feasible group must say so.

## 4. Pack schema 3 and compiler output

Advance the pack/database schema to version 3. Preserve all schema-2 named-area,
coverage, source, metric, and access behavior.

Manifest schema 3 adds `capabilities.closedRouteTopology: true`, the topology
algorithm/policy version, and the available `known` and `inclusive` profiles.
Introduce V3 contracts and schema-3 readers alongside the active V2/schema-2
path first. Do not move the installed pack's `current.json` pointer until the
schema-3 pack passes audit, deterministic replay, solver comparison, and API
scenarios. The coordinated UI/API cutover then activates V3 and rejects V2;
schema-2 readability may remain temporarily for benchmark rollback only.

Build two topology profiles:

- `known`: public legal edges only;
- `inclusive`: public plus unknown legal edges.

The profiles may share immutable source geometry, but component, bridge,
block, reachability, and portal assignments are profile-specific.

### Dense identifiers and compressed decision graph

Assign deterministic dense IDs from stable sorted source IDs. Never depend on
incidental insertion order. Schema 3 uses SQLite integer surrogate keys for
nodes, directed edges, physical edges, decision nodes, and decision edges while
retaining stable source IDs in unique indexed columns. The pack compiler owns
the directed-to-physical-edge mapping; runtime code must never infer physical
identity by trimming direction suffixes or comparing strings.

Persist a decision graph that contracts a degree-two node only when doing so
preserves directed legality and route metrics. Retain:

- access-point attachments;
- junctions and dead ends;
- access/name/surface/source discontinuities;
- articulation and bridge endpoints;
- block portals;
- at least one stable anchor in an otherwise pure degree-two cycle.

Every compressed directed edge stores the ordered original directed-edge IDs
needed for exact reconstruction plus aggregate distance, directional gain/loss,
maximum elevation, grade, access state, trail names, source IDs, and flags.

### Required topology tables

Exact names may be adjusted by the integrator before delegation, but the
following information and indexes are required:

```sql
physical_edges(
  physical_edge_key INTEGER PRIMARY KEY,
  stable_physical_id TEXT NOT NULL UNIQUE,
  from_node_key INTEGER NOT NULL,
  to_node_key INTEGER NOT NULL,
  geometry_hash TEXT NOT NULL
);

-- Schema-3 nodes and directed edges expose integer node_key/edge_key columns.
-- Every directed edge references its compiler-assigned physical_edge_key.

topology_profiles(
  profile TEXT PRIMARY KEY,             -- known | inclusive
  format_version INTEGER NOT NULL,
  node_count INTEGER NOT NULL,
  physical_edge_count INTEGER NOT NULL,
  decision_node_count INTEGER NOT NULL,
  decision_edge_count INTEGER NOT NULL,
  built_at TEXT NOT NULL,
  content_hash TEXT NOT NULL
);

topology_nodes(
  profile TEXT NOT NULL,
  dense_id INTEGER NOT NULL,
  source_node_id TEXT NOT NULL,
  decision_node_id INTEGER,
  connected_component_id INTEGER NOT NULL,
  two_edge_component_id INTEGER NOT NULL,
  is_articulation INTEGER NOT NULL,
  nearest_cycle_network_id INTEGER,
  cycle_portal_decision_node_id INTEGER,
  minimum_stem_distance_m REAL,
  PRIMARY KEY(profile, dense_id),
  UNIQUE(profile, source_node_id)
);

topology_decision_edges(
  profile TEXT NOT NULL,
  decision_edge_key INTEGER NOT NULL,
  from_decision_node_id INTEGER NOT NULL,
  to_decision_node_id INTEGER NOT NULL,
  length_m REAL NOT NULL,
  gain_m REAL NOT NULL,
  loss_m REAL NOT NULL,
  is_bridge INTEGER NOT NULL,
  two_edge_component_id INTEGER NOT NULL,
  vertex_block_id INTEGER,
  metrics_and_flags TEXT NOT NULL,
  PRIMARY KEY(profile, decision_edge_key)
);

topology_decision_edge_members(
  profile TEXT NOT NULL,
  decision_edge_key INTEGER NOT NULL,
  sequence_index INTEGER NOT NULL,
  edge_key INTEGER NOT NULL,
  physical_edge_key INTEGER NOT NULL,
  PRIMARY KEY(profile, decision_edge_key, sequence_index)
);

topology_blocks(
  profile TEXT NOT NULL,
  block_id INTEGER NOT NULL,
  block_kind TEXT NOT NULL,             -- vertex-cycle | bridge
  node_count INTEGER NOT NULL,
  edge_count INTEGER NOT NULL,
  cycle_rank INTEGER NOT NULL,
  total_physical_length_m REAL NOT NULL,
  minimum_cycle_length_m REAL,
  elevation_summary TEXT NOT NULL,
  trail_summary TEXT NOT NULL,
  PRIMARY KEY(profile, block_id)
);

topology_block_links(
  profile TEXT NOT NULL,
  from_block_id INTEGER NOT NULL,
  to_block_id INTEGER NOT NULL,
  articulation_decision_node_id INTEGER NOT NULL,
  connector_distance_m REAL NOT NULL,
  PRIMARY KEY(profile, from_block_id, to_block_id, articulation_decision_node_id)
);

access_topology(
  profile TEXT NOT NULL,
  access_point_id TEXT NOT NULL,
  attachment_decision_node_id INTEGER NOT NULL,
  cycle_network_id INTEGER,
  connector_key TEXT,
  portal_decision_node_id INTEGER,
  minimum_stem_distance_m REAL,
  can_reach_cycle INTEGER NOT NULL,
  PRIMARY KEY(profile, access_point_id)
);
```

The first implementation stores all topology records and fixed-width arrays in
the schema-3 SQLite pack, using validated BLOB columns only where row storage is
measurably too slow. A separate binary sidecar is deferred; introduce one only
after a committed benchmark proves SQLite cannot meet the load target. The
acceptance requirements are:

- one pack data version and content hash bind the topology asset;
- runtime loading avoids reparsing every raw edge row;
- corrupt length, endianness, count, or hash fails closed;
- the fixture representation is deterministic and inspectable in tests;
- generated topology assets remain local/ignored except tiny fixtures.

### Topology algorithms

At pack build:

1. Create the legal directed profile and its physical undirected candidate
   projection.
2. Compute directed strongly connected components for feasibility validation.
3. Compute undirected bridges, articulation points, 2-edge components, and
   vertex-biconnected blocks in `O(V + E)` using iterative traversal.
4. Build the block-cut/bridge forest.
5. Mark cycle-bearing blocks by positive cycle rank.
6. Run multi-source shortest paths from cycle portals to assign exact minimum
   stem distance and connector ownership.
7. Build the metric-preserving decision graph.
8. Audit every access point and every original directed edge mapping.

Do not treat a 2-core as proof that an edge belongs to a cycle; bridges joining
cycle areas can remain in a 2-core. Bridge and block metadata are authoritative.

### Cycle primitives

Do not enumerate all elementary cycles and do not treat one minimum cycle basis
as sufficient. Persist block topology, but in the first implementation generate
and cache a bounded deterministic primitive set lazily at runtime per
vertex-biconnected cycle block using a documented mixture of:

- fundamental cycles from multiple stable spanning-tree orders;
- shortest-path-plus-excluded-edge cycles;
- disjoint-path cycles between selected portals/junctions;
- penalized alternatives for edge diversity.

Retain a Pareto/diversity set bucketed by distance, directional elevation gain,
repetition, surface/trail class, and physical-edge signature. Initial hard cap:
256 primitives per block, configurable in one runtime policy object. Audit and
report discarded counts. Persist primitive archives in a later schema only if
runtime benchmarks prove that doing so materially improves latency without
unacceptable pack size or build time.

## 5. Runtime repository and cache

Introduce a `ClosedRouteTopologyRepository` boundary. The solver must not query
SQLite tables directly.

```ts
interface ClosedRouteTopologyRepository {
  readonly packId: string;
  readonly dataVersion: string;

  getAccessTopology(profile: "known" | "inclusive", accessPointIds: readonly string[]): Promise<AccessTopology[]>;
  getNetworkSummary(profile: "known" | "inclusive", networkId: number): Promise<CycleNetworkSummary>;
  loadDecisionNetwork(profile: "known" | "inclusive", networkId: number): Promise<DecisionNetwork>;
  reconstructDirectedEdges(compressedEdgeIds: readonly number[]): Promise<GraphEdge[]>;
}
```

The graph repository caches immutable decision networks by
`[pack dataVersion, profile, networkId]`. Deduplicate concurrent loads. Bound
the cache by measured byte size, not entry count, and expose
hit/miss/load-byte diagnostics. Pack replacement invalidates the complete
cache.

Primitive generation is solver-owned. Agent C implements a
`ClosedRoutePrimitiveCatalog` that deterministically derives primitives from a
loaded `DecisionNetwork` and caches them by
`[pack dataVersion, profile, networkId, blockId, primitivePolicyVersion]`.
Agent B does not generate or interpret primitives. The primitive cache is also
byte-bounded, reports generation/hit/miss/discard counts, and is invalidated on
pack replacement or policy-version change.

One filtered request may reference many trailheads but should load/search each
distinct cycle network only once. Exact selected-start requests retain that
start's connector and metadata even when another access point shares its
network.

## 6. Closed-route solver

### 6.1 Eligibility and safe pruning

1. Resolve the existing Draw, Named region, or Drive time filter exactly as in
   Gate 4. It filters access points, not hiking geometry.
2. Apply known/inclusive access policy and optional explicit start.
3. Load `access_topology` for all eligible starts.
4. Safely reject starts that cannot reach a directed-valid cycle.
5. Safely reject a start when `2 * minimumStemDistance` already exceeds maximum
   route distance.
6. Safely reject a start when the unavoidable repeated stem already exceeds
   `maximumRepeatedTrailPct` or `maximumSharedStemMiles`.
7. Apply conservative block distance/elevation feasibility envelopes.

Safe pruning must be proved by fixture tests. Beam width, label caps, empirical
gain estimates, random headings, and rank-only start deletion are heuristic and
must never be reported as safe pruning.

### 6.2 Grouping and fair scheduling

Group viable starts by:

```text
networkKey   = [profile, cycleNetworkId]
connectorKey = [networkKey, portalDecisionNodeId, exact compressed connector]
```

Search every network group shallowly before deepening any group in Thorough
mode. Quick mode may defer groups after the shallow pass, but diagnostics must
report the count. Remove the permanent top-eight start rule.

Within a group:

- load the decision network and primitive archive once;
- retain all eligible access points;
- calculate connector-specific lower bounds and route metrics;
- allocate deeper work by feasibility and marginal diversity, with stable IDs
  as the final tie-breaker.

### 6.3 Primitive assembly

Run a bounded resource-constrained assembly search over cycle primitives and
block-cut connectors, not raw geometry nodes.

An assembly label contains at least:

```ts
type AssemblyLabel = {
  networkId: number;
  startAccessPointId: string;
  currentBlockId: number;
  primitiveIds: readonly number[];
  connectorIds: readonly number[];
  distanceMeters: number;
  elevationGainMeters: number;
  repeatedDistanceMeters: number;
  cycleCount: number;
  physicalEdgeSignature: EdgeSignature;
  lowerBoundScore: number;
};
```

Expansion operations:

- choose one cycle primitive;
- add a compatible cycle at a shared articulation;
- traverse a block-tree connector and add a cycle in another block;
- replace a primitive with a distance/gain neighbor;
- remove a primitive when above a maximum;
- swap a connector/alternative path to reduce repetition or overlap.

Distance, gain, repetition, and cycle-count maxima prune immediately. Use exact
return/connector distance lower bounds. Dominance is valid only when all
history-dependent feasibility dimensions, including edge signature or a proven
equivalent abstraction, are covered. Otherwise call it beam/epsilon pruning and
limit it to Quick/Thorough heuristic phases.

### 6.4 Seed and repair

Use deterministic, structurally different seeds:

- nearest feasible single cycle;
- distance-center cycle;
- elevation-center cycle;
- low-repetition cycle;
- disjoint-path cycle;
- multi-block seed when multi-cycle is allowed.

Maintain an archive on both sides of each requested range. Apply local repair by
inserting/removing/swapping a primitive or replacing a connector subpath. Stop
when exact/diverse quota is met or effort budget ends. Record time to first exact
and repair contribution.

### 6.5 Reconstruction and validation

Before scoring or returning a route:

1. Reconstruct the complete ordered list of original directed edges.
2. Verify continuity and return to the exact start access point.
3. Verify every traversal is legal for the active access profile.
4. Verify every segment stays inside exact pack coverage.
5. Recompute distance, gain/loss, maximum elevation, rolling grade, and physical
   repetition from original edges.
6. Analyze the physical trail multigraph; reject zero-cycle routes.
7. Derive topology kind, cycle count, cycle blocks, connector count, repeated
   fraction, and shared stem.
8. Apply all user constraints without silent relaxation.

An undirected primitive that fails directed reconstruction is discarded and
counted in diagnostics. Never synthesize a reverse edge.

### 6.6 Ranking and diversity

Rank exact routes before near misses by:

1. distance/elevation center proximity;
2. lower repeated-trail and shared-stem distance;
3. trail continuity and natural-trail share;
4. access/source confidence;
5. stable route ID.

Topology labels do not affect ranking unless a future contract adds an explicit
user topology preference. They are descriptive output only.

Retain the global 80% physical-trail-overlap rule. First-pass diversity takes at
most two routes per exact access point, then backfills globally. Generate the
candidate archive before diversity selection; do not burden every assembly
state with global result overlap.

## 7. UX behavior

Replace route-shape checkboxes with a Closed route section:

- Maximum repeated trail: slider/input, 0–100%, default 35%.
- Optional maximum shared stem distance.
- Allow figure-eights and chained loops: on by default.
- Search effort: Quick or Thorough, default Thorough.
- Existing distance, elevation, grade, access, trailhead filter, optional
  trailhead, and result-count controls remain.

Explain the model in plain language:

> Closed routes start and finish at the same trailhead. Some may reuse an access
> stem; the repetition control limits how much trail is walked twice.

Result cards display the derived label plus cycle count, repeated percentage,
and shared stem when nonzero. “Lollipop” is descriptive information, not a
warning. Pure out-and-backs never appear.

Keep the Gate 4 statement: “Highlighted areas filter trailheads, not route
geometry.” Coverage, filter, access points, route starts, and route geometry
remain visually distinct.

## 8. Parallel execution sequence

Follow `agent-runbook.md`: at most three subagents, exclusive file ownership,
focused commits, integration one commit at a time, and immediate worktree/branch
cleanup.

### Wave 0 — integrator only

Deliver:

- update this plan only if implementation discovers a genuine contradiction;
- define V3 request/response and manifest/schema-3 contracts;
- define topology repository, primitive, assembly-label, diagnostics, and cache
  interfaces;
- freeze the fixture and five-start benchmark corpus, capture the V2/unified
  baseline, and define the 60-second development-oracle output format;
- add tiny shared graph fixtures for simple loop, lollipop, figure-eight,
  chained loops, bridge-only, directed asymmetry, parallel edges, and a pure
  degree-two cycle;
- define schema migration/build order and a feature cutover checklist;
- commit before delegation.

Verification:

```sh
npm run typecheck
npx vitest run lib/contracts lib/graph
```

### Wave 1 — parallel foundations

#### Agent A — pack topology compiler

Ownership: `lib/data/**`, topology build scripts, compiler fixtures/tests only.
Do not edit contracts, solver, UI, root config, or lockfile.

Deliver schema-3 writing, deterministic dense IDs, known/inclusive topology,
SCCs, bridges, articulations, 2-edge and vertex-biconnected blocks, block-cut
forest, compressed decision graph, access mappings, hashes, audit output, and
fixture reproducibility.

Focused verification:

```sh
npx vitest run lib/data
```

#### Agent B — topology repository and cache

Ownership: `lib/graph/**`, repository fixtures/tests only. Do not edit compiler,
solver, UI, root config, lockfile, or shared contracts.

Deliver validated topology loading, corruption failures, immutable typed runtime
structures, exact reconstruction, concurrent-load deduplication, byte-bounded
cache, pack-version invalidation, and load diagnostics.

Focused verification:

```sh
npx vitest run lib/graph
```

#### Agent C — closed-route solver core

Ownership: `lib/solver/**` and solver fixtures/tests only. Use the shared fixture
repository interface; do not edit SQLite/compiler, API, UI, contracts, root
config, or lockfile.

Deliver safe pruning, network grouping, fair scheduling, deterministic
primitive generation and its byte-bounded catalog/cache, primitive assembly,
seed/repair operations, directed validation hooks, topology classification,
ranking, diversity, deterministic budgets, cancellation, and diagnostics.

Focused verification:

```sh
npx vitest run lib/solver
```

### Wave 1 integration checkpoint

Integrator reviews and integrates A, B, then C. Run each focused suite after its
commit. Connect only the agreed interfaces. Build and audit the schema-3 fixture
pack, run all fixture closed-route cases, record benchmark deltas, then remove
all three worktrees and branches.

Do not begin Wave 2 if:

- fixture topology is nondeterministic;
- any safe prune deletes a long-budget fixture solution;
- reconstruction can synthesize or lose directed edges;
- the topology solver has lower fixture recall than the current solver without
  an understood and documented heuristic reason.

### Wave 2 — parallel vertical slices

#### Agent D — V3 API and server composition

Ownership: route API, server composition, and API tests. Deliver strict V3
validation, effort budgets, structured topology errors, V2 rejection at cutover,
abort propagation, topology diagnostics, and no-network tests.

#### Agent E — builder, map, and results UX

Ownership: builder/map/results components and component tests. Deliver closed
route controls, repetition explanation, effort selection, derived topology
labels, diagnostics/partial states, stale-response suppression, responsive and
keyboard behavior, and removal of active out-and-back/point-to-point controls.

#### Agent F — QA and performance harness

Ownership: scenario fixtures, benchmark scripts, Playwright tests, and QA docs.
Deliver baseline-versus-topology harnesses at 3 and 15 seconds, long-budget
oracle scenarios, all topology kinds, filter modes, access policies,
deterministic repeats, non-color/a11y checks, and fresh-clone commands. Do not
rewrite production code without a narrow integrator assignment.

### Wave 2 integration checkpoint

Integrator performs the coordinated V3 cutover, removes V2 callers, integrates
API/UI/QA commits individually, and runs focused suites after each. Preserve Git
history rather than keeping dormant V2 UI branches.

### Real-pack rebuild and final integration

The integrator:

1. Rebuilds the Santa Cruz pack through the documented explicit bootstrap path.
2. Audits topology counts, compressed mappings, hashes, source attribution,
   coverage, directed legality, and known/inclusive profiles.
3. Runs the five-start POC matrix and broad automatic searches at Quick and
   Thorough effort.
4. Runs curated Draw, Named region, and Drive time scenarios.
5. Compares recall against a 60-second development-only oracle run.
6. Runs `npm run verify` and `npm run test:browser` twice.
7. Performs the fresh-clone check.
8. Checks for secrets, generated packs, caches, stale config, branches, and
   worktrees.
9. Updates Gate 5 evidence in `docs/rebuild/status.md`.

## 9. Test and acceptance plan

### Contract tests

- strict V3 closed-route union and defaults;
- V2 rejected after cutover;
- repetition 0/35/100 boundaries;
- optional stem cap and multi-cycle toggle;
- Quick/Thorough values only;
- 30-mile and 1–20 route-count bounds;
- zero-cycle route response rejected by schema or response validation.

### Compiler and topology tests

- deterministic dense IDs and content hashes;
- known/inclusive profile differences;
- parallel-edge-safe bridge detection;
- articulation and vertex-block membership;
- pure degree-two cycle anchor retention;
- one-way/directed SCC false-positive handling;
- exact compressed-to-original edge mapping;
- holes/concave coverage preserved;
- corruption, count mismatch, and stale data-version rejection;
- reproducible fixture and real-pack audits.

### Solver tests

- simple loop, lollipop, figure-eight, chained loops, and complex closed routes;
- pure out-and-back rejected;
- repeated bridge stems allowed within user cap;
- repeated non-connector edges remain eligible whenever all explicit
  repetition/stem constraints pass, but may rank lower on repetition;
- the same geometry retains the same topology label under every repetition
  threshold that admits it;
- `allowMultiCycle: false` excludes multi-cycle routes;
- no-cycle starts safely pruned;
- exact selected start retained;
- all attachment groups get a shallow Thorough probe;
- no permanent top-eight sampling;
- safe distance/stem/gain bounds preserve oracle solutions;
- local insert/remove/swap repair reaches curated exact cases;
- direction, access, coverage, metrics, budgets, cancellation, and deterministic
  repeats;
- exact/near-miss separation and 80% diversity.

### Browser tests

- all three trailhead-filter modes with closed-route generation;
- repetition and multi-cycle controls;
- Quick/Thorough mode switching and cancellation;
- route cards for every topology kind;
- route geometry visibly allowed outside the trailhead filter;
- no out-and-back/point-to-point active controls;
- partial/no-cycle/no-exact/error states;
- stale-response suppression, responsive panel scrolling, keyboard operation,
  screen-reader announcements, and non-color route distinctions.

### Quantitative acceptance thresholds

On the same machine and pack used for final evidence:

1. Preserve all six overlap-diverse exact results from the five-start POC
   request.
2. Quick mode must not regress five-start combined wall time beyond the current
   7.92-second POC baseline; target at least the measured 20% improvement.
3. Thorough mode must find exact routes from at least as many curated starts as
   the unified current-engine baseline. Compare it with the 60-second
   development oracle and feed the oracle feasibility labels into threshold 10.
4. Every feasible attachment group receives a shallow Thorough probe; no fixed
   start-count cutoff remains.
5. Every returned route passes original-edge directed/access/coverage
   validation.
6. Full-pack topology loading from persisted schema-3 data is materially faster
   than the POC's 2.4-second raw-edge extraction: cold load must be at most 600
   ms with at most 100 MB incremental RSS on the evidence machine, and warm
   cache loads must not parse raw edge rows.
7. Pack topology preprocessing is deterministic. The schema-3 pack may be no
   more than 50% larger than schema 2, and an offline warm-cache build may take
   no more than twice the schema-2 build time on the evidence machine. Record
   both absolute and relative costs.
8. On the feasibility-labeled benchmark corpus, the primitive engine must have
   no lower exact-hit rate than the unified current-engine baseline and must
   deliver either at least 20% faster median time to first exact result or at
   least a 10-percentage-point exact-hit-rate gain at the same budget.
9. Local repair ships only if it improves exact-hit rate by at least 10
   percentage points or reduces the median nearest constraint violation by at
   least 20%, while adding no more than 30% runtime on already-exact cases.
10. Final cutover requires 100% reconstructed-route validity and at least a 90%
    exact-hit rate on cases the 60-second oracle marks feasible. Every remaining
    gap must be listed with its topology, access group, and truncation reason.

Do not claim recall improvement based only on raw candidate count. Measure
overlap-diverse exact routes, distinct starts/networks, time to first exact,
repetition, expanded states, and directed-validation rejection rate.

## 10. Risks, fallbacks, and stop conditions

### Undirected topology false positives

Use SCC/reverse-edge metadata and final directed reconstruction. If more than 5%
of assembled real-pack candidates fail directed validation, add directed block
feasibility before expanding the primitive catalog.

### Primitive explosion

Keep a bounded Pareto/diversity archive and report discarded counts. If 256
primitives per block is too large, tune buckets using recall benchmarks, not
arbitrary global truncation.

### Local-search traps

Use multiple deterministic structural seeds and retain candidates on both sides
of target ranges. Thorough mode must widen seeds/groups rather than repeat the
same local optimum.

### Incomplete elevation or OSM attributes

Unknown remains explicit. Conservative feasibility envelopes may be loose but
must not create false negatives. Final metrics continue to come from original
edge data.

### Topology grouping hides start differences

Share network primitives only. Keep connector metrics, exact trailhead identity,
access state, parking evidence, and final ranking per access point. If two starts
share a portal but have different legal connectors, they have different
`connectorKey` values.

### Falsification checkpoint

After Wave 1 on the real pack, stop and reassess before UI/API cutover if the
topology engine:

- loses any of the six POC exact routes at a 15-second budget;
- produces no additional distinct-start or diversity coverage versus the
  unified-lane POC;
- requires raw graph expansion comparable to the current per-start approach;
- spends more than half its time loading topology assets after a warm cache; or
- shows a directed-validation rejection rate above 5%.

The fallback is still useful: ship the unified closed-route lane and repetition
controls plus persisted safe topology pruning while retaining current
reachable-graph generation. This preserves the measured lane-unification gain
and removes impossible starts without betting the product cutover on the new
primitive assembler.

## 11. Completion evidence template

Gate 5 is complete only when `docs/rebuild/status.md` records:

- V3/schema-3 contract and migration commit IDs;
- schema-3 Santa Cruz data version and deterministic rebuild evidence;
- topology node/edge/bridge/block/network/access counts for both profiles;
- compressed graph size, topology asset size, pack build time, and load time;
- five-start Quick/Thorough/oracle benchmark table;
- broad automatic-search group coverage and time-to-first-exact evidence;
- directed-validation rejection count;
- exact/diverse/topology-kind scenario results;
- two clean `npm run verify` and `npm run test:browser` runs;
- fresh-clone result;
- clean branch/worktree/generated-data audit.

## 12. Research references

- Fixed-length closed-walk complexity, bridge semantics, disjoint-path seeds,
  and local repair: [Lewis and Corcoran (2022)](https://link.springer.com/article/10.1007/s10732-022-09493-5).
- Multiobjective local search for round trips:
  [Lewis and Corcoran (2024)](https://link.springer.com/article/10.1007/s42979-024-03223-3).
- Linear graph decomposition:
  [Tarjan (1972)](https://epubs.siam.org/doi/10.1137/0201010).
- Landmark lower bounds:
  [Goldberg and Harrelson (2005)](https://www.microsoft.com/en-us/research/publication/computing-the-shortest-path-a-search-meets-graph-theory-2/).
- Customizable shortest-path preprocessing, as a connector oracle rather than
  the closed-route generator:
  [Dibbelt, Strasser, and Wagner](https://arxiv.org/abs/1402.0402).
