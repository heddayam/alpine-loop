# Route search: coverage, useful matches, and bounded work

Accepted priorities, 2026-09-30: missing suitable hikes and slow searches come
first; regional build speed is secondary. Longer searches are useful when they
discover substantially more suitable hikes and publish incremental results.
Prefer distinct physical loops, shorter repeated approaches, and good constraint
matches. On September 30 the user explicitly chose automatic continued
improvement after an initial pass across every trailhead, with Stop retaining
results. The continuation implementation and final integration gate are tracked
in [status](status.md).

## Implemented per-attempt changes

One shared route-elevation module supplies exact profile windows and grade
experience; one shared ranking function supplies constraint violations and
scores. The former generator's endpoint-only profile approximation could hide
an exact grade match. Full validation still checks shape, continuity, access,
coverage, elevation completeness and original directed reconstruction.

The candidate archive retains the best exact or close approach to each physical
cycle under the work limit. It no longer discards unrelated loops behind a
fixed 256-candidate score archive. Diversity compares cycle edges, excluding
the repeated approach. Final selection validates candidates before allowing
them to suppress another result. Shared ranking and final route-ID ordering
permit skipping lower-ranked overlaps with already validated exact routes and
stopping after the requested number of validated diverse routes for one start.

One path traversal searches exact numerical matches first and uses the same
implementation for a close-match fallback. Exact prefixes can be pruned by
nonnegative upper distance/gain/elevation bounds; lower distance/gain limits are
checked only on completed routes. A small unsuccessful-search reserve allows
the fallback. The fallback has its own fixed work allowance and does not control
whether exact-match exploration is complete.

Physical biconnected decomposition is iterative and handles self-loops, parallel
trails and reverse records. A simple cycle belongs to one block. Thus a prefix
that enters a different block must be a reversible stem if it reaches a later
cycle; bridge edges also require their physical reverse. Alternative paths and
longer stems inside blocks remain eligible.

When a prefix can no longer be a legal stem of any later attachment, the search
computes a fresh reverse weighted-distance bound in its residual graph. Every
still-eligible ancestor is a terminal target seeded with its actual return-stem
length. Other prefix nodes and used physical trails are forbidden. Any legal
completion must reach one of these ancestors; the shortest allowed return is a
lower bound. Future attachments cannot become eligible again because stem
length, reverse length and gain are nonnegative. No path-relative blocking
state is reused under another prefix. Bound computations count against work
and deadline limits and never establish exhaustion when interrupted.

The prepared reader reuses bounded decoded-edge and exact-containment caches
scoped to immutable artifacts. Public mutable results are copied. Worker's
available slots are leased directly; the coordinator refills them on completion
while retaining at most two waves of uncommitted work. Durable checkpoints stay
in start order. Running/failed jobs expose saved results. The UI refreshes the
first page while active, freezes the collection in route details, rejects late
responses, and enables cursor paging after the job stops.

## Sources and limits

