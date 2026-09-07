# Solver alternative experiments — 2026-09-07

The strongest supported direction is direction-safe corridor contraction plus a
small correction to cycle assembly. A simpler bounded depth-first replacement
found one useful chained loop but lost diversity and spent more states on grids.
These are independent experiments against `7329c88`; they do not establish
regional performance. The integrator owns production implementation and regional
benchmarks.

## A concrete missed chained loop

Use a bidirectional 3,000 m triangle `s-a-b-s` with three 1,000 m edges. Add a
500 m connector `s-p` and a second triangle `p-x-y-p` with three 700 m edges.
Request 6,000–6,200 m, at most 10% repeated trail, multiple cycles permitted,
and one result. The old generator returns no exact route.

The missing walk is 6,100 m: first triangle, connector, second triangle,
connector back. Only 500 m is repeated, giving 8.197%. Production authoritative
validation classifies the experimental result as `chained-loops`, with two
cycles, one connector and zero shared approach distance.

The old search already discovers both constituent cycles. It excludes the
3,100 m lollipop from assembly because its own repetition is 500/3,100 = 16.13%.
`assemblyPass` only accepts archived near candidates whose violations contain
`below`. Repetition percentage can **decrease** when another distinct cycle is
added, so this filter rejects a feasible combination before testing it.

The isolated correction accepts both below-minimum and repeated-trail violations
for assembly, retaining the sound bound:

```ts
candidate.metrics.repeated <= maximumRepeatedFraction * maxMeters
  && candidate.violations.every((item) =>
    item.includes("below") || item === "repeated-trail-above-maximum")
```

Already repeated distance cannot disappear on concatenation. This bound avoids
spending the assembly budget on candidates that cannot satisfy repetition even
at the maximum allowed route length. Every assembled walk still goes through
normal metrics, all constraint checks, diversity selection, and authoritative
validation. This is a search correction, not relaxation of the user's limit.

The guarded correction finds the 6,100 m route with the same 62 expanded states
as the old search. Eight other scenarios match the old full low-level result
objects exactly, including diagnostics: triangle, dead-end spur, reverse lap,
lollipop, one-way triangle, and 5×5, 8×8 and 12×12 grids. A naïve correction
without the bound preserved exact results but increased wasted work on the
zero-repetition 5×5 grid from 40 to 52 candidates and changed close matches;
that variant was rejected.

## A simpler replacement was prototyped, then rejected

A temporary replacement reused the old graph builder, candidate evaluation,
archives and diversity rules. It replaced the multiple search phases with one
bounded depth-first traversal, ordered by closeness to the requested length,
using one reverse shortest-distance tree as a return lower bound. It prohibited
immediate physical reversals and reuse of a directed edge; revisiting a node
remained allowed so that distinct loops and connectors could be combined.

This constructs loops, lollipops and chains with roughly 74 search lines. Its
710-line temporary file still retained unused old helper code; that is not a
production line-count claim. It deliberately changes the candidate space and
would need further budget, cancellation, metric and direction testing.

With the same 100,000-state/2,000-candidate caps and a frozen clock:

| Scenario | Old exact / expanded states | DFS exact / expanded states |
| --- | ---: | ---: |
| 3,000 m triangle, limit 1 | 1 / 6 | 1 / 6 |
| 4,000 m lollipop, limit 1 | 1 / 34 | 1 / 9 |
| 6,100 m chain above, limit 1 | 0 / 62 | 1 / 17 |
| 5×5 grid, limit 10 | 2 / 392 | 8 / 6,698 |
| 8×8 grid, limit 10 | 10 / 2,239 | 9 / 7,794 |
| 12×12 grid, limit 10 | 10 / 5,886 | 6 / 23,561 |

