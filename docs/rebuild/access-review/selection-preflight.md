# Selection and membership preimplementation challenge

Reviewed base: `8185478a7df8ba683b8bdb6f1436d717fa3a595b`, 2026-09-30.
This challenges the proposal in `access-point-review.md`; it changes no app behavior.
No real source, pack, download or live database was inspected. Read the repository
instructions, implementation plan, runbook, proposal, active code and fixtures.

## What is established, and what is not

| Finding | Evidence | Classification |
| --- | --- | --- |
| Named artifacts already contain a frozen entrance list. | `lib/data/progressive/portals.ts:349-367`; `lib/coverage/runtime.ts:194-223,268-272`; `lib/data/prepared-release.ts:67-68`. | Established mechanism; a new parallel global catalog is unnecessary. |
| Current map dots ignore active-area predicates. | `lib/server/map.ts:19-39`; `components/map/HikeMap.tsx:960-972`; contrast `lib/solver/eligible-access-points.ts:114-119`. | Established surface inconsistency if dots mean eligible starts; contextual display itself is a product choice. |
| Enumeration/map use inclusive cycle hints even when unknown is disabled. | `lib/graph/prepared-repository.ts:190-191`; `lib/solver/eligible-access-points.ts:28-40,119`. | Established count/eligibility inconsistency; not a demonstrated unknown-route permission leak. |
| Solver execution already chooses the requested profile's stem hint and traversability. | `lib/solver/reachable-graph-closed-route-solver.ts:333-358,429-435`. | Existing safety behavior; retain it, do not claim the selector is introducing known-only routing safety. |
| Local ownership checks a node, not an entrance record. | `lib/graph/prepared-repository.ts:127-130,173`. | Code-derived shadowing mechanism; absence of a start row in an earlier owner is not covered by the existing overlap fixtures. No regional frequency measured. |
| Named selection adds proximity to registration geometry. | `lib/coverage/plan.ts:77-80`; `lib/solver/eligible-access-points.ts:43-54`. | Established policy; cross-region leakage is conditional and unmeasured, rather than every accepted nearby start being invalid. |
| Buildings, 25-mile association and routes heading away from cores are deliberate. | `lib/data/wilderness.ts:20-32`; `lib/coverage/prune.ts:67-109`; `lib/coverage/runtime.test.ts:193-209`. | Product decisions. Removing density changes the desired population; it cannot count as correcting all old density exclusions. |

Baseline fixtures establish invariants, not precision/recall. The proposal has not
measured the prevalence of overlapping-owner failures or named membership errors,
nor established that revised admission improves every region.

## The smallest membership representation already exists

Each current named region exports one independent artifact with a `regionId` and
only its admitted `access_points` rows. Use those rows as membership authority and
their source identities as entrance identity. Union installed memberships for a
drawn/driving request; test requested region IDs for named selection. Derive any
installation lookup from those immutable rows, rather than authoring another
entrance list or using circles to manufacture membership. The current contract
already checks one artifact per local section and consistent optional region ID
(`lib/contracts/releases.ts:78-85`). Integrator-owned compatibility remains needed
for artifacts that do not declare these guarantees.

Keep inclusive-admitted starts once, with profile-specific entry witness eligibility
and route hints. Do not duplicate known/inclusive entrance catalogs. A start with
only an unknown witness remains installed but unavailable when unknown is disabled.
An unused uncertain parking alternative must not taint a known usable witness.

The proposal must settle one owner edge case before coding: lexical owner A can
have only an uncertain entry witness while B has a known witness at the same real
entrance. Selecting A before testing profile eligibility can suppress a known
start. Choose among actual entrance records admitted **in the requested witness
profile**, then stable-sort before cycle/criteria feasibility; alternatively
prove/audit identical profile admission across all eligible owners. Neither
alternative chooses by solver success. Pin the resulting owner with the request.
This is a prospective design counterexample, not a measured current-data defect.

Even genuine admitted owners can have different topology because of hard support
exclusions. A fixed owner may lack a cycle present in another artifact. The
first release should keep the stated deterministic policy, disclose its limits,
and audit complete support under equivalent inputs; do not promise the union's
best route or secretly merge graphs. Existing overlap fixtures intentionally
permit different hints/edges (`lib/graph/prepared-repository.test.ts:402-445`).

## Make regional association precise without changing it accidentally

