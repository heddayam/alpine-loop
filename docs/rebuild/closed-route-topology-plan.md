# Closed-route engine reference

This document is the retained technical reference for the active closed-route
engine. The historical Gate 5 execution plan and discarded primitive-catalog
prototype remain available in Git history and are not active work.

## Product contract

The engine generates legal, trailhead-rooted closed hiking routes. Loop,
lollipop, figure-eight, chained-loops, and complex-closed are derived topology
labels, not separate search modes. Pure out-and-backs and point-to-point routes
are not part of the active product.

Every returned route:

- starts and ends at the same eligible access point;
- contains at least one physical-trail cycle;
- respects directed legality, access policy, exact pack coverage, budgets, and
  every requested physical constraint;
- reports repeated physical trail independently of its topology label;
- is either an exact match or an explicitly labeled near miss.

`POST /api/routes/generate` accepts the V3 closed-route request. Schema-3 and
schema-4 packs are supported. Quick foreground searches use a three-second
budget; batch jobs use the Thorough per-trailhead budget. Neither effort means
enumerating every mathematically possible closed walk.

## Runtime architecture

Packs persist stable directed/physical edge identities and `known`/`inclusive`
access-feasibility profiles. `SQLiteClosedRouteFeasibilityRepository` performs
safe no-cycle/stem pruning. `ReachableGraphClosedRouteSolver` loads bounded
graphs and runs deterministic penalized forward/return search, reconstruction,
validation, ranking, and diversity selection over original directed edges.

Filter geometry selects eligible access points and never clips hiking routes.
Exact installed-pack coverage remains the hard geometry boundary. Unknown
access and access-point remoteness follow the explicit request snapshot.

## Validation invariants

1. Reconstruct original directed edges before ranking or returning a route.
2. Verify continuity, closure at the exact start, access legality, pack
   coverage, metrics, cycle presence, repetition, and shared stem.
3. Preserve the 80% physical-trail diversity rule.
4. Return exact results separately from at most three labeled near misses.
5. Report budget truncation separately from non-budget shortfall.
6. Keep automated tests deterministic and network-free.

The August 2026 schema-3 checkpoint validated all returned routes and produced
deterministic result counts. Thorough effort did not monotonically dominate
Quick for every representative start; this is retained as a solver-quality
diagnostic, not as an unfinished rebuild gate. The unified builder removes the
effort selector and batch coverage evaluates every eligible trailhead under a
fixed per-start budget.