Each grid has bidirectional horizontal/vertical 100 m edges, starts at a corner,
and requests 1,800–2,200 m, zero repetition and multiple cycles. DFS spends work
on many similar routes before finding diverse alternatives. Applying the
integrator's initial corridor contraction to the prototype scarcely changed
large-grid state counts, because grid junctions cannot be contracted. Tiny
fixture timings were measured but are too small and insufficiently controlled
to support a speed claim. Expanded states mean settled shortest-path vertices
in the old algorithm and attempted DFS edges plus the initial tree in the
prototype; the counts describe work, not equivalent operations.

The precise assembly correction recovers the demonstrated chained-loop gain
without the DFS replacement's diversity loss. Do not add the replacement as a
second permanent solver on this evidence.

## What “better” should measure

Measure exact-result availability, physical diversity and target/gain fit
alongside wall time and memory. Count repeated directed traversals, repeated
cycle distance, immediate reversals, and non-start dead-end excursions to detect
route-length padding. Also record distinct cycle blocks and the lengths of
connectors that reach them. More cycles alone is not a quality objective.

A 3,000 m triangle requested as 5,900–6,100 m with 55% repetition illustrates a
quality weakness: the old solver accepts the same triangle forward then backward
(physical sequence `1,2,3,3,2,1`, 50% repeated). The guarded assembly change
preserves it; it does not solve lap ranking. The DFS prototype rejects it by
construction, but that restriction also changes the meaning of permissive
repetition settings. Prefer measuring and ranking distinct useful trail over
laps before adopting a new blanket legality rule.

Never reject equality between the first and last physical edges: a legitimate
lollipop has exactly that form at its start. Likewise, a useful connector can be
a bridge in the chosen route even when an unused alternative means it is not a
bridge in the entire reachable graph. Quality penalties must distinguish these
cases. A triangle plus an out-and-back dead-end spur was also tested, but the old
search did not return it as exact; it is a regression scenario, not a reproduced
old failure.

## Why other named algorithms are not direct replacements

- **Shortest disjoint paths:** Suurballe's original algorithm minimizes the total
  length of node-disjoint paths between fixed terminals. That can improve a
  simple-loop return primitive, but minimum length does not enforce a requested
  lower length/gain bound, and disjointness excludes required shared approaches.
  Reversing a forward path also requires legal reverse arcs. This is an inference
  about our contract, not a deficiency in the original algorithm.
  [Suurballe, 1974](https://onlinelibrary.wiley.com/doi/10.1002/net.3230040204).
- **Enumerating elementary cycles:** Johnson's output-sensitive bound is
  `O((n + e)(c + 1))`, where `c` is the number of cycles. Enumeration still needs
  bounded output, trailhead approaches and composition for this product; it does
  not make the number of possible cycles small. Our grid experiment independently
  demonstrates the practical diversity problem with a simpler enumerator.
  [Johnson, 1975](https://epubs.siam.org/doi/10.1137/0204007).
- **K shortest walks:** Eppstein permits repeated vertices and edges and provides
  an implicit path representation with `O(m + n log n + k)` total work. This is
  attractive for shortest alternatives, but our requested minimum length and
  repeat/diversity checks can discard many early outputs. It does not directly
  fix repeated-lap quality. These application limits are our inference.
  [Eppstein, 1998](https://ics.uci.edu/~eppstein/pubs/Epp-SJC-98.pdf).
- **A fixed cycle basis:** a basis is not a complete list of useful hiking cycles.
  For three internally disjoint paths between two junctions with lengths 1, 2
  and 4 km, a basis containing the 3 and 5 km cycles omits the 6 km cycle. XOR
  can recover it, but enumerating combinations reintroduces a search problem;
  directed legality and shared connectors need separate treatment.

## Verification and scope

All experiments were local and network-free; browsing was used only for the
primary references above. The runner used production search and authoritative
validation on temporary deterministic graphs, with fixed budgets and a frozen
clock. It asserted the chain's distance/topology/repetition and equality of the
eight other full results for the guarded assembly correction. The scripts and
alternative source were temporary `/private/tmp` artifacts, not new production
or test dependencies. This documentation-only task did not run the full suite,
rebuild packs, or claim browser or installed-pack acceptance.
