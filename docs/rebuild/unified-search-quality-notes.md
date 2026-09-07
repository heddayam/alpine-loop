# Independent audit of unified subwalk replacement

The prototype has one proposal operation: choose a span in an existing closed
walk, then replace it with a directed connection through a selected arc. Starting
from the empty walk uses the same operation. This is a plausible simplification
of candidate generation; it is not a completeness or optimality result.

The independent offline suite is
[`unified-search-quality.test.ts`](../../scripts/research/unified-search-quality.test.ts).
It uses the public production search signature and authoritative reconstructed
route validation. Assertions concern legal original edges, continuity, topology,
distance, ascent, repetition, and alternative overlap, without fixing route
identity or traversal order. It runs against production by default:

```sh
npx vitest run scripts/research/unified-search-quality.test.ts
UNIFIED_SEARCH_MODULE=/absolute/path/to/unified-route-search.ts \
  npx vitest run scripts/research/unified-search-quality.test.ts
```

## What the neighborhood must permit

- **Nonempty insertion at the same junction.** Replacing an empty span with an
  ordinary shortest path from a node to itself does nothing. Forcing a pivot arc
  permits a cycle or a longer closed excursion. This is how substantial chained
  loops can emerge without a separate chain constructor.
- **Legal connector reuse.** Forbidding every physical edge already walked
  prevents lollipops. The return along a bridge is necessary, provided a useful
  cycle justifies it. Both directions must actually exist in the input graph.
- **Parents that do not yet satisfy all resource bounds.** A remote 2,100 m
  triangle behind a 500 m connector repeats 500 / 3,100 = 16.1% alone. Adding it
  to a distinct 3,000 m root triangle produces a 6,100 m chain with only 8.2%
  repetition. Rejecting the remote component before considering the complete
  walk loses the feasible route at a 10% limit.
- **Coupled or large changes.** One fixture has a longer ascent that adds 1 km
  and a shorter return that removes 1 km. Either individual change misses the
  distance range, while together they give 4,000 m and 200 m ascent. A search
  restricted to feasible small improvements can be trapped; broader spans,
  alternate seeds, or temporarily infeasible parents can cross this barrier.
- **Multiple diverse parents.** A narrow single-incumbent search can return
  several nearly identical walks. The dense-grid fixture requests four results
  and requires at least three, each a physical single cycle with zero repetition
  and no more than 80% pairwise physical overlap.

Passing these examples shows useful neighborhood capabilities, not that the
sampled neighborhood reaches every feasible walk. Bounded pivot choices,
positive path weights, archive pruning, and finite moves can omit useful
connections. The gain-aware acceptance objective also does not make
distance-weighted proposal paths systematically explore high-ascent trails.

## Quality cannot come entirely from additive edge rewards

Two explicit witnesses separate mathematical validity from the user's intent:

1. A 3,000 m simple loop and a 2,400 m main loop with a 600 m side lobe have
   identical distance, first-use distance, ascent, and repetition. An objective
   using only those numbers cannot prefer the simple loop. Cycle count would
   distinguish them, but rewarding it would encourage the unwanted extra lobe;
   penalizing every additional cycle would also penalize useful chains.
2. A route may follow 40 m of the main trail between junctions `u` and `v`, or
   take a 180 m bypass between them. The complete routes are respectively
   2,040 m and 2,180 m, both unrepeated simple loops. At a 2,180 m target,
   distance fit and first-use reward prefer the bypass. Its selected walk has
   no repeated internal junction, so trimming same-node excursions cannot see
   the small departure and rejoin.

The second witness documents an unresolved blind spot. It does not assert that
every short bypass should be forbidden: a short alternative may provide the
better trail, and the current graph metrics alone do not express that judgment.
The user's preference suggests comparing a detour with the nearby continuation
it replaces, potentially using trail continuity and geometry when reliable.
That evaluation can remain separate from the generic proposal operation.

Global deletion of short edges would be incorrect. Short edges can join long
useful cycles, and a deliberately short hike should remain possible. Likewise,
edges that form a small side block in one selected route may belong to a larger
useful loop in another. Quality normalization must consider the selected walk
and context rather than assigning an immutable bad-edge label.

## Observed outcomes

Both production and the revised prototype pass all 11 tests: nine search
scenarios and the two mathematical quality witnesses above. The first
prototype passed nine of the ten initial checks but produced a second lap of a
3,000 m triangle to meet a 6,000 m target with 55% repetition allowed. Its
normalization was extended to remove closed excursions with no new physical
trail. The revised prototype passes that check while retaining the valid chain
and one-way lollipop.

The suite also rejects a one-way connector with no legal return, removes a
600 m side loop with and without a 1,000 m approach, and preserves a standalone
600 m hike. Those checks prevent a coarse minimum-loop-length rule from passing
by deleting every short route.

These are tiny deterministic fixed-work tests with `now: () => 0`. They do not
measure deadlines, regional throughput, optimality gaps, or human judgments of
real routes. Their short runtimes should not be presented as production speed
comparisons. Regional measurements and budget/cancellation checks remain
separate integration evidence.
