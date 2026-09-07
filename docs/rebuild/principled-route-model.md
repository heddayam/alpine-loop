# A principled objective for generated hiking routes

The underlying problem is **selecting a connected, directed closed trail walk
under resource constraints, with reward for first use of physical trail**.
This is a useful common model for candidate generation, improvement and ranking.
It is not an ordinary shortest-path problem obtained by changing one static
weight on each edge.

Arc orienteering similarly collects an arc's profit once while charging every
traversal against a travel budget. Prize-collecting rural postman models also
separate first-use edge profit from repeated travel cost. These are relevant
starting points, not ready-made solutions to our exact hiking constraints.
[Arc orienteering primary paper](https://www.syros.aegean.gr/users/dgavalas/en/iframe_files/papers/2015/IPL_submitted.pdf),
[prize-collecting rural postman primary report](https://optimization-online.org/2007/11/1829/).

## An exact model for the additive part

Take the coverage-constrained legal directed graph `G=(V,A)`, eligible start
`s`, and physical trail edges `E`. `A(e)` contains the legal directions of
physical edge `e`; illegal directions are absent. Unknown access follows the
request. Search-area filters select `s` and never clip this graph. Direction-
preserving corridor contraction is compatible if original traversals remain
available for reconstruction.

For each physical edge, let `l_e > 0` be its direction-independent trail length.
For each directed arc, let `g_a >= 0` be ascent. Use these variables:

- Integer `x_a >= 0`: traversal multiplicity of legal directed arc `a`.
- Binary `y_e`: whether physical edge `e` is used at least once.
- Binary `z_v`: whether vertex `v` is used, with `z_s = 1`.
- Nonnegative continuous `f_a`: artificial connectivity flow, not hiking travel.

Finite bounds follow from distance: `M_a=floor(D_max/l_e)` and
`M_e=sum(a in A(e), M_a)`. Link the variables and enforce balance:

```text
y_e <= sum(a in A(e), x_a) <= M_e y_e
x_(u,v) <= M_(u,v) z_u;  x_(u,v) <= M_(u,v) z_v
z_v <= sum(a leaving v, x_a)
sum(a leaving v, x_a) = sum(a entering v, x_a)       for every v
```

Balance alone permits disconnected collections of cycles. Require the start to
supply one unit of artificial flow to every other used vertex:

```text
0 <= f_a <= (|V| - 1) x_a
sum(f leaving s) - sum(f entering s) = sum(v != s, z_v)
sum(f entering v) - sum(f leaving v) = z_v           for v != s
```

Thus every selected vertex is reachable from `s` along selected arcs. Together
with integer directed balance, this gives a connected Eulerian multigraph:
its selected traversals can be ordered into a closed walk from `s`. An Euler
walk is then reconstructed on original directed edges. A different traversal
order can still have different junction behavior and grade runs.

Define total distance, first-use distance, repeated distance and gain:

```text
D = sum(a, l_physical(a) x_a)
U = sum(e, l_e y_e)
R = D - U
G = sum(a, g_a x_a)
D_min <= D <= D_max
G_min <= G <= G_max                                 when requested
R <= rho D                                         rho = requested percent / 100
```

The repeat-ratio constraint is linear: `(1-rho) D <= U`. It counts the second
and every later use of the same physical trail regardless of direction. It also
explains why adding a distinct loop can make a previously excessive repeated
fraction acceptable. Physical directions must share one measured length for
`D-U` to match this definition; otherwise retain the application's exact
first-use accounting instead of silently substituting this identity.

On connected selected physical support, cycle rank is also linear:

```text
C = sum(e, y_e) - sum(v, z_v) + 1
C >= 1
C <= 1                                             if multi-cycle is forbidden
```

Counting directed arcs here would falsely treat an ordinary out-and-back as a
physical cycle. Self-loops and distinct parallel physical edges retain their
normal graph meanings. `C` counts independent cycles, not attractive loops.

## Objective: first use, repeat cost, target fit

One interpretable illustrative objective is:

```text
maximize sum(e, q_e l_e y_e) - lambda R - mu t
subject to t >= D - D_target; t >= D_target - D
```

A second absolute-deviation term can target the requested gain midpoint.
`q_e=1` means equal reward per new metre, not inferred beauty or safety. Rewards
for scenery or trail character require real data. Start with explicit,
normalized weights and test them against reviewed route comparisons. Keep exact
physical limits as constraints; do not hope that a penalty makes violating them
unlikely. Produce close matches through a separately labeled relaxation path.

This formulation pays for a corridor on every traversal but rewards its
physical trail only once. A static per-traversal weight cannot express that
history. At fixed total distance with `q_e=1`, maximizing first-use distance is
just another way to minimize repetition; it does not independently measure
scenery, sensible cycle size or good junction transitions.

The following still require selected-support or walk-order calculations:

- Shared approach length, connector usefulness, tiny side-loop size and
  non-start dangling branches depend on the selected physical subgraph.
  A connector may be a bridge in that subgraph while not being a bridge in the
  full graph. Penalizing every repeated edge identically misses this distinction.
- Rolling 100 m grade and longest steep climb depend on the order of elevation
  samples across edges. Summing arc weights or choosing any Euler order cannot
  enforce them exactly. Persisted per-edge bounds are only part of those checks.
- Maximum elevation is a selected maximum. Its upper bound can forbid arcs;
  its lower bound requires selecting at least one arc reaching that elevation.
  It must not be added as if it were cumulative ascent.
- Alternative-route overlap depends on previously selected physical trails.
  Those first-use intersections can be constrained after each selected route,
  preserving the existing 80% diversity semantics and user count.

These properties can be modeled with more variables/cuts or evaluated on the
reconstructed walk. Merely evaluating and rejecting one Euler ordering does not
prove that no valid ordering exists. A full exact model needs to represent the
remaining properties, or its optimality claim must explicitly exclude them.

If structural checks generate cuts, condition them on the selected support.
Edges belonging to a tiny side block today can become part of a larger block
after another connecting path is selected; never globally prohibit those edges
based on one candidate. A no-good cut may exclude that exact support, or a
candidate may be normalized and reevaluated. Failure of one traversal ordering
alone does not justify excluding every ordering of the same support.

## Exact tiny-graph experiments

Run the committed dependency-free oracle:

```sh
python3 scripts/research/route-model-oracle.py
```

It exhaustively enumerates `x_a in {0,1}` for each legal direction. Thus one
physical edge may be used once in each direction, but same-direction laps and
other larger multiplicities are deliberately excluded. Connectivity is checked
directly instead of solving the equivalent artificial-flow constraints. It
implements distance, ascent, repetition, physical cycle rank and an illustrative
`U - R - abs(D - target)` objective. It does not implement full elevation
profiles, shared-stem limits or production route-quality pruning.

| Case | Exhaustive result |
| --- | --- |
| 3,000 m triangle at `s`, 500 m connector, remote 2,100 m triangle; 6,000–6,200 m, 10% repetition | Four feasible directed selections, each 6,100 m with 500 m repeated and two cycles. |
| Two disconnected 3,000 m triangles; 5,900–6,100 m, zero repetition | No connected solution; omitting connectivity incorrectly admits four selections. |
| 1,000 m approach plus a 30 m triangle; 2,000–2,050 m, 50% repetition | Two feasible selections. Best is 2,030 m with 1,000 m repeated; only 30 m lies on a physical cycle. |
| A 3,000 m triangle; 5,900–6,100 m, 55% repetition | One feasible support, using every direction once: 6,000 m with 3,000 m repeated. First-use rewards discourage it but do not make it infeasible. |
| One-way 3,000 m triangle | One feasible direction; unavailable reverse arcs are never synthesized. |
| Chain with positive minimum ascent but all input gains zero; chain with multi-cycle forbidden | Both infeasible. |

The 30 m triangle is the critical counterexample: all linear constraints and
first-use rewards can be satisfied by an almost out-and-back route. A generic
edge prize does not know whether that small loop justifies its approach. With
only this feasible option, changing objective weights cannot manufacture a
better one. A structural preference or explicit quality threshold must express
that intent, and should not silently become an unrequested hard constraint.

The script asserts these outcomes, reconstructs closed walks for selected
connected solutions, and examines 57,672 selections in total. A local system
Python run took approximately 0.21 seconds; this is a tiny-model correctness
check, not a regional solver benchmark or proof for unrestricted walks.
The bundled Python had no SciPy, so no MILP package or application dependency
was installed.

## Practical algorithm direction

Use the formulation as an oracle and one shared objective first. Next compare
an anytime local search that inserts, removes or replaces connected pieces of a
route. A move can add an unvisited cycle with its legal connector, replace a
return path, or remove a poor side loop; evaluate the entire resulting walk
against the same objective and authoritative constraints. Larger neighborhoods
can reconsider several coupled loops together, using a small bounded integer
subproblem if a suitable solver is already available. Retain diverse incumbents
and return the best validated ones at the deadline.

That design replaces a growing collection of special-case acceptance rules
with explicit feasibility and a common measure of improvement. It does not
promise global optimality for runtime heuristics. Keep the current implementation
as benchmark/initial candidate generator until measured regional comparisons
show better quality, speed or simplicity. Test optimum gaps on small instances,
then fixed-budget route quality, time to first exact result, diversity and memory
on real graphs before proposing a wholesale replacement.