- [Birmelé et al., optimal cycle/path listing](https://arxiv.org/abs/1205.2766)
  motivates block localization. Its undirected algorithms do not establish
  directed access or reversible approaches in this application.
- [Rizzi, Sacomoto and Sagot, bounded weighted paths](https://arxiv.org/html/1411.6852)
  motivates fresh residual shortest-path bounds. Our multiple ancestor targets
  include exact reverse-stem costs; simply deleting the whole prefix and
  demanding a new return to the start would incorrectly exclude lollipops.
- [Bauernöppel and Sack, version 4](https://arxiv.org/html/2512.08392v4), July 2026,
  supplies counterexamples to cached bounded-cycle locks. Its SimpleSearch is
  for simple unweighted directed graphs. We do not transfer its delay bound to
  this weighted physical multigraph or its additional hiking constraints.
- [GraphHopper 11 custom-model preparation](https://github.com/graphhopper/graphhopper/blob/11.0/core/src/main/java/com/graphhopper/routing/weighting/custom/CustomModelParser.java)
  informs preparing polygon predicates once. Exact containment, including holes,
  remains our rule; intersection is insufficient. No GraphHopper/jsprit runtime
  dependency or regional schema change is introduced.

Independent tiny-graph enumeration separately chooses every reversible simple
stem and simple cycle. It uses no production contraction, return bounds or
archive. It exposed and now guards the profile-minimum, common-approach and
archive-pressure omissions. Random directed multigraphs include asymmetric
reverse metrics and alternative stems. These checks establish regression
evidence, not universal regional completeness or an optimal running-time claim.

## Continuing Full searches

The first pass gives each eligible start 50,000 expanded states and 1.5 seconds.
Only starts whose exact search stopped by a work or time allowance qualify for another attempt.
After the entire pass has durably committed, their allowances double. An attempt
replays deterministic search with a larger allowance; no DFS cursor is serialized.
This keeps recovery small and makes the replay cost explicit. Doubling bounds
allocated budgets below twice the last budget, but actual traversal can approach
three times uninterrupted work when the final attempt finishes shortly after its
predecessor's allowance. Graph loading, validation, and timing add separate costs.

Memory limits remain fixed: 40,000 loaded directed edges, 8,000 retained physical
cycles, and 32 MiB of accounted candidate payload. The last allowance includes
strings, arrays, maps, and materialized edge references; it is not a JavaScript
heap guarantee. A new cycle beyond capacity makes exploration limited. Reaching
exactly the capacity does not establish truncation; a better approach to an
already retained cycle can still replace its incumbent. Candidate offers are a
work diagnostic, not a coverage limit, and no ever-growing identity set is kept.
Explicit safe-integer and timer ceilings prevent numerical overflow or an
identical retry after budget saturation.

Each outcome is typed: exact exploration exhausted within the configured search
space, retryable, or limited. A start attempted once stays counted as attempted during refinement.
Progress separately reports exhausted, unfinished, and limited starts. A job can
finish with partial exploration because of a fixed limit. Historical jobs remain
historical; missing old completion metadata never causes automatic retries.
Stop preserves committed results. Restart repeats only the interrupted attempt
with its same allowance, against the job's pinned installation.

Refinement retains a better whole result set per start: distinct exact-loop count
first, then aggregate shared quality score and deterministic ties. Exact results
beat a close-only set; close matches compare violation count and magnitude before
quality. A worse or failed attempt cannot erase a better set. This does not mix
individually useful routes from competing sets: safely doing that would require
persisting physical-edge overlap metadata, beyond physical loop IDs alone.
Cross-start geometry deduplication chooses a stable owner when results are read,
so replacing one start's results cannot permanently erase another start's copy.

Numerical pruning allows conservative floating-point summation error, while
completed candidate metrics use original-edge order and strict requested ranges.
An independent decimal-length counterexample guards the case where contracted
addition puts a valid route a fraction above its maximum distance.

The ten-route retention and overlap policy still apply. Exhausting an eligible
start's configured exact search does not claim all regional hikes are known: source
coverage, admission, installed graph boundaries, and retention remain relevant.
See the [regional benchmark](route-search-benchmark.md) for pinned-input discovery,
quality, timing, and memory measurements, including observed regressions.

## Close-match continuation correction

The user's Santa Cruz search exposed a phase-accounting defect: an exhausted
exact search could remain retryable solely because the relaxed close search hit
its work allowance. On pass 13, three starts each examined 204,800,000 states in
116–132 seconds and retained zero exact routes. Their diagnostics had no exact
phase limit and no authoritative rejections. The running Docker solver's source
hash matched the inspected implementation. All eight then-unfinished starts had
zero retained exact routes, although some still had genuine exact exploration
remaining. These are observations of one live job, not a regional benchmark.

An independent 6-by-6 fixture makes every directed edge's gain exceed the total
requested gain cap, proving that no exact route is possible. The former solver
nevertheless consumed each increasing allowance finding close alternatives and
classified the start as retryable. The user explicitly chose to keep a useful
close match and finish once exact exploration is exhausted.

Exact truncation and close-match truncation are now recorded separately. The
close fallback receives at most 50,000 additional states and 1.5 seconds,
constrained by the remaining attempt allowance and existing memory caps. Its
limits cannot cause another exact-search attempt; genuine exact limits still do.
The same separation applies to a deadline reached only during close validation.
Progress says "exact search complete" and discloses bounded close exploration.
The best already-saved close match is preserved by normal incumbent retention.
This does not eliminate combinatorial exact-search tails or implement resumable
DFS; those remaining cases can still take substantial time.

A read-only probe of sealed Santa Cruz artifact
`880dab3b314d1be687684a5e2111b5cca9ad26a9802038efb8ed9c36e212e655`
used the live criteria (7–9 miles, 2,000–2,600 feet gain, 10% repeated trail,
3-mile maximum shared approach) and pass-13 allowance. Starts `300752719`,
`331113416`, and `65389932` now exhaust exact exploration in 221,218, 203,583,
and 545,565 total states, respectively, retaining useful close routes. The same
three live attempts had each consumed 204,800,000 states. The probe's elapsed
times were 170, 113, and 207 ms; those host timings are not a controlled speedup
comparison against the concurrent Docker job. The installed files and live
search were not modified. The private report is
`/private/tmp/alpine-tail-probe-result.json`.