For the first release retain **inclusive, undirected hiking/possible-link distance
of at most 25 miles to a mapped unambiguous hiking link touching the core** as
static destination association. Ordinary roads cannot establish it. The active
pass ignores direction and seeds both endpoints of a touching segment
(`lib/coverage/prune.ts:19,67-83`), not its exact intersection with the core.
It therefore does not certify a permitted directed journey into the mountain.
Retain that meaning explicitly; a directed, known-only or must-visit-core rule
would be a further relevance change, not a safe refactor.

A known entrance may accordingly remain associated with a region through unknown
links while producing a known nearby loop heading away from it. If unacceptable,
decide the product semantics before implementation; do not hide a second regional
admission system behind the unknown toggle. Decouple the named relevance constant
from the route-support bound without changing its value.

Complete hiking support does not imply complete ingress context. The proposal's
arrival-root witness can follow mixed-use approaches beyond the initial extract.
Root absence in a clipped context is not proof of physical absence. Declare the
source-context scope, retain complete witnessed approaches before pruning, and
classify truncation/unsupported context as source limitations. A newly found
arrival root during support expansion must not silently enlarge the frozen start
set. Existing extraction expressly lacks a completeness certificate
(`lib/coverage/source-filter.ts:66-81`).

## One selector, with appropriately weak promises

Use the same pinned input and profile for Full IDs, eligible map highlighting,
counts and explicit-start validation. Keep viewport limitation as rendering only;
outside-filter dots may remain contextual. Do not show an eligible driving set
before contour resolution or broaden it after failure. Keep viewed-job selection
separate from the editable form.

Use the owner's requested-profile **null cycle hint** only as a safe exclusion.
A finite hint is optimistic for a subset and proves no route satisfies the user's
constraints (`lib/solver/reachable-graph-closed-route-solver.ts:333-336`). Do not
move every solver feasibility check into eligibility without proof covering both
exact and close matches: current `safeFeasibility` uses the exact requested maximum
(`:85-95,345-357`). A long unavoidable stem can fail exact distance but permit a
longer labeled close match. That boundary needs a dedicated acceptance case;
the present fixtures do not settle it. Known/inclusive metadata and hints must
describe the same movement policy and graph; never reuse hints after that policy
adds passages/directions merely because physical measurements were reused.

## Migration and the simplest safe first release

Current plans pin installation and area, not a selector version or explicit owner
(`lib/server/search-plan.ts:4-8`). Restart also enumerates before preserving stored
IDs (`lib/route-jobs/service.ts:182-188`; `lib/route-jobs/store.ts:186-197`).
Thus the proposal's old-job preservation is future work, not an existing guarantee
under a changed algorithm. Missing data differs from unsupported semantics.

Ship one new selection policy over frozen artifact rows. Keep old geometry/results
readable; if old computation cannot be supported exactly, stop those unfinished
jobs with a clear reason and preserve partial results, rather than retaining a
permanent second selector or silently re-enumerating. This is an explicit migration
choice. New searches must use compatible contributing artifacts. Define
contributing by request memberships and owner candidates: an unrelated old region
must not disable a compatible selected region merely because both are installed.
Suppress incompatible eligible markers as well as rejecting incompatible jobs.

The first selection release needs record-based membership/ownership, requested
profile checks, shared rendering/enumeration decisions and pinned job meaning;
it does not need a car-routing stack, another geographic source or a second saved
entrance catalog. Couple it to the chosen versioned admission compiler and delete
superseded geometry admission rules. Density removal remains a deliberate product
change evaluated separately against the revised relevance target.

## Exact acceptance cases and verification

Require: B's admitted start versus A's ordinary node; B at 750 m from A's registered
anchor; a start inside A's circle but absent from A's table; A uncertain/B known
witness ownership; known departure with unknown-only cycle; duplicate stable IDs
with different support; ≤25-mile boundary and reversed one-way association;
arrival root outside context; named holes and exact driving-band/drawn boundaries;
equal map/Full IDs independent of panning; owner-pinned restart after adding a
neighbor; incompatible unrelated versus contributing artifacts; unsupported old
job resumption with partial results intact; and a close match beyond an exact
stem-distance bound. Never borrow hints/edges from different owners.

Offline baseline verification: six existing suites, 63/63 passing (`eligible-access-points`,
`prepared-repository`, `reachable-graph-closed-route-solver`, `coverage/prune`,
`route-jobs/store`, `route-jobs/migration`). No new counterexample fixture was added.
Command: `npm test -- lib/solver/eligible-access-points.test.ts lib/graph/prepared-repository.test.ts lib/solver/reachable-graph-closed-route-solver.test.ts lib/coverage/prune.test.ts lib/route-jobs/store.test.ts lib/route-jobs/migration.test.ts`.
The temporary ignored dependency symlink was removed; `git diff --check` passes.
