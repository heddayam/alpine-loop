# Gate 5 closed-route plan

This is the current execution plan for Gate 5. It replaces the original
primitive-catalog/topology-repository rewrite, which was removed in `bb89da3`
after the fallback architecture proved smaller and more practical. Git history
preserves that research plan and its POC.

## Outcome

The active product generates legal, trailhead-rooted closed hiking routes.
Loop, lollipop, figure-eight, chained-loops, and complex-closed are derived
descriptions of validated routes, not separate search modes.

A returned route:

- starts and ends at the same eligible access point;
- contains at least one physical-trail cycle;
- respects directed legality, access policy, exact pack coverage, budgets, and
  every user constraint;
- reports repeated physical trail independently of its topology label;
- is either an exact match or an explicitly labeled near miss.

Pure out-and-backs and point-to-point routes are not part of V3.

## Active V3 request

`POST /api/routes/generate` accepts version 3 only:

```ts
type GenerateClosedRoutesRequestV3 = {
  version: 3;
  packId: string;
  accessFilter:
    | { mode: "drawn-area"; bbox: [number, number, number, number] }
    | { mode: "named-region"; regionId: string }
    | { mode: "drive-time"; reachabilityId: string; regionId?: string };
  startAccessPointId?: string;
  routeFamily: "closed";
  closedRoute: {
    maximumRepeatedTrailPct: number; // integer 0..100, default 35
    maximumSharedStemMiles?: number;
    allowMultiCycle: boolean; // default true
  };
  distanceMiles: { min: number; max: number }; // max 30
  elevationGainFeet?: { min: number; max: number };
  maximumElevationFeet?: { min: number; max: number };
  steepestSustainedGradePct?: { min: number; max: number };
  includeUncertainAccess: boolean; // default true
  accessPointRemoteness: Array<"remote" | "rural" | "populated" | "unknown">; // all by default
  searchEffort: "quick" | "thorough"; // default thorough
  limit: number; // 1..20, default 10
};
```

Quick uses a three-second server budget. Thorough uses fifteen seconds. Raw
state/edge/candidate limits remain server-owned. Both modes are deterministic
for the same request, pack, and budget; neither is called exhaustive.

## Route topology and repetition

Every response route reports:

```ts
type ClosedRouteTopologyV3 = {
  kind: "simple-loop" | "lollipop" | "figure-eight" |
    "chained-loops" | "complex-closed";
  cycleCount: number;
  cycleBlockCount: number;
  repeatedTrailDistanceMeters: number;
  repeatedTrailFraction: number;
  sharedStemDistanceMeters: number;
  connectorCount: number;
};
```

Repeated distance counts every traversal of a physical edge after its first
use. The fraction is repeated distance divided by total route distance. This is
the value constrained by `maximumRepeatedTrailPct`; changing that constraint
must never relabel the same geometry.

- `simple-loop`: one cycle and no repeated physical edge.
- `lollipop`: one cycle whose repeated edges are the access stem/bridge chain.
- `figure-eight`: cycle blocks meet at articulation points without a positive
  connector path.
- `chained-loops`: cycle blocks are joined by positive-length connectors.
- `complex-closed`: another valid cyclic closed walk.

## Selected runtime architecture

The schema-3 compiler persists stable integer node, directed-edge, and physical
edge identities plus two compact access-feasibility profiles:

- `known`: public legal edges only;
- `inclusive`: public plus unknown legal edges.

The request path uses `SQLiteClosedRouteFeasibilityRepository` for safe
no-cycle/stem pruning, then `ReachableGraphClosedRouteSolver` loads bounded
graphs and runs deterministic penalized forward/return search. It uses
disjoint-return refinement, core-aware lollipop search, below-range assembly,
and local repair. Final reconstruction and validation over original directed
edges are authoritative.

This selected fallback deliberately does not retain the discarded runtime
primitive catalog, compressed topology repository, dormant V2 solvers, or the
old scenario-runner framework.

## Search and validation invariants

1. Resolve Draw, Named region, or Drive time exactly as in Gate 4. Filter
   geometry selects access points; it never clips routes.
2. Apply known/inclusive policy and optional explicit start.
3. Apply the requested access-point remoteness classes to both automatic and
   explicit starts. The same classes control map visibility and preview lists.
4. Evaluate feasibility for every eligible access point; there is no permanent
   top-eight cutoff.
5. Safely reject no-cycle starts and impossible unavoidable stems.
6. Probe groups fairly under the selected effort budget.
7. Reconstruct original directed edges before ranking or returning a route.
8. Verify continuity, closure at the exact start, access legality, pack
   coverage, distance/elevation/grade metrics, cycle presence, repetition, and
   shared stem.
9. Rank exact routes first, preserve the 80% physical-trail diversity rule,
   then return at most three labeled near misses.
10. Report budget truncation separately from non-budget shortfall.

## Pack requirements

Schema 3 preserves named areas, coverage, source, metric, and access behavior
from schema 2 and adds:

- `capabilities.closedRouteTopology: true`;
- stable integer directed and physical edge identities;
- `known` and `inclusive` feasibility profiles;
- deterministic access-to-cycle feasibility/stem records;
- content hashes and audit counts bound to the pack data version.

Pack builds remain explicit, atomic, local, and offline-replayable. Runtime
must never infer physical identity from edge-name strings or call network data
sources.

## Required tests

- V3-only request validation and 0/35/100 repetition boundaries.
- Simple loop, lollipop, figure-eight, chained loops, complex closed, directed
  asymmetry, parallel edges, degree-two cycle, and bridge-only rejection.
- Known/inclusive profile differences and exact selected-start behavior.
- Directed/access/coverage reconstruction, metrics, cancellation, budget
  truncation, deterministic repeats, exact/near-miss separation, and diversity.
- Draw, Named region, and Drive time browser flows with V3 closed-route
  controls, responsive/keyboard behavior, stale-response suppression, and
  non-color map distinctions.

Automated tests use committed fixtures only and never access the network.

## Remaining Gate 5 work

1. Verify the migrated V3 Playwright closed-route scenarios twice.
2. Rebuild and audit the Santa Cruz schema-3 pack through `pack:bootstrap`.
3. Run `scripts/research/gate5-topology-real-checkpoint.ts` at Quick and
   Thorough effort against the installed pack.
4. Record exact/diverse results, topology kinds, route validity, truncation,
   and time-to-first-exact for the representative starts.
5. Run `npm run verify` and `npm run test:browser` twice.
6. Perform the final fresh-install, generated-data, secret, branch, and
   worktree audit, then update `docs/rebuild/status.md`.

## Historical evidence and stop conditions

The schema-2 POC found 1,875 of 2,293 eligible access points able to reach a
cycle through 353 portals; 418 could not. A unified lane preserved six diverse
exact routes across five starts and reduced combined wall time from 7.92 s to
5.93 s. The POC source was removed with the discarded architecture; its numbers
remain historical evidence, not a runnable assertion.

Do not complete Gate 5 if the active engine loses those representative exact
routes without a documented reason, returns a route that fails original-edge
validation, silently relaxes constraints, or leaves active callers on V2.
